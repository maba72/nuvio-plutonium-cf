/** Pluto TV HTTP client, boot/stitcher URL building, and upstream allowlisting. */

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const BOOT_ENDPOINT = "https://boot.pluto.tv/v4/start";
const CATEGORIES_ENDPOINT = "https://api.pluto.tv/v3/vod/categories";
const SERIES_ENDPOINT = "https://api.pluto.tv/v3/vod/series/";

export interface UpstreamConfig {
  xff: string;
  country: string;
  userAgent: string;
  extraAllowedHosts: string[];
  allowAnyUpstream: boolean;
  allowPrivateUpstream: boolean;
  bootEndpoint: string;
  categoriesEndpoint: string;
  seriesEndpoint: string;
}

export class UpstreamError extends Error {
  readonly status: number;
  readonly url: string;
  readonly retryable: boolean;

  constructor(status: number, url: string, body: string) {
    const snippet = body.trim().slice(0, 240);
    super(snippet ? `upstream HTTP ${status}: ${snippet}` : `upstream HTTP ${status}`);
    this.name = "UpstreamError";
    this.status = status;
    this.url = url;
    this.retryable = status === 429 || status >= 500;
  }
}

export interface BootSession {
  token: string;
  stitcher: string;
  stitcherParams: string;
  /** Services advertised by Pluto's boot response. */
  search?: string;
  vod?: string;
}

interface BootCacheEntry {
  expires: number;
  boot: BootSession;
}

const bootCache = new Map<string, BootCacheEntry>();
const BOOT_TTL_MS = 5 * 60 * 1000;

/**
 * Only allow Pluto hosts (plus explicitly configured extras) by default. This
 * prevents the Worker from being used as an open proxy or SSRF gadget.
 */
export function isAllowedUpstream(
  rawURL: string,
  extraAllowedHosts: readonly string[] = [],
  allowAny = false,
  allowPrivate = false,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawURL);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (isPrivateHost(host)) return allowPrivate;

  if (isPlutoHost(host)) return true;

  for (const pattern of extraAllowedHosts) {
    const entry = pattern.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1); // ".example.com"
      if (host === entry.slice(2) || host.endsWith(suffix)) return true;
    } else if (entry.startsWith(".")) {
      if (host === entry.slice(1) || host.endsWith(entry)) return true;
    } else if (host === entry) {
      return true;
    }
  }

  return allowAny;
}

function isPlutoHost(host: string): boolean {
  return (
    host === "pluto.tv" ||
    host.endsWith(".pluto.tv") ||
    host === "plutotv.net" ||
    host.endsWith(".plutotv.net")
  );
}

function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.includes(":")) {
    // IPv6 literal (URL.hostname keeps brackets off).
    const lower = host.toLowerCase();
    return (
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80")
    );
  }
  return isPrivateIPv4(host);
}

function isPrivateIPv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1).map((part) => Number(part));
  if (octets.some((part) => part > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

export function fetchText(
  rawURL: string,
  config: UpstreamConfig,
  timeoutMs = 25_000,
  attempts = 1,
): Promise<string> {
  return fetchTextInternal(rawURL, config, timeoutMs, attempts);
}

/** Like fetchText, but adds headers such as Pluto's bearer token. */
export function fetchTextWithHeaders(
  rawURL: string,
  config: UpstreamConfig,
  extraHeaders: Record<string, string>,
  timeoutMs = 25_000,
  attempts = 1,
): Promise<string> {
  return fetchTextInternal(rawURL, config, timeoutMs, attempts, extraHeaders);
}

async function fetchTextInternal(
  rawURL: string,
  config: UpstreamConfig,
  timeoutMs: number,
  attempts: number,
  extraHeaders?: Record<string, string>,
): Promise<string> {
  if (
    !isAllowedUpstream(
      rawURL,
      config.extraAllowedHosts,
      config.allowAnyUpstream,
      config.allowPrivateUpstream,
    )
  ) {
    throw new Error(`upstream host is not allowed: ${safeHost(rawURL)}`);
  }

  let lastError: unknown;
  const tries = Math.max(1, attempts);
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fetchOnce(rawURL, config, timeoutMs, extraHeaders);
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof UpstreamError ? error.retryable : true; // network/timeout
      if (!retryable || attempt >= tries - 1) break;
      await sleep(250 * (attempt + 1));
    }
  }
  throw lastError;
}

async function fetchOnce(
  rawURL: string,
  config: UpstreamConfig,
  timeoutMs: number,
  extraHeaders?: Record<string, string>,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const headers = new Headers({
      "User-Agent": config.userAgent || DEFAULT_USER_AGENT,
      Accept: "*/*",
    });
    if (config.xff) headers.set("X-Forwarded-For", config.xff);
    for (const [name, value] of Object.entries(extraHeaders ?? {})) {
      if (value) headers.set(name, value);
    }

    const response = await fetch(rawURL, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      let body = "";
      try {
        body = (await response.text()).slice(0, 2048);
      } catch {
        // Ignore body read errors.
      }
      throw new UpstreamError(response.status, rawURL, body);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function bootSession(
  config: UpstreamConfig,
  force = false,
): Promise<BootSession> {
  const key = `${config.country}|${config.xff}`;
  const cached = bootCache.get(key);
  if (!force && cached && cached.expires > Date.now()) return cached.boot;

  const params = new URLSearchParams({
    appName: "web",
    appVersion: "1",
    deviceVersion: "0.0.0",
    deviceModel: "web",
    deviceMake: "firefox",
    deviceType: "web",
    clientID: newUUID(),
    clientModelNumber: "1.0.0",
    serverSideAds: "false",
    country: config.country,
  });

  const bootEndpoint = config.bootEndpoint?.trim() || BOOT_ENDPOINT;
  const body = await fetchText(`${bootEndpoint}?${params.toString()}`, config, 30_000);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new Error("could not decode Pluto boot response");
  }

  const token = typeof data.sessionToken === "string" ? data.sessionToken : "";
  if (!token) throw new Error("Pluto boot response had no session token");

  const servers =
    data.servers && typeof data.servers === "object"
      ? (data.servers as Record<string, unknown>)
      : {};
  const stitcher = typeof servers.stitcher === "string" ? servers.stitcher : "";
  if (!stitcher) throw new Error("Pluto boot response had no stitcher");

  const stitcherParams =
    typeof data.stitcherParams === "string" ? data.stitcherParams.replace(/^[?&]+|[?&]+$/g, "") : "";
  const search = typeof servers.search === "string" ? servers.search : "";
  const vod = typeof servers.vod === "string" ? servers.vod : "";

  const boot: BootSession = { token, stitcher, stitcherParams, search, vod };
  bootCache.set(key, { expires: Date.now() + BOOT_TTL_MS, boot });
  return boot;
}

/** Build the raw Pluto stitcher master URL for a movie or episode ID. */
export function buildMasterUrl(boot: BootSession, mediaId: string): string {
  const host = stitcherHost(boot.stitcher);
  if (!host) throw new Error("Pluto stitcher host was empty");

  // Production stitcher URLs are HTTPS. Keep the scheme when Pluto (or a local
  // test boot response) supplies one, so the URL stays reachable in both cases.
  let scheme = "https";
  try {
    const parsed = new URL(boot.stitcher.trim());
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      scheme = parsed.protocol.slice(0, -1);
    }
  } catch {
    // Bare host: default to HTTPS.
  }

  const query = new URLSearchParams(boot.stitcherParams);
  query.set("jwt", boot.token);
  query.set("masterJWTPassthrough", "1");

  return `${scheme}://${host}/v2/stitch/hls/episode/${encodeURIComponent(mediaId)}/master.m3u8?${query.toString()}`;
}

export async function masterUrlForMedia(mediaId: string, config: UpstreamConfig): Promise<string> {
  const boot = await bootSession(config);
  return buildMasterUrl(boot, mediaId);
}

function stitcherHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if (parsed.host) return parsed.host;
  } catch {
    // stitcher may be a bare host.
  }
  return trimmed.replace(/^\/+|\/+$/g, "");
}

function newUUID(): string {
  return crypto.randomUUID();
}

function safeHost(rawURL: string): string {
  try {
    return new URL(rawURL).host;
  } catch {
    return rawURL;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build the upstream config from Worker env vars and a resolved XFF. */
export function upstreamConfig(
  env: {
    PLUTO_XFF?: string;
    PLUTO_COUNTRY?: string;
    PLUTO_USER_AGENT?: string;
    ALLOWED_UPSTREAM_HOSTS?: string;
    ALLOW_ANY_UPSTREAM?: string;
    ALLOW_PRIVATE_UPSTREAM?: string;
    PLUTO_BOOT_URL?: string;
    PLUTO_CATEGORIES_URL?: string;
    PLUTO_SERIES_URL?: string;
  },
  xff: string,
  country?: string,
): UpstreamConfig {
  return {
    xff: xff || env.PLUTO_XFF?.trim() || "",
    country: (country || env.PLUTO_COUNTRY || "US").trim().toUpperCase() || "US",
    userAgent: env.PLUTO_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
    extraAllowedHosts: (env.ALLOWED_UPSTREAM_HOSTS || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    allowAnyUpstream: String(env.ALLOW_ANY_UPSTREAM || "").toLowerCase() === "true",
    allowPrivateUpstream:
      String(env.ALLOW_PRIVATE_UPSTREAM || "").toLowerCase() === "true",
    bootEndpoint: env.PLUTO_BOOT_URL?.trim() || BOOT_ENDPOINT,
    categoriesEndpoint: env.PLUTO_CATEGORIES_URL?.trim() || CATEGORIES_ENDPOINT,
    seriesEndpoint: env.PLUTO_SERIES_URL?.trim() || SERIES_ENDPOINT,
  };
}
