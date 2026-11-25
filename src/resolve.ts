/**
 * Resolve Nuvio/Stremio general-search ids (TMDb or IMDb) to Pluto media ids.
 *
 * General-search titles arrive with ids such as `tmdb:597` or
 * `tt0100405:1:2`. Pluto has no TMDb/IMDb index, so the title/year (and episode
 * for series) is looked up on TMDb, then matched against Pluto's own search API
 * and VOD slug details. Successful matches are cached in Workers KV.
 */

import type { Json } from "./catalog";
import {
  bootSession,
  fetchTextWithHeaders,
  type BootSession,
  type UpstreamConfig,
} from "./pluto";
import type { Env } from "./types";

const TMDB_BASE = "https://api.themoviedb.org/3";
const SEARCH_FALLBACK = "https://service-media-search.clusters.pluto.tv";
const VOD_FALLBACK = "https://service-vod.clusters.pluto.tv";
const YEAR_RE = /(19|20)\d{2}/;
const MAX_SEARCH_CANDIDATES = 8;
const MAX_FALLBACK_SLUGS = 18;
const RESOLVE_TTL_SECONDS = 6 * 60 * 60;
const NEGATIVE_TTL_SECONDS = 10 * 60;

type StreamKind = "movie" | "series";
type IdSource = "tmdb" | "imdb";

export interface ParsedStreamId {
  kind: StreamKind;
  source: IdSource;
  id: string;
  season: number | null;
  episode: number | null;
}

interface TitleInfo {
  kind: StreamKind;
  title: string;
  originalTitle: string;
  year: number | null;
  alts: string[];
}

interface ResolveCacheEntry {
  expires: number;
  value: string;
}

const resolveCache = new Map<string, ResolveCacheEntry>();

function asMap(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function asSlice(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function uniqueStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeTitle(value: unknown): string {
  return asString(value)
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function slugVariants(title: string): string[] {
  const cleaned = title.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ").trim();
  const out = [slugify(cleaned)];
  if (cleaned.includes("&")) out.push(slugify(cleaned.replace(/&/g, " ")));
  if (/['’`]/.test(cleaned)) out.push(slugify(cleaned.replace(/['’`]/g, "-")));
  return uniqueStrings(out);
}

function yearFromValue(value: unknown): number | null {
  const match = YEAR_RE.exec(asString(value));
  return match ? Number(match[0]) : null;
}

function itemYear(item: Json): number | null {
  const clip = asMap(item.clip);
  const direct = clip ? yearFromValue(clip.originalReleaseDate) : null;
  if (direct) return direct;
  const release = yearFromValue(item.releaseDate);
  if (release) return release;
  const parts = asString(item.slug).split("-");
  for (let index = parts.length - 1; index >= 0; index--) {
    if (/^(19|20)\d{2}$/.test(parts[index]!)) return Number(parts[index]);
  }
  return null;
}

function seriesStartYear(item: Json): number | null {
  let earliest: number | null = null;
  for (const rawSeason of asSlice(item.seasons)) {
    const season = asMap(rawSeason);
    if (!season) continue;
    for (const rawEpisode of asSlice(season.episodes)) {
      const episode = asMap(rawEpisode);
      if (!episode) continue;
      const clip = asMap(episode.clip);
      const year = clip ? yearFromValue(clip.originalReleaseDate) : null;
      if (year && (earliest === null || year < earliest)) earliest = year;
    }
  }
  return earliest;
}

function findEpisode(
  item: Json,
  seasonNumber: number | null,
  episodeNumber: number,
): Json | null {
  const seasons: Json[] = [];
  for (const rawSeason of asSlice(item.seasons)) {
    const season = asMap(rawSeason);
    if (season) seasons.push(season);
  }
  seasons.sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));

  if (seasonNumber === null) {
    const all: Json[] = [];
    for (const season of seasons) {
      for (const rawEpisode of asSlice(season.episodes)) {
        const episode = asMap(rawEpisode);
        if (episode) all.push(episode);
      }
    }
    return episodeNumber >= 1 && episodeNumber <= all.length ? all[episodeNumber - 1]! : null;
  }

  const season = seasons.find((entry) => Number(entry.number) === seasonNumber);
  if (!season) return null;
  const episodes: Json[] = [];
  for (const rawEpisode of asSlice(season.episodes)) {
    const episode = asMap(rawEpisode);
    if (episode) episodes.push(episode);
  }
  const exact = episodes.find((entry) => Number(entry.number) === episodeNumber);
  if (exact) return exact;
  return episodeNumber >= 1 && episodeNumber <= episodes.length
    ? episodes[episodeNumber - 1]!
    : null;
}

function scoreName(name: string, info: TitleInfo): number {
  const normalized = normalizeTitle(name);
  if (!normalized) return 0;
  const targets = uniqueStrings([info.title, info.originalTitle, ...info.alts])
    .map(normalizeTitle)
    .filter(Boolean);
  let best = 0;
  for (const target of targets) {
    if (normalized === target) return 100;
    if (normalized.includes(target) || target.includes(normalized)) {
      const diff = Math.abs(normalized.length - target.length);
      if (diff <= 3) best = Math.max(best, 80);
      else if (diff <= 8) best = Math.max(best, 60);
    }
  }
  return best;
}

function scoreRow(row: Json, info: TitleInfo): number {
  const type = asString(row.type);
  if (info.kind === "movie" && type !== "movie") return -1;
  if (info.kind === "series" && type !== "series") return -1;

  let score = scoreName(asString(row.name), info);
  if (!score) return -1;
  if (info.year) {
    const year = itemYear(row);
    if (year) {
      const diff = Math.abs(year - info.year);
      if (diff === 0) score += 10;
      else if (diff === 1) score += 5;
      else if (diff <= 3) score -= 5;
      else score -= 15;
    }
  }
  return score;
}

function scoreItem(
  item: Json,
  info: TitleInfo,
  season: number | null,
  episode: number | null,
): { score: number; episode: Json | null } | null {
  if (!asString(item._id)) return null;
  const type = asString(item.type);
  if (info.kind === "movie" && type !== "movie") return null;
  if (info.kind === "series" && type !== "series") return null;

  let score = scoreName(asString(item.name), info);
  if (!score) return null;

  let matchedEpisode: Json | null = null;
  if (info.kind === "movie") {
    if (info.year) {
      const year = itemYear(item);
      if (year) {
        const diff = Math.abs(year - info.year);
        if (diff === 0) score += 10;
        else if (diff === 1) score += 5;
        else return null;
      }
    }
  } else {
    if (episode === null) return null;
    matchedEpisode = findEpisode(item, season, episode);
    if (!matchedEpisode) return null;
    score += 20;
    if (info.year) {
      const year = seriesStartYear(item);
      if (year) {
        const diff = Math.abs(year - info.year);
        if (diff === 0) score += 10;
        else if (diff === 1) score += 5;
      }
    }
  }
  return { score, episode: matchedEpisode };
}

function pickBest(
  items: readonly Json[],
  info: TitleInfo,
  season: number | null,
  episode: number | null,
): { item: Json; episode: Json | null } | null {
  let best: Json | null = null;
  let bestEpisode: Json | null = null;
  let bestScore = -1;
  for (const item of items) {
    const scored = scoreItem(item, info, season, episode);
    if (!scored || scored.score <= bestScore) continue;
    best = item;
    bestEpisode = scored.episode;
    bestScore = scored.score;
  }
  return best && bestScore >= 80 ? { item: best, episode: bestEpisode } : null;
}

function searchCandidates(rows: readonly Json[], info: TitleInfo): Json[] {
  const scored: Array<{ row: Json; score: number }> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const slug = asString(row.slug);
    if (!slug || seen.has(slug)) continue;
    const score = scoreRow(row, info);
    if (score < 60) continue;
    seen.add(slug);
    scored.push({ row, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_SEARCH_CANDIDATES).map((entry) => entry.row);
}

function fallbackSlugs(info: TitleInfo): string[] {
  const titles = uniqueStrings([info.title, info.originalTitle, ...info.alts]).slice(0, 2);
  const out: string[] = [];
  for (const title of titles) {
    for (const base of slugVariants(title)) {
      if (info.kind === "movie") {
        if (!info.year) continue;
        for (const year of [info.year, info.year - 1, info.year + 1]) {
          out.push(`${base}-${year}-1-1`, `${base}-${year}-${year}-1-1`);
        }
      } else {
        out.push(base);
        for (let number = 1; number <= 12; number++) out.push(`${base}-ptv${number}`);
      }
    }
  }
  return uniqueStrings(out).slice(0, MAX_FALLBACK_SLUGS);
}

async function searchPluto(
  config: UpstreamConfig,
  boot: BootSession,
  query: string,
): Promise<Json[]> {
  const base = (boot.search?.trim() || SEARCH_FALLBACK).replace(/\/+$/, "");
  const url = `${base}/v1/search?q=${encodeURIComponent(query)}`;
  const body = await fetchTextWithHeaders(
    url,
    config,
    { Authorization: `Bearer ${boot.token}` },
    15_000,
  );
  const data = asMap(JSON.parse(body) as unknown);
  return asSlice(data?.data).filter((row): row is Json => asMap(row) !== null);
}

async function fetchSlugs(
  config: UpstreamConfig,
  boot: BootSession,
  slugs: readonly string[],
): Promise<Json[]> {
  if (slugs.length === 0) return [];
  const base = (boot.vod?.trim() || VOD_FALLBACK).replace(/\/+$/, "");
  const url = `${base}/v4/vod/slugs?slugs=${slugs.map(encodeURIComponent).join(",")}`;
  const body = await fetchTextWithHeaders(
    url,
    config,
    { Authorization: `Bearer ${boot.token}` },
    20_000,
  );
  const data = JSON.parse(body) as unknown;
  return Array.isArray(data) ? data.filter((item): item is Json => asMap(item) !== null) : [];
}

async function matchPluto(
  config: UpstreamConfig,
  boot: BootSession,
  info: TitleInfo,
  season: number | null,
  episode: number | null,
): Promise<{ item: Json; episode: Json | null } | null> {
  const queries = uniqueStrings([info.title, info.originalTitle, ...info.alts.slice(0, 2)]);
  if (queries.length === 0) return null;
  const lists = await Promise.all(
    queries.map((query) =>
      searchPluto(config, boot, query).catch((error) => {
        console.warn("Pluto search failed", { query, error: String(error) });
        return [] as Json[];
      }),
    ),
  );
  const rows = lists.flat();
  const candidates = searchCandidates(rows, info);
  let items: Json[] = [];
  if (candidates.length > 0) {
    try {
      items = await fetchSlugs(
        config,
        boot,
        candidates.map((row) => asString(row.slug)),
      );
    } catch (error) {
      console.warn("Pluto slug lookup failed", { error: String(error) });
    }
  }
  const searchMatch = pickBest(items, info, season, episode);
  if (searchMatch) return searchMatch;

  const fallback = fallbackSlugs(info);
  if (fallback.length === 0) return null;
  try {
    const fallbackItems = await fetchSlugs(config, boot, fallback);
    return pickBest(fallbackItems, info, season, episode);
  } catch (error) {
    console.warn("Pluto fallback slug lookup failed", { error: String(error) });
    return null;
  }
}

function makeInfo(data: Json, kind: StreamKind): TitleInfo {
  const title = kind === "movie" ? asString(data.title) : asString(data.name);
  const original = kind === "movie" ? asString(data.original_title) : asString(data.original_name);
  const date = kind === "movie" ? data.release_date : data.first_air_date;
  const altBlock = asMap(data.alternative_titles);
  const altList = kind === "movie" ? asSlice(altBlock?.titles) : asSlice(altBlock?.results);
  const englishRegions = new Set(["US", "GB", "CA", "AU", "IE", "NZ", ""]);
  const alts: string[] = [];
  for (const raw of altList) {
    const entry = asMap(raw);
    const alt = asString(entry?.title);
    if (!alt) continue;
    if (!englishRegions.has(asString(entry?.iso_3166_1))) continue;
    alts.push(alt);
  }
  return {
    kind,
    title: title || original,
    originalTitle: original || title,
    year: yearFromValue(date),
    alts: uniqueStrings(alts),
  };
}

async function tmdbJson(
  path: string,
  apiKey: string,
  query: Record<string, string>,
): Promise<Json | null> {
  const bearer = apiKey.startsWith("eyJ");
  const params = new URLSearchParams(query);
  if (!bearer) params.set("api_key", apiKey);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (bearer) headers.Authorization = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${TMDB_BASE}${path}?${params.toString()}`, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn("TMDb lookup failed", { path, status: response.status });
      return null;
    }
    return asMap((await response.json()) as unknown);
  } catch (error) {
    console.warn("TMDb lookup failed", { path, error: String(error) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveTitleInfo(
  parsed: ParsedStreamId,
  apiKey: string,
): Promise<TitleInfo | null> {
  if (parsed.source === "imdb") {
    const data = await tmdbJson(`/find/${encodeURIComponent(parsed.id)}`, apiKey, {
      external_source: "imdb_id",
      language: "en-US",
    });
    if (!data) return null;
    const results = asSlice(parsed.kind === "movie" ? data.movie_results : data.tv_results);
    const first = asMap(results[0]);
    return first ? makeInfo(first, parsed.kind) : null;
  }

  const path = parsed.kind === "movie" ? "/movie/" : "/tv/";
  const data = await tmdbJson(`${path}${encodeURIComponent(parsed.id)}`, apiKey, {
    language: "en-US",
    append_to_response: "alternative_titles",
  });
  return data ? makeInfo(data, parsed.kind) : null;
}

function cacheKey(parsed: ParsedStreamId, config: UpstreamConfig): string {
  return [
    "resolve",
    parsed.kind,
    parsed.source,
    parsed.id,
    parsed.season ?? "x",
    parsed.episode ?? "x",
    config.country,
    config.xff || "none",
  ].join(":");
}

async function readResolveCache(env: Env, key: string): Promise<string | undefined> {
  const now = Date.now();
  const memory = resolveCache.get(key);
  if (memory && memory.expires > now) return memory.value;
  try {
    const raw = await env.SUBS.get(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { mediaId?: unknown; ttl?: unknown };
    if (typeof parsed.mediaId !== "string") return undefined;
    const ttl = typeof parsed.ttl === "number" && parsed.ttl > 0 ? parsed.ttl : RESOLVE_TTL_SECONDS;
    resolveCache.set(key, { expires: now + ttl * 1000, value: parsed.mediaId });
    return parsed.mediaId;
  } catch (error) {
    console.warn("resolve cache read failed", error);
    return undefined;
  }
}

async function writeResolveCache(
  env: Env,
  key: string,
  mediaId: string,
  ttlSeconds: number,
): Promise<void> {
  resolveCache.set(key, { expires: Date.now() + ttlSeconds * 1000, value: mediaId });
  try {
    await env.SUBS.put(key, JSON.stringify({ mediaId, ttl: ttlSeconds }), {
      expirationTtl: ttlSeconds,
    });
  } catch (error) {
    console.warn("resolve cache write failed", error);
  }
}

/**
 * Parse a Nuvio/Stremio id into a TMDb/IMDb id and optional episode coordinates.
 * Examples: `tmdb:597`, `tmdb:1399:1:2`, `tt0903747:1:2`,
 * `movie:597`, `series:1399:1:2`, `597`.
 */
export function parseGeneralStreamId(
  rawId: string,
  typeHint: string,
): ParsedStreamId | null {
  const raw = rawId.trim();
  if (!raw) return null;

  let kind: StreamKind | null =
    typeHint === "series" || typeHint === "tv"
      ? "series"
      : typeHint === "movie"
        ? "movie"
        : null;

  const parts = raw
    .replace(/\//g, ":")
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  let index = -1;
  for (let position = 0; position < parts.length; position++) {
    if (/^\d+$/.test(parts[position]!) || /^tt\d+$/i.test(parts[position]!)) {
      index = position;
      break;
    }
  }
  if (index < 0) return null;

  const before = parts.slice(0, index).map((part) => part.toLowerCase());
  const allowedPrefixes = new Set(["tmdb", "imdb", "movie", "series", "tv", "show", "tvshow"]);
  if (before.some((part) => !allowedPrefixes.has(part))) return null;

  if (!kind) {
    kind = before.some((part) => part === "series" || part === "tv" || part === "show")
      ? "series"
      : "movie";
  }

  const token = parts[index]!;
  const source: IdSource = /^tt\d+$/i.test(token) ? "imdb" : "tmdb";
  const id = source === "imdb" ? token.toLowerCase() : token;
  if (source === "tmdb" && !/^\d+$/.test(id)) return null;

  let season: number | null = null;
  let episode: number | null = null;
  if (kind === "series") {
    const rest = parts.slice(index + 1);
    if (rest.length >= 2) {
      const seasonValue = Number(rest[rest.length - 2]);
      const episodeValue = Number(rest[rest.length - 1]);
      if (Number.isInteger(seasonValue) && Number.isInteger(episodeValue)) {
        season = seasonValue;
        episode = episodeValue;
      }
    }
  }

  return { kind, source, id, season, episode };
}

/** Resolve a general-search id to the Pluto media id used by the stream endpoint. */
export async function resolvePlutoMediaId(
  env: Env,
  config: UpstreamConfig,
  rawId: string,
  typeHint: string,
): Promise<string> {
  const parsed = parseGeneralStreamId(rawId, typeHint);
  if (!parsed) return "";
  if (parsed.kind === "series" && (parsed.season === null || parsed.episode === null)) {
    return "";
  }

  const apiKey = env.TMDB_API_KEY?.trim() ?? "";
  if (!apiKey) {
    console.warn("TMDB_API_KEY is not configured; cannot resolve", rawId);
    return "";
  }

  const key = cacheKey(parsed, config);
  const cached = await readResolveCache(env, key);
  if (cached !== undefined) return cached;

  const [info, boot] = await Promise.all([
    resolveTitleInfo(parsed, apiKey),
    bootSession(config).catch((error) => {
      console.warn("Pluto boot failed during resolve", String(error));
      return null;
    }),
  ]);
  if (!info || !boot) return "";

  const match = await matchPluto(config, boot, info, parsed.season, parsed.episode);
  const mediaId = match
    ? parsed.kind === "movie"
      ? asString(match.item._id)
      : asString(match.episode?._id)
    : "";
  await writeResolveCache(
    env,
    key,
    mediaId,
    mediaId ? RESOLVE_TTL_SECONDS : NEGATIVE_TTL_SECONDS,
  );
  return mediaId;
}
