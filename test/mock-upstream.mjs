import http from "node:http";

const port = Number(process.env.MOCK_PORT || 8798);
const MOCK = process.env.MOCK_BASE_URL || `http://127.0.0.1:${port}`;

const master = [
  "#EXTM3U",
  "#EXT-X-VERSION:5",
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs/en.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=1000,SUBTITLES="subs"',
  "v/0.m3u8",
  "",
].join("\n");

const variant = [
  "#EXTM3U",
  "#EXT-X-VERSION:5",
  "#EXT-X-TARGETDURATION:5",
  '#EXT-X-KEY:METHOD=AES-128,URI="key0"',
  "#EXTINF:5,",
  "seg0.ts",
  "#EXT-X-KEY:METHOD=NONE",
  "#EXTINF:5,",
  "https://example.invalid/1_ad/creative/ad.ts",
  "#EXT-X-DISCONTINUITY",
  '#EXT-X-KEY:METHOD=AES-128,URI="key1"',
  "#EXTINF:5,",
  "seg1.ts",
  "#EXT-X-ENDLIST",
  "",
].join("\n");

const subtitles = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:5",
  "#EXTINF:5,",
  `${MOCK}/chunks/0-10000/hls/text_en_cc/seg0.vtt`,
  "#EXTINF:5,",
  `${MOCK}/chunks/10000-20000/hls/text_en_cc/seg1.vtt`,
  "#EXTINF:5,",
  `${MOCK}/playout/placeholder/subtitles/ad.vtt`,
  "#EXTINF:0.5,",
  `${MOCK}/prd/placeholders/empty_90k.vtt`,
  "#EXT-X-ENDLIST",
  "",
].join("\n");

const chunk0 = [
  "WEBVTT",
  "",
  "00:00:00.500 --> 00:00:02.000",
  "Hello",
  "",
].join("\n");

const chunk1 = [
  "WEBVTT",
  "",
  "00:00:00.500 --> 00:00:02.000",
  "World",
  "",
].join("\n");

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
  const path = url.pathname;
  let body = "";
  let type = "application/vnd.apple.mpegurl";

  switch (path) {
    case "/master.m3u8":
      body = master;
      break;
    case "/v/0.m3u8":
      body = variant;
      break;
    case "/subs/en.m3u8":
      body = subtitles;
      break;
    case "/chunks/0-10000/hls/text_en_cc/seg0.vtt":
      body = chunk0;
      type = "text/vtt";
      break;
    case "/chunks/10000-20000/hls/text_en_cc/seg1.vtt":
      body = chunk1;
      type = "text/vtt";
      break;
    default:
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("not found");
      return;
  }

  response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  response.end(body);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock upstream listening on http://127.0.0.1:${port}`);
});
