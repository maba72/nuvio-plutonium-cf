/** Optional TMDb cast enrichment (adds profile photos to /meta responses). */

import type { Json } from "./catalog";

const TMDB_BASE = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p/w200";

interface SearchResult {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  popularity?: number;
}

interface CreditPerson {
  name?: string;
  profile_path?: string;
  character?: string;
  known_for_department?: string;
}

const cache = new Map<string, Array<{ name: string; poster?: string; role?: string }>>();

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`TMDb HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function findId(
  apiKey: string,
  title: string,
  year: string,
): Promise<{ id: number; type: "movie" | "tv" } | null> {
  const params = new URLSearchParams({ api_key: apiKey, query: title, include_adult: "false" });
  const data = (await getJson(`${TMDB_BASE}/search/multi?${params.toString()}`)) as {
    results?: SearchResult[];
  };
  let best: { id: number; type: "movie" | "tv" } | null = null;
  let bestPopularity = -1;
  for (const result of Array.isArray(data.results) ? data.results : []) {
    if (result.media_type !== "movie" && result.media_type !== "tv") continue;
    const date = result.media_type === "tv" ? result.first_air_date : result.release_date;
    if (year && date && !date.startsWith(year)) continue;
    if ((result.popularity ?? 0) > bestPopularity) {
      bestPopularity = result.popularity ?? 0;
      best = { id: result.id, type: result.media_type };
    }
  }
  return best;
}

async function fetchCast(
  apiKey: string,
  id: number,
  type: "movie" | "tv",
): Promise<Array<{ name: string; poster?: string; role?: string }>> {
  const params = new URLSearchParams({ api_key: apiKey });
  const path = type === "tv" ? `/tv/${id}/credits` : `/movie/${id}/credits`;
  const data = (await getJson(`${TMDB_BASE}${path}?${params.toString()}`)) as {
    cast?: CreditPerson[];
  };
  const out: Array<{ name: string; poster?: string; role?: string }> = [];
  for (const person of Array.isArray(data.cast) ? data.cast : []) {
    if (person.known_for_department !== "Acting" || !person.name) continue;
    const entry: { name: string; poster?: string; role?: string } = { name: person.name };
    if (person.profile_path) entry.poster = `${IMAGE_BASE}${person.profile_path}`;
    if (person.character) entry.role = person.character;
    out.push(entry);
  }
  return out;
}

/** Replace string-only cast with TMDb objects that include profile photos. */
export async function enrichCast(meta: Json, apiKey: string): Promise<boolean> {
  const name = typeof meta.name === "string" ? meta.name : "";
  if (!name) return false;
  const year = typeof meta.releaseInfo === "string" ? meta.releaseInfo : "";
  const key = `${name}|${year}`;
  let cast = cache.get(key);
  if (!cast) {
    try {
      const found = await findId(apiKey, name, year);
      if (!found) return false;
      cast = await fetchCast(apiKey, found.id, found.type);
      cache.set(key, cast);
    } catch (error) {
      console.warn("TMDb enrichment failed", error);
      return false;
    }
  }
  if (cast.length === 0) return false;
  meta.cast = cast;
  return true;
}
