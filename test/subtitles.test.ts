import { describe, expect, it } from "vitest";
import { chunkOffsetMS, parseSubtitleSegments } from "../src/hls/subtitles";

describe("parseSubtitleSegments", () => {
  it("matches the Kodi/Go offsets and durations", () => {
    const playlist = [
      "#EXTM3U",
      "#EXTINF:5,",
      "https://cdn.example/636_pluto/clip/abc/713464-1241617/hls/text_en_cc/seg_00000.vtt",
      "#EXTINF:5,",
      "https://cdn.example/636_pluto/clip/abc/713464-1241617/hls/text_en_cc/seg_00001.vtt",
      "#EXTINF:5,",
      "https://cdn.example/playout/placeholder/subtitles/seg_00002.vtt",
      "#EXTINF:0.133,",
      "https://cdn.example/prd/placeholders/empty_90k.vtt",
    ].join("\n");

    const parsed = parseSubtitleSegments(
      playlist,
      "https://cdn.example/subtitle/subs/en/playlist.m3u8",
    );
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0]!.offsetMS).toBe(713464);
    expect(parsed.segments[1]!.offsetMS).toBe(713464);
    expect(parsed.segments[0]!.duration).toBe(5);
    expect(parsed.contentDuration).toBeCloseTo(10.133);
    expect(parsed.skipped).toBe(1);
  });

  it("resolves relative chunk segment URLs", () => {
    const parsed = parseSubtitleSegments(
      "#EXTM3U\n#EXTINF:5,\n713464-1241617/hls/text_en_cc/seg.vtt\n",
      "https://cdn.example/subtitle/subs/en/playlist.m3u8",
    );
    expect(parsed.segments[0]!.url).toBe(
      "https://cdn.example/subtitle/subs/en/713464-1241617/hls/text_en_cc/seg.vtt",
    );
  });

  it("skips relative filler segments without a chunk base", () => {
    const parsed = parseSubtitleSegments(
      "#EXTM3U\n#EXTINF:5,\nseg.vtt\n",
      "https://cdn.example/subtitle/subs/en/playlist.m3u8",
    );
    expect(parsed.segments).toHaveLength(0);
    expect(parsed.contentDuration).toBe(5);
    expect(parsed.skipped).toBe(1);
  });
});

describe("chunkOffsetMS", () => {
  it("extracts the chunk base from known Pluto URL shapes", () => {
    const cases: Array<[string, number]> = [
      [
        "https://cdn/636_pluto/clip/abc/713464-1241617/hls/text_en_cc/seg_00000.vtt",
        713464,
      ],
      ["https://cdn/636_pluto/clip/abc/hls/0-898524/en-cc/00000.vtt", 0],
      ["https://cdn/636_pluto/clip/abc/hls/0-246147/en/en.m3u8_0000000000.vtt", 0],
      [
        "https://cdn/636_pluto/clip/abc/1150901-1696238/hls/text_en_cc/seg_00230.vtt",
        1150901,
      ],
    ];
    for (const [input, expected] of cases) {
      expect(chunkOffsetMS(input)).toBe(expected);
    }
  });

  it("returns null for non-chunk URLs", () => {
    expect(chunkOffsetMS("https://cdn.example/foo/bar.vtt")).toBeNull();
  });
});
