/** Pluto catalog API access with a shared Workers KV cache. */

import { fetchText, type UpstreamConfig } from "./pluto";
import type { Env } from "./types";

interface MemoryEntry {
  expires: number;
  value: unknown;
}

// Isolate-local hot cache. KV is eventually consistent, so a fresh value is
// always kept here after a write to avoid serving stale data immediately.
const memoryCache = new Map<string, MemoryEntry>();

export function catalogCacheTtlMs(env: Env): number {
  const seconds = Number(env.CATALOG_CACHE_TTL_SECONDS ?? "900");
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 15 * 60 * 1000;
}

async function cachedJson<T>(
  env: Env,
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const memory = memoryCache.get(key);
  if (memory && memory.expires > now) return memory.value as T;

  const kvKey = `catalog:${key}`;
  try {
    const raw = await env.SUBS.get(kvKey);
    if (raw) {
      const value = JSON.parse(raw) as T;
      memoryCache.set(key, { expires: now + ttlMs, value });
      return value;
    }
  } catch (error) {
    console.warn("catalog cache read failed", error);
  }

  const value = await load();
  memoryCache.set(key, { expires: Date.now() + ttlMs, value });
  try {
    await env.SUBS.put(kvKey, JSON.stringify(value), {
      expirationTtl: Math.max(60, Math.ceil(ttlMs / 1000) + 60),
    });
  } catch (error) {
    console.warn("catalog cache write failed", error);
  }
  return value;
}

function parseJson(body: string, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(body) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("unexpected shape");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`could not decode Pluto ${label} response`);
  }
}

/** Pluto's on-demand categories, with their items. */
export async function fetchCategories(
  env: Env,
  config: UpstreamConfig,
): Promise<Record<string, unknown>> {
  const ttl = catalogCacheTtlMs(env);
  const key = `categories:${config.country}`;
  const data = await cachedJson(env, key, ttl, async () => {
    const query = new URLSearchParams({
      includeItems: "true",
      deviceType: "web",
      country: config.country,
    });
    const endpoint = config.categoriesEndpoint?.trim() || "https://api.pluto.tv/v3/vod/categories";
    const separator = endpoint.includes("?") ? "&" : "?";
    const body = await fetchText(`${endpoint}${separator}${query.toString()}`, config, 45_000);
    return parseJson(body, "categories");
  });
  if (!Array.isArray(data.categories)) {
    throw new Error("Pluto categories response had an unexpected shape");
  }
  return data;
}

/** A series' seasons and episodes. */
export async function fetchSeriesSeasons(
  env: Env,
  config: UpstreamConfig,
  seriesId: string,
): Promise<Record<string, unknown>> {
  const ttl = catalogCacheTtlMs(env);
  const key = `series:${config.country}:${seriesId}`;
  return cachedJson(env, key, ttl, async () => {
    const query = new URLSearchParams({
      includeItems: "true",
      deviceType: "web",
      country: config.country,
    });
    const endpoint = (config.seriesEndpoint?.trim() || "https://api.pluto.tv/v3/vod/series/").replace(/\/+$/, "");
    const body = await fetchText(
      `${endpoint}/${encodeURIComponent(seriesId)}/seasons?${query.toString()}`,
      config,
      30_000,
    );
    return parseJson(body, "seasons");
  });
}
