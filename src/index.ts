import { handleAddonRequest } from "./addon";
import { absolutize, stripAds } from "./hls/cleaner";
import {
  isAllowedUpstream,
  masterUrlForMedia,
  upstreamConfig,
  fetchText,
} from "./pluto";
import { createHlsSession } from "./session";
import type { Env } from "./types";
import {
  CORS_HEADERS,
  errorResponse,
  jsonResponse,
  publicBase,
  resolveXff,
  sha256Hex,
  textResponse,
} from "./util";
import { errorMessage } from "./util";

export { SessionDurableObject } from "./session-do";

const SESSION_ID_RE = /^[a-f0-9]{32}$/;

interface CreateSessionBody {
  mediaId?: string;
  masterUrl?: string;
  country?: string;
  xff?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (path === "/" && request.method === "GET") {
        return landingPage();
      }
      if (path === "/health" && request.method === "GET") {
        return jsonResponse({ ok: true, service: "nuvio-plutonium-cf" });
      }
      // Stremio/Nuvio addon: manifest, catalogs, meta, search and streams.
      const addonResponse = await handleAddonRequest(request, env, url, path);
      if (addonResponse) return addonResponse;
      if (path === "/session" && (request.method === "POST" || request.method === "GET")) {
        return await createSession(request, env, url);
      }
      if (path === "/master.m3u8" && (request.method === "GET" || request.method === "HEAD")) {
        return await handleMasterCompat(request, env, url);
      }
      if (path === "/variant.m3u8" && (request.method === "GET" || request.method === "HEAD")) {
        return await handleVariantCompat(request, env, url);
      }
      if (path.startsWith("/hls/") && (request.method === "GET" || request.method === "HEAD")) {
        return await handleSessionPath(request, env, path);
      }
      return errorResponse(404, "not found");
    } catch (error) {
      console.error("worker request failed", error);
      return errorResponse(502, errorMessage(error));
    }
  },
};

async function createSession(request: Request, env: Env, url: URL): Promise<Response> {
  let body: CreateSessionBody = {};
  if (request.method === "POST") {
    const contentType = request.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/json") || contentType === "") {
      try {
        body = (await request.json()) as CreateSessionBody;
      } catch {
        return errorResponse(400, "invalid JSON body");
      }
    }
  }

  const mediaId = String(body.mediaId ?? url.searchParams.get("mediaId") ?? "").trim();
  const requestedMasterUrl = String(
    body.masterUrl ?? url.searchParams.get("masterUrl") ?? url.searchParams.get("url") ?? "",
  ).trim();
  const country = String(
    body.country ?? url.searchParams.get("country") ?? env.PLUTO_COUNTRY ?? "US",
  )
    .trim()
    .toUpperCase();
  const xff = resolveXff(request, url, env.PLUTO_XFF?.trim() ?? "");

  if (!mediaId && !requestedMasterUrl) {
    return errorResponse(400, "mediaId or masterUrl is required");
  }

  const config = upstreamConfig(env, xff, country);
  let masterUrl = requestedMasterUrl;
  if (!masterUrl) {
    masterUrl = await masterUrlForMedia(mediaId, config);
  }
  if (!isAllowedUpstream(masterUrl, config.extraAllowedHosts, config.allowAnyUpstream, config.allowPrivateUpstream)) {
    return errorResponse(400, "master URL host is not allowed");
  }

  const id = await createHlsSession(env, {
    masterUrl,
    mediaId,
    xff: config.xff,
    country: config.country,
  });

  const base = publicBase(request, env);
  return jsonResponse({
    id,
    url: `${base}/hls/${id}/master.m3u8`,
    masterUrl: `${base}/hls/${id}/master.m3u8`,
    subtitlesUrl: `${base}/hls/${id}/subs.m3u8`,
    vttUrl: `${base}/hls/${id}/subs.vtt`,
  });
}

/**
 * Python-proxy-compatible entry point:
 *   /master.m3u8?url=<encoded Pluto master URL>
 *
 * The returned master points at /hls/<session>/v/<n>.m3u8 and
 * /hls/<session>/subs.m3u8, so it is a stable drop-in for the old proxy.
 */
async function handleMasterCompat(request: Request, env: Env, url: URL): Promise<Response> {
  const upstream = (url.searchParams.get("url") ?? "").trim();
  if (!upstream) return errorResponse(400, "url is required");

  const xff = resolveXff(request, url, env.PLUTO_XFF?.trim() ?? "");
  const country = (url.searchParams.get("country") ?? env.PLUTO_COUNTRY ?? "US")
    .trim()
    .toUpperCase();
  const config = upstreamConfig(env, xff, country);
  if (!isAllowedUpstream(upstream, config.extraAllowedHosts, config.allowAnyUpstream, config.allowPrivateUpstream)) {
    return errorResponse(400, "master URL host is not allowed");
  }

  const id = (await sha256Hex(`master|${upstream}|${config.xff}`)).slice(0, 32);
  await createHlsSession(
    env,
    {
      masterUrl: upstream,
      mediaId: "",
      xff: config.xff,
      country: config.country,
    },
    id,
  );

  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(id));
  const response = await stub.fetch(
    new Request(`https://session/master.m3u8?prefix=${encodeURIComponent(`/hls/${id}/`)}`),
  );
  return withCors(response);
}

/** Python-proxy-compatible variant endpoint. Streams stay on Pluto's CDN. */
async function handleVariantCompat(request: Request, env: Env, url: URL): Promise<Response> {
  const upstream = (url.searchParams.get("url") ?? "").trim();
  if (!upstream) return errorResponse(400, "url is required");

  const xff = resolveXff(request, url, env.PLUTO_XFF?.trim() ?? "");
  const config = upstreamConfig(env, xff, env.PLUTO_COUNTRY ?? "US");
  if (!isAllowedUpstream(upstream, config.extraAllowedHosts, config.allowAnyUpstream, config.allowPrivateUpstream)) {
    return errorResponse(400, "variant URL host is not allowed");
  }

  const playlist = await fetchText(upstream, config, 25_000);
  const cleaned = stripAds(absolutize(playlist, upstream));
  return textResponse(cleaned.text, "application/vnd.apple.mpegurl", "no-store");
}

async function handleSessionPath(request: Request, env: Env, path: string): Promise<Response> {
  const parts = path.split("/").filter(Boolean); // ["hls", "<id>", ...]
  const id = parts[1] ?? "";
  if (!SESSION_ID_RE.test(id)) return errorResponse(404, "invalid session id");

  const rest = parts.slice(2).join("/");
  if (!rest) return errorResponse(404, "not found");

  // Only the four public HLS actions are exposed.
  const allowed =
    rest === "master.m3u8" ||
    rest === "subs.m3u8" ||
    rest === "subs.vtt" ||
    rest === "health" ||
    /^v\/\d+\.m3u8$/.test(rest);
  if (!allowed) return errorResponse(404, "not found");

  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(id));
  const doUrl = new URL(`https://session/${rest}`);
  const incoming = new URL(request.url);
  incoming.searchParams.forEach((value, key) => doUrl.searchParams.set(key, value));
  const response = await stub.fetch(
    new Request(doUrl, { method: request.method === "HEAD" ? "HEAD" : "GET" }),
  );
  return withCors(response);
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

function landingPage(): Response {
  return textResponse(
    [
      "nuvio-plutonium-cf",
      "",
      "Ad stripping and subtitle resyncing for Pluto TV HLS, on Cloudflare.",
      "",
      "Create a session:",
      '  curl -X POST https://<worker>/session -H "Content-Type: application/json" \\',
      '    -d \'{"mediaId":"<pluto-media-id>"}\'',
      "",
      "Python-proxy-compatible master:",
      "  GET /master.m3u8?url=<encoded Pluto master URL>",
      "",
      "Session endpoints:",
      "  GET /hls/<session>/master.m3u8",
      "  GET /hls/<session>/v/<n>.m3u8",
      "  GET /hls/<session>/subs.m3u8",
      "  GET /hls/<session>/subs.vtt",
      "",
    ].join("\n"),
    "text/plain; charset=utf-8",
  );
}
