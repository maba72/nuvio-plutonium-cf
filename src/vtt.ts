/**
 * WebVTT parsing, retiming, deduplication, and rendering.
 *
 * Port of nuvio-plutonium/internal/vtt/vtt.go. Cue times are milliseconds in
 * the output (ad-free) timeline.
 */

export interface Cue {
  start: number;
  end: number;
  settings: string;
  text: string[];
}

const FULL_TIME_RE =
  /^(\d{1,3}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[.,](\d{1,3})(.*)$/;
const SHORT_TIME_RE =
  /^(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{2}):(\d{2})[.,](\d{1,3})(.*)$/;

/** Extract cues from a WebVTT fragment and add offsetMS to every cue. */
export function parseVtt(data: string, offsetMS: number): Cue[] {
  const text = data.replace(/^\uFEFF/, "");
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const cues: Cue[] = [];
  let current: Cue | null = null;

  const flush = () => {
    if (!current) return;
    current.text = trimText(current.text);
    cues.push(current);
    current = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\r+$/, "");
    const trimmed = line.trim();
    const timestamp = parseTimestampLine(trimmed);
    if (timestamp) {
      flush();
      current = {
        start: timestamp.start + offsetMS,
        end: timestamp.end + offsetMS,
        settings: timestamp.settings,
        text: [],
      };
      continue;
    }
    if (trimmed === "") {
      flush();
      continue;
    }
    if (!current) {
      // WEBVTT header, X-TIMESTAMP-MAP, NOTE blocks, cue identifiers.
      continue;
    }
    current.text.push(trimmed);
  }
  flush();
  return cues;
}

function parseTimestampLine(
  line: string,
): { start: number; end: number; settings: string } | null {
  if (!line.includes("-->")) return null;

  const full = FULL_TIME_RE.exec(line);
  if (full) {
    return {
      start: timestampMS(full[1]!, full[2]!, full[3]!, full[4]!),
      end: timestampMS(full[5]!, full[6]!, full[7]!, full[8]!),
      settings: (full[9] ?? "").trim(),
    };
  }

  const short = SHORT_TIME_RE.exec(line);
  if (short) {
    return {
      start: timestampMS("0", short[1]!, short[2]!, short[3]!),
      end: timestampMS("0", short[4]!, short[5]!, short[6]!),
      settings: (short[7] ?? "").trim(),
    };
  }
  return null;
}

function timestampMS(hours: string, minutes: string, seconds: string, fraction: string): number {
  const h = Number.parseInt(hours, 10) || 0;
  const m = Number.parseInt(minutes, 10) || 0;
  const s = Number.parseInt(seconds, 10) || 0;
  let frac = 0;
  if (fraction) {
    const value = Number.parseInt(fraction, 10) || 0;
    switch (fraction.length) {
      case 1:
        frac = value * 100;
        break;
      case 2:
        frac = value * 10;
        break;
      default:
        frac = value;
        break;
    }
  }
  return ((h * 60 + m) * 60 + s) * 1000 + frac;
}

function trimText(lines: string[]): string[] {
  return lines.map((line) => line.trim()).filter((line) => line !== "");
}

/**
 * Sort cues and remove duplicates, mirroring the Kodi/Go behaviour. Cue
 * settings are deliberately excluded from the duplicate key; empty cues are
 * kept because Pluto uses them to clear captions between runs.
 */
export function cleanCues(cues: Cue[]): Cue[] {
  cues.sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end));
  const out: Cue[] = [];
  const seen = new Set<string>();
  for (const original of cues) {
    const cue = { ...original };
    if (cue.start < 0) cue.start = 0;
    if (cue.end <= cue.start) continue;
    const key = `${cue.start}|${cue.end}|${cue.text.join("\n")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cue);
  }
  return out;
}

/** A half-open interval on Pluto's original, ad-inclusive timeline (ms). */
export interface Window {
  start: number;
  end: number;
}

/**
 * Map captions from Pluto's original timeline onto the ad-free timeline.
 *
 * A cue starting inside a removed ad window is dropped. Every other cue is
 * shifted left by the total length of windows that end at or before its start.
 * Settings and text are preserved verbatim.
 */
export function rebaseAfterAds(
  cues: readonly Cue[],
  windows: readonly Window[],
): Cue[] {
  if (windows.length === 0) return cues.map((cue) => ({ ...cue }));

  const ordered = [...windows].sort((a, b) =>
    a.start !== b.start ? a.start - b.start : a.end - b.end,
  );
  const out: Cue[] = [];
  let next = 0;
  let deducted = 0;

  for (const original of cues) {
    while (next < ordered.length && ordered[next]!.end <= original.start) {
      const window = ordered[next]!;
      deducted += window.end - window.start;
      next++;
    }

    const window = ordered[next];
    if (window && window.start <= original.start && original.start < window.end) {
      continue;
    }

    const cue: Cue = {
      ...original,
      start: original.start - deducted,
      end: original.end - deducted,
    };
    if (cue.end <= cue.start) continue;
    out.push(cue);
  }
  return out;
}

/** Render cues as a standalone WebVTT document. */
export function renderVtt(cues: readonly Cue[]): string {
  const parts: string[] = ["WEBVTT\n\n"];
  for (const cue of cues) {
    parts.push(formatTime(cue.start), " --> ", formatTime(cue.end));
    if (cue.settings) parts.push(" ", cue.settings);
    parts.push("\n");
    for (const line of cue.text) parts.push(line, "\n");
    parts.push("\n");
  }
  return parts.join("");
}

/** Format milliseconds as HH:MM:SS.mmm. */
export function formatTime(ms: number): string {
  let value = Math.max(0, Math.trunc(ms));
  const h = Math.floor(value / 3_600_000);
  value -= h * 3_600_000;
  const m = Math.floor(value / 60_000);
  value -= m * 60_000;
  const s = Math.floor(value / 1000);
  value -= s * 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(value, 3)}`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** Return the end time of the last cue in milliseconds. */
export function durationMS(cues: readonly Cue[]): number {
  let end = 0;
  for (const cue of cues) {
    if (cue.end > end) end = cue.end;
  }
  return end;
}
