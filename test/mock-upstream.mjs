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

// Extra chunked segments exercise the Durable Object SQLite bind limit in e2e.
const extraSegments = Math.max(0, Number(process.env.MOCK_EXTRA_SUBTITLE_SEGMENTS || 0));
const extraLines = [];
for (let index = 0; index < extraSegments; index++) {
  const start = (index + 2) * 10_000;
  extraLines.push(
    "#EXTINF:5,",
    `${MOCK}/chunks/${start}-${start + 10_000}/hls/text_en_cc/seg${index + 2}.vtt`,
  );
}

const subtitles = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:5",
  "#EXTINF:5,",
  `${MOCK}/chunks/0-10000/hls/text_en_cc/seg0.vtt`,
  "#EXTINF:5,",
  `${MOCK}/chunks/10000-20000/hls/text_en_cc/seg1.vtt`,
  ...extraLines,
  "#EXTINF:5,",
  `${MOCK}/playout/placeholder/subtitles/ad.vtt`,
  "#EXTINF:0.5,",
  `${MOCK}/prd/placeholders/empty_90k.vtt`,
  "#EXT-X-ENDLIST",
  "",
].join("\n");

const chunk0 = ["WEBVTT", "", "00:00:00.500 --> 00:00:02.000", "Hello", ""].join("\n");
// The second cue repeats the same line with a slightly shorter end, like the
// overlapping chunks Pluto produces. It must be merged before serving.
const chunk1 = [
  "WEBVTT",
  "",
  "00:00:00.500 --> 00:00:02.000 line:90%",
  "World",
  "",
  "00:00:00.500 --> 00:00:01.900 align:start",
  "World",
  "",
].join("\n");

const movieOne = {
  _id: "movie-1",
  type: "movie",
  name: "Mock Movie",
  releaseDate: "2021-05-01T00:00:00Z",
  duration: 7_200_000,
  rating: "PG-13",
  genre: "Action",
  summary: "A mock action movie.",
  covers: [
    { aspectRatio: "347:500", url: `${MOCK}/img/movie-1-poster.jpg` },
    { aspectRatio: "16:9", url: `${MOCK}/img/movie-1-backdrop.jpg` },
  ],
  clip: {
    actors: [{ name: "Actor One" }],
    directors: [{ name: "Director One" }],
  },
};

const movieTwo = {
  _id: "movie-2",
  type: "movie",
  name: "Second Movie",
  releaseDate: "2022-08-11T00:00:00Z",
  duration: 5_400_000,
  genre: ["Comedy", "Drama"],
  description: "Another mock title.",
};

const seriesOne = {
  _id: "series-1",
  type: "series",
  name: "Mock Series",
  releaseDate: "2020-01-01T00:00:00Z",
  genre: ["Drama"],
  summary: "A mock series.",
};

const categories = {
  categories: [
    { name: "Most Popular Movies", items: [movieOne, movieTwo] },
    { name: "Top TV Series", items: [seriesOne] },
    { name: "Top Titles", items: [movieOne, movieTwo, seriesOne] },
    { name: "New Movies This Month", items: [movieTwo] },
    { name: "Leaving Soon", items: [movieOne, seriesOne] },
  ],
};

const seasons = {
  seasons: [
    {
      number: 1,
      episodes: [
        {
          _id: "episode-1",
          name: "Pilot",
          number: 1,
          releaseDate: "2020-01-01T00:00:00Z",
          duration: 1_800_000,
          description: "The pilot episode.",
        },
        {
          _id: "episode-2",
          name: "Second Episode",
          number: 2,
          releaseDate: "2020-01-08T00:00:00Z",
          duration: 1_800_000,
        },
      ],
    },
  ],
};

const boot = {
  sessionToken: "mock-token",
  servers: { stitcher: MOCK },
  stitcherParams: "deviceType=web&country=US",
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", MOCK);
  const path = url.pathname;
  let body = "";
  let type = "application/vnd.apple.mpegurl";

  switch (path) {
    case "/v4/start":
      type = "application/json";
      body = JSON.stringify(boot);
      break;
    case "/v3/vod/categories":
      type = "application/json";
      body = JSON.stringify(categories);
      break;
    case "/v3/vod/series/series-1/seasons":
      type = "application/json";
      body = JSON.stringify(seasons);
      break;
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
    default: {
      const chunk = /^\/chunks\/\d+-\d+\/hls\/text_en_cc\/seg(\d+)\.vtt$/.exec(path);
      if (chunk) {
        body = Number(chunk[1]) === 0 ? chunk0 : Number(chunk[1]) === 1 ? chunk1 : "WEBVTT\n\n";
        type = "text/vtt";
      } else if (path.startsWith("/v2/stitch/hls/episode/") && path.endsWith("/master.m3u8")) {
        body = master;
      } else if (path.startsWith("/v2/stitch/hls/episode/") && path.endsWith("/subs/en.m3u8")) {
        body = subtitles;
      } else {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("not found");
        return;
      }
    }
  }

  response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  response.end(body);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock upstream listening on ${MOCK}`);
});
