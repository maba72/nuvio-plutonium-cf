import assert from "node:assert/strict";

const BASE = process.env.WORKER_URL || "http://127.0.0.1:8797";
const MOCK = process.env.MOCK_URL || "http://127.0.0.1:8798";
const MASTER_URL = `${MOCK}/master.m3u8`;
const VARIANT_URL = `${MOCK}/v/0.m3u8`;

async function waitFor(url, label) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${label} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} was not ready: ${lastError?.message ?? lastError}`);
}

async function getText(path) {
  const response = await fetch(`${BASE}${path}`);
  assert.equal(response.status, 200, `GET ${path} returned HTTP ${response.status}`);
  return { text: await response.text(), response };
}

await waitFor(`${BASE}/health`, "worker");
await waitFor(MASTER_URL, "mock upstream");

const mediaId = `e2e-${Date.now()}`;
const createdResponse = await fetch(`${BASE}/session`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ masterUrl: MASTER_URL, mediaId, xff: "74.83.52.188" }),
});
assert.equal(createdResponse.status, 200, `POST /session returned HTTP ${createdResponse.status}`);
const created = await createdResponse.json();
assert.match(created.id, /^[a-f0-9]{32}$/);
assert.equal(created.url, `${BASE}/hls/${created.id}/master.m3u8`);

const master = await getText(`/hls/${created.id}/master.m3u8`);
assert.match(master.text, /^#EXTM3U/);
assert.match(master.text, /v\/0\.m3u8/);
assert.match(master.text, /subs\.m3u8/);
assert.doesNotMatch(master.text, /https?:\/\/127\.0\.0\.1:8798\//);

const variant = await getText(`/hls/${created.id}/v/0.m3u8`);
assert.match(variant.text, /seg0\.ts/);
assert.match(variant.text, /seg1\.ts/);
assert.doesNotMatch(variant.text, /1_ad\/creative/);
assert.doesNotMatch(variant.text, /METHOD=NONE/);
assert.doesNotMatch(variant.text, /#EXT-X-DISCONTINUITY/);

// Pluto chunk offsets already skip the mock variant's 5s ad, so the second
// chunk's base is 5s. The default +1s sync delay then applies on the ad-free
// timeline: "Hello" starts at 1.5s and "World" starts at 6.5s. There must be no
// second ad rebase, which would move "World" to 1.5s.
const subtitlePlaylist = await getText(`/hls/${created.id}/subs.m3u8`);
const extraSegments = Number(process.env.MOCK_EXTRA_SUBTITLE_SEGMENTS || 0);
if (extraSegments === 0) {
  assert.match(subtitlePlaylist.text, /#EXT-X-TARGETDURATION:8/);
  assert.match(subtitlePlaylist.text, /#EXTINF:8\.000,/);
} else {
  assert.match(subtitlePlaylist.text, /#EXT-X-TARGETDURATION:\d+/);
  assert.match(subtitlePlaylist.text, /#EXTINF:\d+\.\d+,/);
}
assert.match(subtitlePlaylist.text, /subs\.vtt/);

const vtt = await getText(`/hls/${created.id}/subs.vtt`);
assert.match(vtt.text, /^WEBVTT/);
assert.match(vtt.text, /00:00:01\.500 --> 00:00:03\.000/);
assert.match(vtt.text, /Hello/);
assert.match(vtt.text, /00:00:06\.500 --> 00:00:08\.000 align:start/);
assert.doesNotMatch(vtt.text, /00:00:06\.500 --> 00:00:07\.900/);
assert.doesNotMatch(vtt.text, /00:00:05\.500 --> 00:00:07\.000/);
assert.doesNotMatch(vtt.text, /00:00:10\.500 --> 00:00:12\.000/);
if (extraSegments === 0) {
  assert.equal((vtt.text.match(/^World$/gm) ?? []).length, 1);
}
assert.match(vtt.response.headers.get("cache-control") ?? "", /public/);

const vttAgain = await getText(`/hls/${created.id}/subs.vtt`);
assert.equal(vttAgain.text, vtt.text);

const health = await getText(`/hls/${created.id}/health`);
assert.match(health.text, /"subtitles":"done"/);
assert.match(health.text, /"variants":1/);

// Addon endpoints: one URL provides the catalog, metadata, search and streams.
const manifest = JSON.parse((await getText("/manifest.json")).text);
assert.equal(manifest.id, "org.maba.pluto-catalog");
assert.equal(manifest.catalogs.length, 7);
assert.deepEqual(manifest.types, ["movie", "series"]);

const catalog = JSON.parse((await getText("/catalog/movie/pluto-movies.json")).text);
assert.ok(catalog.metas.some((meta) => meta.id === "pluto:movie:movie-1"));
assert.equal(catalog.metas.find((meta) => meta.id === "pluto:movie:movie-1").name, "Mock Movie");

const movieMeta = JSON.parse((await getText("/meta/movie/pluto:movie:movie-1.json")).text);
assert.equal(movieMeta.meta.name, "Mock Movie");
assert.equal(movieMeta.meta.cast[0], "Actor One");
assert.equal(movieMeta.meta.runtime, "120 min");

const series = JSON.parse((await getText("/meta/series/pluto:series:series-1.json")).text);
assert.equal(series.meta.videos.length, 2);
assert.equal(series.meta.videos[0].id, "pluto:episode:episode-1");
assert.equal(series.meta.behaviorHints.defaultVideoId, "pluto:episode:episode-1");

const search = JSON.parse((await getText("/search?q=mock")).text);
assert.ok(search.metas.some((meta) => meta.id === "pluto:movie:movie-1"));

const streams = JSON.parse(
  (await getText("/stream/movie/pluto:movie:movie-1.json?xff=74.83.52.188")).text,
);
assert.equal(streams.streams.length, 1);
assert.match(streams.streams[0].url, new RegExp(`${BASE}/hls/[a-f0-9]{32}/master\\.m3u8`));
assert.equal(streams.streams[0].behaviorHints.proxyHeaders.request["X-Forwarded-For"], "74.83.52.188");
const streamedMaster = await fetch(streams.streams[0].url);
assert.equal(streamedMaster.status, 200);
assert.match(await streamedMaster.text(), /^#EXTM3U/);

const compatMaster = await getText(`/master.m3u8?url=${encodeURIComponent(MASTER_URL)}`);
assert.match(compatMaster.text, new RegExp(`/hls/[a-f0-9]{32}/v/0\\.m3u8`));
assert.match(compatMaster.text, new RegExp(`/hls/[a-f0-9]{32}/subs\\.m3u8`));

const compatVariant = await getText(`/variant.m3u8?url=${encodeURIComponent(VARIANT_URL)}`);
assert.match(compatVariant.text, /seg0\.ts/);
assert.doesNotMatch(compatVariant.text, /1_ad\/creative/);

console.log("local end-to-end checks passed");
