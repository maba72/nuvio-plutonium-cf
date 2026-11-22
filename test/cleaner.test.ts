import { describe, expect, it } from "vitest";
import { absolutize, stripAds } from "../src/hls/cleaner";

describe("stripAds", () => {
  it("removes ads and keeps content keys", () => {
    const playlist = `#EXTM3U
#EXT-X-VERSION:5
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:5
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PROGRAM-DATE-TIME:2026-11-02T17:23:29.782Z
#EXT-X-KEY:METHOD=AES-128,URI="key0",IV=0x1
#EXTINF:5,
content0.ts
#EXT-X-PROGRAM-DATE-TIME:2026-11-02T17:23:34.782Z
#EXT-X-KEY:METHOD=NONE
#EXTINF:5,
https://cdn.example/1_ad/creative/ad0.ts
#EXT-X-DISCONTINUITY
#EXT-X-KEY:METHOD=AES-128,URI="key1",IV=0x2
#EXTINF:5.5,
content1.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:4,
https://cdn.example/_ad/bumper.ts
#EXT-X-DISCONTINUITY
#EXT-X-KEY:METHOD=AES-128,URI="key2",IV=0x3
#EXTINF:5,
content2.ts
#EXT-X-ENDLIST
`;

    const result = stripAds(playlist);
    expect(result.adSegments).toBe(2);
    expect(result.segmentCount).toBe(3);
    expect(result.duration).toBe(15.5);
    expect(result.adRanges).toEqual([
      { start: 5, end: 10 },
      { start: 15.5, end: 19.5 },
    ]);

    expect(result.text).not.toContain("METHOD=NONE");
    expect(result.text).not.toContain("#EXT-X-DISCONTINUITY");
    expect(result.text).not.toContain("17:23:34.782");
    expect(result.text).toContain("17:23:29.782");

    for (const expected of ["content0.ts", "content1.ts", "content2.ts", 'URI="key2"']) {
      expect(result.text).toContain(expected);
    }
    expect(result.text.match(/#EXT-X-ENDLIST/g)).toHaveLength(1);
    expect(result.text.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);
  });

  it("passes an unencrypted playlist through", () => {
    const playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\nsegment.ts\n";
    const result = stripAds(playlist);
    expect(result.adSegments).toBe(0);
    expect(result.segmentCount).toBe(1);
    expect(result.duration).toBe(5);
    expect(result.text).toContain("segment.ts");
    expect(result.text).toContain("#EXT-X-ENDLIST");
  });

  it("drops Pluto trailer metadata", () => {
    const playlist = [
      "#EXTM3U",
      "#EXT-X-KEY:METHOD=AES-128,URI=\"key\"",
      "#EXTINF:5,",
      "content.ts",
      "#PLUTO-SESSION-ID:abc",
      "#EXT-X-ENDLIST",
    ].join("\n");
    const result = stripAds(playlist);
    expect(result.text).not.toContain("#PLUTO-");
  });

  it("adds a VOD type and fixes target duration", () => {
    const playlist = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:2",
      "#EXT-X-KEY:METHOD=AES-128,URI=\"key\"",
      "#EXTINF:6.2,",
      "content.ts",
      "#EXT-X-ENDLIST",
    ].join("\n");
    const result = stripAds(playlist);
    expect(result.text).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(result.text).toContain("#EXT-X-TARGETDURATION:7");
  });
});

describe("absolutize", () => {
  it("resolves keys and segments", () => {
    const playlist =
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="seg_keyfile_0.key"\n#EXTINF:5,\nseg_00000.ts\n';
    const got = absolutize(playlist, "https://cdn.example/a/b/playlist.m3u8?jwt=x");
    expect(got).toContain('URI="https://cdn.example/a/b/seg_keyfile_0.key"');
    expect(got).toContain("https://cdn.example/a/b/seg_00000.ts");
  });

  it("leaves absolute URLs alone", () => {
    const playlist = "#EXTM3U\n#EXTINF:5,\nhttps://cdn.example/seg.ts\n";
    expect(absolutize(playlist, "https://cdn.example/a/b.m3u8")).toContain(
      "https://cdn.example/seg.ts",
    );
  });
});
