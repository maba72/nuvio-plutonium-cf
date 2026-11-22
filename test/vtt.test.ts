import { describe, expect, it } from "vitest";
import {
  cleanCues,
  durationMS,
  formatTime,
  mergeAdjacentCues,
  parseVtt,
  rebaseAfterAds,
  renderVtt,
  shiftCues,
  type Window,
} from "../src/vtt";

describe("parseVtt", () => {
  it("parses full timestamps and applies an offset", () => {
    const body = [
      "WEBVTT",
      "",
      "00:00:01.500 --> 00:00:03.000 align:start",
      "Hello",
      "World",
      "",
      "00:00:04.000 --> 00:00:05.250",
      "Second",
      "",
    ].join("\n");
    const cues = parseVtt(body, 60_000);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({
      start: 61_500,
      end: 63_000,
      settings: "align:start",
      text: ["Hello", "World"],
    });
    expect(cues[1]).toMatchObject({ start: 64_000, end: 65_250, text: ["Second"] });
  });

  it("parses short timestamps", () => {
    const body = "WEBVTT\n\n01:02.345 --> 01:03.456\nShort\n";
    const cues = parseVtt(body, 0);
    expect(cues[0]!.start).toBe(62_345);
    expect(cues[0]!.end).toBe(63_456);
  });

  it("ignores headers, notes, and cue identifiers", () => {
    const body = [
      "WEBVTT",
      "X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000",
      "",
      "NOTE this is a note",
      "",
      "cue-id-1",
      "00:00:01.000 --> 00:00:02.000",
      "Text",
      "",
    ].join("\n");
    const cues = parseVtt(body, 0);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toEqual(["Text"]);
  });
});

describe("cleanCues", () => {
  it("sorts, clamps, and deduplicates without settings in the key", () => {
    const cues = [
      { start: 2000, end: 3000, settings: "a", text: ["B"] },
      { start: 1000, end: 2000, settings: "x", text: ["A"] },
      { start: 1000, end: 2000, settings: "y", text: ["A"] },
      { start: -50, end: 500, settings: "", text: ["C"] },
      { start: 4000, end: 4000, settings: "", text: ["Drop"] },
    ];
    const cleaned = cleanCues(cues);
    expect(cleaned.map((cue) => cue.text.join("|"))).toEqual(["C", "A", "B"]);
    expect(cleaned[0]!.start).toBe(0);
    expect(cleaned).toHaveLength(3);
  });

  it("keeps empty cues used to clear the screen", () => {
    const cleaned = cleanCues([
      { start: 1000, end: 2000, settings: "", text: [] },
      { start: 1000, end: 2000, settings: "", text: [] },
    ]);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]!.text).toEqual([]);
  });
});

describe("shiftCues", () => {
  it("delays every cue while preserving settings and text", () => {
    const cues = [
      { start: 500, end: 2000, settings: "line:90%", text: ["Hello"] },
      { start: 3000, end: 4000, settings: "", text: [] },
    ];
    const shifted = shiftCues(cues, 1000);
    expect(shifted.map((cue) => [cue.start, cue.end])).toEqual([
      [1500, 3000],
      [4000, 5000],
    ]);
    expect(shifted[0]!.settings).toBe("line:90%");
    expect(shifted[0]!.text).toEqual(["Hello"]);
    expect(cues[0]!.start).toBe(500);
  });

  it("clamps negative offsets at zero", () => {
    expect(shiftCues([{ start: 500, end: 1500, settings: "", text: ["x"] }], -1000)).toEqual([
      { start: 0, end: 500, settings: "", text: ["x"] },
    ]);
  });
});

describe("mergeAdjacentCues", () => {
  it("merges touching and overlapping repeats but keeps separated cues", () => {
    const cues = [
      { start: 1000, end: 2000, settings: "line:90%", text: ["Same"] },
      { start: 2000, end: 3000, settings: "align:start", text: ["Same"] },
      { start: 2900, end: 3500, settings: "", text: ["Same"] },
      { start: 4000, end: 4500, settings: "", text: ["Other"] },
      { start: 5000, end: 6000, settings: "", text: ["Same"] },
    ];
    expect(mergeAdjacentCues(cues)).toEqual([
      { start: 1000, end: 3500, settings: "line:90%", text: ["Same"] },
      { start: 4000, end: 4500, settings: "", text: ["Other"] },
      { start: 5000, end: 6000, settings: "", text: ["Same"] },
    ]);
  });

  it("does not merge cues with different multiline text", () => {
    const cues = [
      { start: 1000, end: 2000, settings: "", text: ["A", "B"] },
      { start: 2000, end: 3000, settings: "", text: ["B", "A"] },
    ];
    expect(mergeAdjacentCues(cues)).toHaveLength(2);
  });
});

describe("renderVtt", () => {
  it("renders a standalone WebVTT document", () => {
    const text = renderVtt([
      { start: 1500, end: 3000, settings: "align:start", text: ["Hello", "World"] },
    ]);
    expect(text).toBe(
      "WEBVTT\n\n00:00:01.500 --> 00:00:03.000 align:start\nHello\nWorld\n\n",
    );
  });

  it("formats hours", () => {
    expect(formatTime(3_723_456)).toBe("01:02:03.456");
  });
});

describe("durationMS", () => {
  it("returns the last cue end", () => {
    expect(
      durationMS([
        { start: 0, end: 1000, settings: "", text: [] },
        { start: 2000, end: 5000, settings: "", text: [] },
      ]),
    ).toBe(5000);
  });
});

describe("rebaseAfterAds", () => {
  const windows: Window[] = [
    { start: 10_000, end: 15_000 },
    { start: 30_000, end: 34_000 },
  ];

  it("shifts later cues left by removed ad durations", () => {
    const cues = [
      { start: 1000, end: 2000, settings: "", text: ["before"] },
      { start: 20_000, end: 21_000, settings: "align:start", text: ["after one"] },
      { start: 40_000, end: 41_000, settings: "", text: ["after two"] },
    ];
    const rebased = rebaseAfterAds(cues, windows);
    expect(rebased.map((cue) => cue.start)).toEqual([1000, 15_000, 31_000]);
    expect(rebased[1]!.settings).toBe("align:start");
    expect(rebased[1]!.text).toEqual(["after one"]);
  });

  it("drops cues that begin inside an ad window", () => {
    const cues = [
      { start: 10_500, end: 11_500, settings: "", text: ["ad text"] },
      { start: 15_000, end: 16_000, settings: "", text: ["at boundary"] },
    ];
    const rebased = rebaseAfterAds(cues, windows);
    expect(rebased).toHaveLength(1);
    expect(rebased[0]!.start).toBe(10_000);
    expect(rebased[0]!.text).toEqual(["at boundary"]);
  });

  it("sorts windows and leaves cues unchanged when there are none", () => {
    const cues = [{ start: 1000, end: 2000, settings: "", text: ["hello"] }];
    expect(rebaseAfterAds(cues, [])).toEqual(cues);
    const unsorted: Window[] = [
      { start: 30_000, end: 34_000 },
      { start: 10_000, end: 15_000 },
    ];
    expect(
      rebaseAfterAds(
        [{ start: 40_000, end: 41_000, settings: "", text: ["x"] }],
        unsorted,
      )[0]!.start,
    ).toBe(31_000);
  });
});
