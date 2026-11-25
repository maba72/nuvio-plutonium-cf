/** Stremio/Nuvio addon endpoints: manifest, catalogs, metadata, search, streams. */

import {
  catalogItem,
  findCategory,
  findItem,
  metaForItem,
  searchItems,
  seriesMeta,
  streamMediaId,
  type Json,
} from "./catalog";
import { fetchCategories, fetchSeriesSeasons } from "./pluto-catalog";
import { isAllowedUpstream, masterUrlForMedia, upstreamConfig } from "./pluto";
import { resolvePlutoMediaId } from "./resolve";
import { createHlsSession } from "./session";
import { enrichCast } from "./tmdb";
import type { Env } from "./types";
import { errorResponse, jsonResponse, publicBase, resolveXff } from "./util";

export const ADDON_VERSION = "0.4.0";

export interface CatalogRow {
  id: string;
  name: string;
  category: string;
  type: "movie" | "series";
}

/** Stable row ids preserve the Nuvio home rows from the original addon. */
export const CATALOG_ROWS: readonly CatalogRow[] = [
  { id: "pluto-movies", name: "Pluto Movies", category: "Most Popular Movies", type: "movie" },
  { id: "pluto-series", name: "Pluto TV Series", category: "Top TV Series", type: "series" },
  { id: "pluto-top-movies", name: "Top Movies on Pluto", category: "Top Titles", type: "movie" },
  { id: "pluto-top-series", name: "Top Series on Pluto", category: "Top Titles", type: "series" },
  { id: "pluto-new-movies", name: "New Movies on Pluto", category: "New Movies This Month", type: "movie" },
  { id: "pluto-leaving-movies", name: "Leaving Pluto Soon", category: "Leaving Soon", type: "movie" },
  { id: "pluto-leaving-series", name: "Leaving Pluto Soon (TV)", category: "Leaving Soon", type: "series" },
];

export function addonManifest(version = ADDON_VERSION): Json {
  return {
    id: "org.maba.pluto-catalog",
    version,
    name: "Pluto TV Catalog",
    description:
      "Browse Pluto TV's free on-demand movies and series in Nuvio. " +
      "Playback uses an ad-free HLS timeline with Pluto's captions retimed to match it.",
    types: ["movie", "series"],
    resources: [
      { name: "catalog", types: ["movie", "series"] },
      { name: "meta", types: ["movie", "series"], idPrefixes: ["pluto:"] },
      // No idPrefixes: Nuvio also asks this addon for TMDb/IMDb ids from its
      // general search. Those are resolved to Pluto media ids in handleStream.
      { name: "stream", types: ["movie", "series"] },
    ],
    catalogs: CATALOG_ROWS.map((row) => ({ type: row.type, id: row.id, name: row.name })),
  };
}

/**
 * Handle an addon route. Returns null when the path is not an addon endpoint,
 * letting the Worker router fall through to its other routes.
 */
export async function handleAddonRequest(
  request: Request,
  env: Env,
  url: URL,
  path: string,
): Promise<Response | null> {
  const parts = path.split("/").filter(Boolean);
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  if (parts.length === 1 && parts[0] === "manifest.json") {
    return jsonResponse(addonManifest());
  }
  if (parts[0] === "search") return handleSearch(request, env, url);
  if (parts[0] === "catalog") return handleCatalog(request, env, url, parts);
  if (parts[0] === "meta") return handleMeta(request, env, url, parts);
  if (parts[0] === "stream") return handleStream(request, env, url, parts);
  return null;
}

function configFor(request: Request, env: Env, url: URL) {
  const xff = resolveXff(request, url, env.PLUTO_XFF?.trim() ?? "");
  const country = (url.searchParams.get("country") ?? "").trim();
  return upstreamConfig(env, xff, country || undefined);
}

function normalizeType(raw: string | undefined): "movie" | "series" | null {
  const value = (raw ?? "").toLowerCase();
  if (value === "movie") return "movie";
  if (value === "series" || value === "tv") return "series";
  return null;
}

function decodeId(raw: string | undefined): string {
  let id = raw ?? "";
  if (id.endsWith(".json")) id = id.slice(0, -5);
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

async function handleSearch(request: Request, env: Env, url: URL): Promise<Response> {
  const query = (url.searchParams.get("q") ?? "").trim();
  if (!query) return jsonResponse({ metas: [] });
  const data = await fetchCategories(env, configFor(request, env, url));
  return jsonResponse({ metas: searchItems(data, query, 80) });
}

async function handleCatalog(
  request: Request,
  env: Env,
  url: URL,
  parts: string[],
): Promise<Response> {
  const type = normalizeType(parts[1]);
  const rowId = decodeId(parts[2]);
  const row = type ? CATALOG_ROWS.find((entry) => entry.id === rowId && entry.type === type) : undefined;
  if (!row || !type) return jsonResponse({ metas: [] });

  const data = await fetchCategories(env, configFor(request, env, url));
  const metas: Json[] = [];
  const seen = new Set<string>();
  for (const item of findCategory(data, row.category)) {
    const itemType = typeof item.type === "string" ? item.type : "";
    if (itemType !== type) continue;
    const meta = catalogItem(item, type);
    if (!meta) continue;
    const id = typeof meta.id === "string" ? meta.id : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    metas.push(meta);
  }
  return jsonResponse({ metas });
}

async function handleMeta(
  request: Request,
  env: Env,
  url: URL,
  parts: string[],
): Promise<Response> {
  const type = normalizeType(parts[1]);
  if (!type) return errorResponse(404, "unsupported type");

  const rawId = decodeId(parts[2]);
  const prefix = type === "series" ? "pluto:series:" : "pluto:movie:";
  if (!rawId.startsWith(prefix) || rawId.length <= prefix.length) {
    return errorResponse(404, "unsupported id");
  }
  const plutoId = rawId.slice(prefix.length);
  const config = configFor(request, env, url);
  const data = await fetchCategories(env, config);
  const item = findItem(data, plutoId);
  if (!item) return errorResponse(404, "item not found");

  let meta: Json;
  if (type === "series") {
    const seasons = await fetchSeriesSeasons(env, config, plutoId);
    meta = seriesMeta(item, seasons);
  } else {
    meta = metaForItem(item, type);
  }

  const apiKey = env.TMDB_API_KEY?.trim();
  if (apiKey) await enrichCast(meta, apiKey);
  return jsonResponse({ meta });
}

async function handleStream(
  request: Request,
  env: Env,
  url: URL,
  parts: string[],
): Promise<Response> {
  const type = normalizeType(parts[1]);
  if (!type) return jsonResponse({ streams: [] });

  const rawId = decodeId(parts[2]);
  const config = configFor(request, env, url);
  let mediaId = streamMediaId(rawId);
  if (!mediaId) {
    // A Pluto series id without an episode is not playable on its own.
    if (rawId.toLowerCase().startsWith("pluto:")) return jsonResponse({ streams: [] });
    mediaId = await resolvePlutoMediaId(env, config, rawId, type);
  }
  if (!mediaId) return jsonResponse({ streams: [] });

  const masterUrl = await masterUrlForMedia(mediaId, config);
  if (
    !isAllowedUpstream(
      masterUrl,
      config.extraAllowedHosts,
      config.allowAnyUpstream,
      config.allowPrivateUpstream,
    )
  ) {
    return errorResponse(400, "master URL host is not allowed");
  }

  const id = await createHlsSession(env, {
    masterUrl,
    mediaId,
    xff: config.xff,
    country: config.country,
  });
  const headers: Record<string, string> = { "User-Agent": config.userAgent };
  if (config.xff) headers["X-Forwarded-For"] = config.xff;
  const stream: Json = {
    name: "Pluto TV",
    title: "Pluto TV • Ad-free",
    url: `${publicBase(request, env)}/hls/${id}/master.m3u8`,
    type: "hls",
    behaviorHints: { proxyHeaders: { request: headers } },
  };
  return jsonResponse({ streams: [stream] });
}
