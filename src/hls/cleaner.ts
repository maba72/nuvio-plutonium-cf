/**
 * Pluto HLS playlist cleaning.
 *
 * Port of nuvio-plutonium/internal/hls/cleaner.go. Ad segments are dropped
 * together with their buffered EXTINF/KEY/MAP/DISCONTINUITY tags, and segment
 * URIs are left pointing at Pluto's CDN (no media bytes pass through us).
 */

export interface Range {
  start: number;
  end: number;
}

export interface CleanResult {
  text: string;
  adRanges: Range[];
  duration: number;
  segmentCount: number;
  adSegments: number;
}

const EXTINF_RE = /^#EXTINF:\s*([0-9.]+)/;
const AD_RE =
  /(\/1_ad\/creative\/|plutotv_kidsbumpers|plutotv_filler|_ad(?:\/|%2F|_bumper)|dai\.google\.com)/i;
const URI_ATTR_RE = /URI="([^"]*)"/g;
const TARGET_DURATION_RE = /^#EXT-X-TARGETDURATION:\s*([0-9]+)/m;

/**
 * Remove Pluto's SSAI ad segments from a media playlist.
 *
 * Pluto marks VOD ads with #EXT-X-KEY:METHOD=NONE and/or an ad-specific URL.
 * As in the Go implementation, an unencrypted playlist is treated as a shape
 * this cleaner does not understand and is passed through rather than risking
 * removal of real content.
 */
export function stripAds(playlist: string): CleanResult {
  const source = playlist.replace(/^\uFEFF/, "");
  if (!source.includes("METHOD=AES-128")) {
    return passthrough(source);
  }

  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const out: string[] = [];
  let pending: string[] = [];
  let cursor = 0;
  let adStart = 0;
  let adActive = false;
  let lastWasAd = false;
  let noneRegion = false;
  let pendingDur = 0;
  let maxDur = 0;
  let duration = 0;
  let segments = 0;
  let adSegments = 0;
  const adRanges: Range[] = [];

  const flushPending = () => {
    if (pending.length === 0) return;
    out.push(...pending);
    pending = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r+$/, "");
    const trimmed = line.trim();
    if (trimmed === "") continue;

    if (trimmed.startsWith("#EXT-X-KEY:")) {
      const upper = trimmed.toUpperCase();
      if (upper.includes("METHOD=NONE")) {
        noneRegion = true;
      } else if (upper.includes("METHOD=AES-128")) {
        noneRegion = false;
      }
      pending.push(trimmed);
      continue;
    }

    if (trimmed.startsWith("#EXTINF")) {
      const match = EXTINF_RE.exec(trimmed);
      pendingDur = match ? Number.parseFloat(match[1]!) || 0 : 0;
      pending.push(trimmed);
      continue;
    }

    if (trimmed.startsWith("#EXT-X-DISCONTINUITY")) {
      // A discontinuity immediately after a stripped ad belongs to the
      // ad/content boundary and must not survive.
      if (lastWasAd) continue;
      pending.push(trimmed);
      continue;
    }

    if (
      trimmed.startsWith("#EXT-X-MAP:") ||
      trimmed.startsWith("#EXT-X-BYTERANGE") ||
      trimmed.startsWith("#EXT-X-GAP")
    ) {
      pending.push(trimmed);
      continue;
    }

    if (trimmed.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      pending.push(trimmed);
      continue;
    }

    if (
      trimmed.startsWith("#EXT-X-CUE-OUT") ||
      trimmed.startsWith("#EXT-X-CUE-IN") ||
      trimmed.startsWith("#EXT-X-ENDLIST")
    ) {
      continue;
    }

    // Pluto-specific trailer metadata is not needed by the player.
    if (trimmed.startsWith("#PLUTO-")) continue;

    if (trimmed.startsWith("#")) {
      out.push(trimmed);
      continue;
    }

    // Media segment.
    if (noneRegion || AD_RE.test(trimmed)) {
      pending = [];
      if (!adActive) {
        adActive = true;
        adStart = cursor;
      }
      cursor += pendingDur;
      pendingDur = 0;
      lastWasAd = true;
      adSegments++;
      continue;
    }

    flushPending();
    out.push(trimmed);
    if (adActive) {
      adRanges.push({ start: adStart, end: cursor });
      adActive = false;
    }
    if (pendingDur > maxDur) maxDur = pendingDur;
    duration += pendingDur;
    cursor += pendingDur;
    pendingDur = 0;
    lastWasAd = false;
    segments++;
  }

  flushPending();
  if (adActive) adRanges.push({ start: adStart, end: cursor });

  if (out.length > 0 && out[0] !== "#EXTM3U") out.unshift("#EXTM3U");

  let joined = out.join("\n");
  if (!joined.includes("#EXT-X-PLAYLIST-TYPE:")) {
    joined = insertAfterFirst(joined, "#EXT-X-PLAYLIST-TYPE:VOD");
  }

  if (maxDur > 0) {
    const needed = Math.ceil(maxDur);
    const match = TARGET_DURATION_RE.exec(joined);
    if (match) {
      const current = Number.parseInt(match[1]!, 10) || 0;
      if (current < needed) {
        joined = joined.replace(TARGET_DURATION_RE, `#EXT-X-TARGETDURATION:${needed}`);
      }
    } else {
      joined = insertAfterFirst(joined, `#EXT-X-TARGETDURATION:${needed}`);
    }
  }

  joined = joined.replace(/\n+$/, "") + "\n#EXT-X-ENDLIST\n";
  return { text: joined, adRanges, duration, segmentCount: segments, adSegments };
}

function passthrough(playlist: string): CleanResult {
  const lines = playlist.replaceAll("\r\n", "\n").split("\n");
  const out: string[] = [];
  let duration = 0;
  let segments = 0;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r+$/, "");
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#EXT-X-ENDLIST")) continue;
    if (trimmed.startsWith("#PLUTO-")) continue;

    const match = EXTINF_RE.exec(trimmed);
    if (match) {
      duration += Number.parseFloat(match[1]!) || 0;
    }
    if (!trimmed.startsWith("#")) segments++;
    out.push(trimmed);
  }

  const joined = out.join("\n").replace(/\n+$/, "") + "\n#EXT-X-ENDLIST\n";
  return { text: joined, adRanges: [], duration, segmentCount: segments, adSegments: 0 };
}

function insertAfterFirst(playlist: string, line: string): string {
  if (playlist.startsWith("#EXTM3U")) {
    const newline = playlist.indexOf("\n");
    if (newline >= 0) return playlist.slice(0, newline + 1) + line + "\n" + playlist.slice(newline + 1);
    return playlist + "\n" + line;
  }
  return line + "\n" + playlist;
}

/** Resolve relative segment and URI attributes against baseURL. */
export function absolutize(playlist: string, baseURL: string): string {
  const base = baseURL.trim();
  if (!base) return playlist;

  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    return playlist;
  }

  const lines = playlist.replaceAll("\r\n", "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index]!.replace(/\r+$/, "").trim();
    if (trimmed === "") {
      lines[index] = "";
      continue;
    }
    if (trimmed.startsWith("#")) {
      if (trimmed.includes('URI="')) {
        lines[index] = trimmed.replace(URI_ATTR_RE, (attribute, uri: string) => {
          return `URI="${resolveURL(baseUrl, uri)}"`;
        });
      } else {
        lines[index] = trimmed;
      }
      continue;
    }
    lines[index] = resolveURL(baseUrl, trimmed);
  }
  return lines.join("\n");
}

function resolveURL(base: URL, reference: string): string {
  const trimmed = reference.trim();
  if (!trimmed) return trimmed;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return trimmed;
  }
}
