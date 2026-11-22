# nuvio-plutonium-cf

Cloudflare Worker replacement for the Pluto HLS portion of
[`nuvio-plutonium`](https://github.com/maba72/nuvio-plutonium).

A single URL provides both the Nuvio catalog and the ad-free streams:

```text
https://nuvio-plutonium.marc-ballegeer.workers.dev/manifest.json
```

It provides:

- Pluto's on-demand catalogs, metadata, search and stream resolution;
- HLS ad stripping (Pluto SSAI segments removed from media playlists);
- merged WebVTT captions resynced to the ad-free timeline.

Media segments are never proxied: the returned playlists point directly at
Pluto's CDN. The original Go server's catalog is no longer required, although
the [`nuvio-plutonium`](https://github.com/maba72/nuvio-plutonium) provider
script remains available as a stream-only fallback for titles from other
catalogs.

## Architecture

- `src/index.ts` — Worker router, CORS, upstream allowlisting, and
  Python-proxy-compatible endpoints.
- `src/addon.ts` — Stremio/Nuvio addon manifest and catalog/meta/search/stream
  routes.
- `src/catalog.ts`, `src/pluto-catalog.ts` — catalog conversion helpers and
  Pluto catalog API access with a shared KV cache.
- `src/tmdb.ts` — optional cast-photo enrichment, enabled by `TMDB_API_KEY`.
- `src/session.ts` — shared playback-session creation.
- `src/session-do.ts` — one SQLite-backed Durable Object per playback session.
  Stores the parsed master, cleaned variant playlists, subtitle job state, and
  uses alarms to resume long jobs.
- `src/hls/` — TypeScript ports of the Go master/cleaner/subtitle logic.
- `src/vtt.ts` — TypeScript port of the Go WebVTT parser/retimer.
- Workers KV namespace `SUBS` — caches generated WebVTT files. KV is included
  on the free plan, so no R2 bucket or payment details are required. Pluto's
  chunk offsets already skip ad placeholders, so cached tracks are on the
  ad-free video timeline. Each session only merges repeated lines and applies
  the sync delay before serving `subs.vtt`; no second ad rebase is performed.

## Deploy

```bash
cd nuvio-plutonium-cf
npm install

# One time only: create the free Workers KV namespace and paste the IDs into
# wrangler.toml (the IDs for this deployment are already configured).
npx wrangler kv namespace create SUBS
npx wrangler kv namespace create SUBS --preview

# Optional: force Pluto's geo/country and provide a fixed forwarded IP.
npx wrangler secret put PLUTO_XFF
# npx wrangler secret put PLUTO_USER_AGENT

npx wrangler deploy
```

If you create your own KV namespace, update `id` and `preview_id` under
`[[kv_namespaces]]` in `wrangler.toml`. The Worker's public origin is printed by
Wrangler; you can also set `PUBLIC_URL` if the Worker is behind a custom domain.

Useful checks before deploying:

```bash
npm run typecheck
npm test
npm run dry-run
```

## Configuration

Values in `wrangler.toml`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_URL` | `""` | Origin used in `/session` responses. Empty uses the request origin. |
| `PLUTO_COUNTRY` | `US` | Country sent to Pluto boot/stitcher/catalog APIs. |
| `CATALOG_CACHE_TTL_SECONDS` | `900` | Freshness of cached catalog/seasons responses in KV. |
| `SESSION_TTL_SECONDS` | `86400` | Session lifetime; cleanup alarm expires state after this. |
| `SUBTITLE_CACHE_TTL_SECONDS` | `604800` | KV WebVTT cache freshness (7 days). |
| `SUBTITLE_OFFSET_MS` | `1000` | Fixed cue delay applied to the ad-free caption timeline. Pluto's captions run ahead of the picture; set to `0` to disable. |
| `SUBTITLE_CONCURRENCY` | `6` | Parallel subtitle chunk fetches. Keep at 6: Workers allow only 6 simultaneous outbound connections. |
| `SUBTITLE_BATCH_SIZE` | `16` | Chunks fetched per DO work batch. Sized for Workers Free's 50-subrequest cap. |
| `SUBREQUEST_BUDGET` | `16` | Per-invocation chunk budget before rescheduling via an alarm. |
| `SUBTITLE_FETCH_ATTEMPTS` | `1` | Upstream attempts per VTT chunk. Keep at 1 on Free so retries cannot multiply subrequests. |
| `ALLOWED_UPSTREAM_HOSTS` | `""` | Comma-separated extra hosts, e.g. `example.com,*.example.net`. |
| `ALLOW_ANY_UPSTREAM` | `false` | Disables the public-host allowlist. Do not enable in production. |
| `ALLOW_PRIVATE_UPSTREAM` | `false` | Allows localhost/LAN upstreams. Development only. |

Secrets (set with `npx wrangler secret put <NAME>`):

- `PLUTO_XFF` — fixed IP echoed to Pluto as `X-Forwarded-For`.
- `PLUTO_USER_AGENT` — override the browser user agent sent upstream.
- `TMDB_API_KEY` — optional; adds cast profile photos to `/meta` responses.

`PLUTO_BOOT_URL`, `PLUTO_CATEGORIES_URL` and `PLUTO_SERIES_URL` can override the
upstream endpoints for local testing; they are not needed in production.

### Workers Free compatibility

Subtitle generation fans out across Pluto's VTT chunks, but it no longer needs a
Paid plan:

- each DO work batch fetches only 16 chunks, with no per-chunk retries;
- a chunk plus a redirect stays under Workers Free's 50 external subrequests per
  invocation;
- the DO alarm loop resumes the remaining chunks in later invocations;
- generated VTT is cached in free Workers KV, and partial results live in the
  free SQLite-backed Durable Object.

Long movies take more alarm ticks, but no payment details are required.

## API

### Nuvio/Stremio addon

Install this manifest URL in Nuvio to get catalogs and ad-free streams from one
addon — no local server required:

```text
https://nuvio-plutonium.marc-ballegeer.workers.dev/manifest.json
```

| Endpoint | Description |
| --- | --- |
| `GET /manifest.json` | Addon manifest with seven Pluto catalogs. |
| `GET /catalog/<type>/<row>.json` | Meta previews for a catalog row. |
| `GET /meta/<type>/pluto:<kind>:<id>.json` | Metadata, series videos and cast. |
| `GET /search?q=<text>` | Search over the catalog cache. |
| `GET /stream/<type>/pluto:<kind>:<id>.json` | Ad-free HLS stream for a movie or episode. |

`type` is `movie` or `series` (`tv` is accepted as an alias), and `kind` is
`movie` or `episode`. All addon endpoints accept optional `?country=` and
`?xff=<ip>` parameters.

### Session flow

Create a session from a raw Pluto stitcher master URL:

```bash
curl -X POST https://<worker>/session \
  -H 'Content-Type: application/json' \
  -d '{"masterUrl":"https://.../master.m3u8?jwt=..."}'
```

Or from a Pluto media ID, which performs boot and builds the stitcher URL:

```bash
curl -X POST https://<worker>/session \
  -H 'Content-Type: application/json' \
  -d '{"mediaId":"<pluto-id>","country":"US"}'
```

Response:

```json
{
  "id": "<32 hex chars>",
  "url": "https://<worker>/hls/<id>/master.m3u8",
  "masterUrl": "https://<worker>/hls/<id>/master.m3u8",
  "subtitlesUrl": "https://<worker>/hls/<id>/subs.m3u8",
  "vttUrl": "https://<worker>/hls/<id>/subs.vtt"
}
```

Session endpoints:

| Endpoint | Description |
| --- | --- |
| `GET /hls/<id>/master.m3u8` | Cleaned master with local variant and subtitle URIs. |
| `GET /hls/<id>/v/<n>.m3u8` | Cleaned variant playlist with ad segments removed. |
| `GET /hls/<id>/subs.m3u8` | One-segment VOD playlist for the generated WebVTT. |
| `GET /hls/<id>/subs.vtt` | Generated, retimed WebVTT. |
| `GET /hls/<id>/health` | Session diagnostics (`variants`, `subtitles` status). |

`POST /session` also accepts URL-form parameters via `GET /session?mediaId=...`
or `GET /session?masterUrl=...`.

### Python-proxy-compatible endpoints

The existing Nuvio/Plutonium provider sets its Proxy URL and calls
`/master.m3u8?url=<encoded Pluto master URL>`. Those requests work unchanged:

```text
GET /master.m3u8?url=<encoded>&country=US&xff=74.83.52.188
GET /variant.m3u8?url=<encoded>&xff=74.83.52.188
```

Point the provider's Proxy URL at the Worker origin (no path), for example
`https://pluto.example.com`.

`GET /health` is a service-level health check; `GET /` returns a short usage
page.

## X-Forwarded-For

Pluto uses the forwarded IP for regional routing. The Worker resolves it in
this order:

1. `?xff=<ip>` query parameter;
2. `X-Forwarded-For` request header (first entry only);
3. `PLUTO_XFF` secret.

Only syntactically valid IPv4/IPv6 addresses are accepted; invalid values are
ignored. The same value is used for boot, master, variant, subtitle, and VTT
chunk requests within a session.

## Local development and end-to-end test

The existing Go/Python project already uses ports 8787 and 8788. The mock and
Worker therefore default to 8798 and 8797.

```bash
# Terminal 1: local mock Pluto upstream
node test/mock-upstream.mjs

# Terminal 2: Worker with local DO/KV emulation
npx wrangler dev --port 8797 --ip 127.0.0.1

# Terminal 3: full flow
npm run test:e2e
```

`.dev.vars` is gitignored and contains:

```dotenv
ALLOW_ANY_UPSTREAM=true
ALLOW_PRIVATE_UPSTREAM=true
PLUTO_BOOT_URL=http://127.0.0.1:8798/v4/start
PLUTO_CATEGORIES_URL=http://127.0.0.1:8798/v3/vod/categories
PLUTO_SERIES_URL=http://127.0.0.1:8798/v3/vod/series/
```

These flags let the local Worker fetch from the mock upstream. Do not deploy
them.

## Security notes

- Upstream hosts are restricted to `*.pluto.tv` and `*.plutotv.net` by default.
  Extra hosts must be listed in `ALLOWED_UPSTREAM_HOSTS`.
- Private, loopback, link-local, and localhost addresses are always blocked
  unless `ALLOW_PRIVATE_UPSTREAM=true` is explicitly set for local development.
  `ALLOW_ANY_UPSTREAM=true` alone does not permit private hosts.
- Master/variant URLs supplied by clients are checked against the same
  allowlist before fetching, so the Worker cannot be used as a generic proxy.
- CORS is permissive because Nuvio clients are browser-based and the Worker
  returns only playlists/captions, not media bytes.
- Session IDs are random 128-bit values. `/hls/<id>/...` accepts only the five
  public endpoints listed above.
