import { describe, expect, it } from "vitest";
import {
  ensureJwt,
  parseAttributes,
  parseMaster,
  renderMaster,
} from "../src/hls/master";

const masterText = [
  "#EXTM3U",
  "#EXT-X-VERSION:5",
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",URI="audio.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs/en.m3u8"',
  '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1000,SUBTITLES="subs",AUDIO="audio"',
  "1000/playlist.m3u8?jwt=child",
  '#EXT-X-STREAM-INF:BANDWIDTH=2000,AUDIO="audio"',
  "2000/playlist.m3u8",
  "",
].join("\n");

const masterUrl = "https://cdn.pluto.tv/v2/stitch/episode/1/master.m3u8?jwt=abc";

describe("parseMaster", () => {
  it("extracts variants and the English subtitle rendition", () => {
    const master = parseMaster(masterText, masterUrl);
    expect(master.variants).toHaveLength(2);
    expect(master.variants[0]!.attributes).toContain("BANDWIDTH=1000");
    expect(master.variants[0]!.url).toBe(
      "https://cdn.pluto.tv/v2/stitch/episode/1/1000/playlist.m3u8?jwt=child",
    );
    expect(master.variants[1]!.url).toBe(
      "https://cdn.pluto.tv/v2/stitch/episode/1/2000/playlist.m3u8?jwt=abc",
    );
    expect(master.subtitle).toEqual({
      uri: "https://cdn.pluto.tv/v2/stitch/episode/1/subs/en.m3u8?jwt=abc",
      language: "en",
      name: "English",
    });
  });

  it("prefers an English subtitle rendition", () => {
    const text = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Español",LANGUAGE="es",URI="subs/es.m3u8"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en-US",URI="subs/en.m3u8"',
      "#EXT-X-STREAM-INF:BANDWIDTH=1000",
      "1000/playlist.m3u8",
    ].join("\n");
    const master = parseMaster(text, masterUrl);
    expect(master.subtitle?.uri).toContain("subs/en.m3u8");
  });

  it("throws when there are no variants", () => {
    expect(() => parseMaster("#EXTM3U\n", masterUrl)).toThrow(/no variants/);
  });
});

describe("renderMaster", () => {
  it("drops audio/subtitle attributes and rewrites URIs", () => {
    const master = parseMaster(masterText, masterUrl);
    const rendered = renderMaster(master, true);
    expect(rendered.startsWith("#EXTM3U")).toBe(true);
    expect(rendered).toContain(
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI="subs.m3u8",LANGUAGE="en"',
    );
    expect(rendered).not.toContain('AUDIO="audio"');
    expect(rendered).toContain('#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1000,SUBTITLES="subs"');
    expect(rendered).toContain('#EXT-X-STREAM-INF:BANDWIDTH=2000,SUBTITLES="subs"');
    expect(rendered).toContain("v/0.m3u8");
    expect(rendered).toContain("v/1.m3u8");
  });

  it("omits subtitles when asked", () => {
    const master = parseMaster(masterText, masterUrl);
    const rendered = renderMaster(master, false);
    expect(rendered).not.toContain("TYPE=SUBTITLES");
    expect(rendered).not.toContain("SUBTITLES=");
  });

  it("supports an absolute prefix", () => {
    const master = parseMaster(masterText, masterUrl);
    const rendered = renderMaster(master, true, "/hls/abc/");
    expect(rendered).toContain('URI="/hls/abc/subs.m3u8"');
    expect(rendered).toContain("/hls/abc/v/0.m3u8");
  });
});

describe("attributes", () => {
  it("parses quoted values containing commas", () => {
    const attributes = parseAttributes(
      'PROGRAM-ID=1,CODECS="avc1.4d401f,mp4a.40.2",BANDWIDTH=1000',
    );
    expect(attributes.CODECS).toBe("avc1.4d401f,mp4a.40.2");
    expect(attributes.BANDWIDTH).toBe("1000");
  });

  it("inherits the master jwt only when the child lacks one", () => {
    expect(ensureJwt("https://cdn.example/a.m3u8", masterUrl)).toContain("jwt=abc");
    expect(ensureJwt("https://cdn.example/a.m3u8?jwt=child", masterUrl)).toContain("jwt=child");
  });
});
