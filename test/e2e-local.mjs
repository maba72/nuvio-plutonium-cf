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

// The mock variant has a 5s ad from 5s to 10s on Pluto's original timeline.
// Captions after it must be shifted left, so "World" moves from 10.5s to 5.5s.
const subtitlePlaylist = await getText(`/hls/${created.id}/subs.m3u8`);
assert.match(subtitlePlaylist.text, /#EXT-X-TARGETDURATION:7/);
assert.match(subtitlePlaylist.text, /#EXTINF:7\.000,/);
assert.match(subtitlePlaylist.text, /subs\.vtt/);

const vtt = await getText(`/hls/${created.id}/subs.vtt`);
assert.match(vtt.text, /^WEBVTT/);
assert.match(vtt.text, /00:00:00\.500 --> 00:00:02\.000/);
assert.match(vtt.text, /Hello/);
assert.match(vtt.text, /00:00:05\.500 --> 00:00:07\.000/);
assert.match(vtt.text, /World/);
assert.doesNotMatch(vtt.text, /00:00:10\.500 --> 00:00:12\.000/);
assert.match(vtt.response.headers.get("cache-control") ?? "", /public/);

const vttAgain = await getText(`/hls/${created.id}/subs.vtt`);
assert.equal(vttAgain.text, vtt.text);

const health = await getText(`/hls/${created.id}/health`);
assert.match(health.text, /"subtitles":"done"/);
assert.match(health.text, /"variants":1/);

const compatMaster = await getText(`/master.m3u8?url=${encodeURIComponent(MASTER_URL)}`);
assert.match(compatMaster.text, new RegExp(`/hls/[a-f0-9]{32}/v/0\\.m3u8`));
assert.match(compatMaster.text, new RegExp(`/hls/[a-f0-9]{32}/subs\\.m3u8`));

const compatVariant = await getText(`/variant.m3u8?url=${encodeURIComponent(VARIANT_URL)}`);
assert.match(compatVariant.text, /seg0\.ts/);
assert.doesNotMatch(compatVariant.text, /1_ad\/creative/);

console.log("local end-to-end checks passed");
