/**
 * Pluto subtitle playlist parsing.
 *
 * Port of nuvio-plutonium/internal/hls/subtitles.go. Pluto's subtitle
 * renditions are chunked: each VTT file covers one chunk, and the chunk's
 * start offset is encoded in the URL path. We fetch the chunks, parse them
 * with that offset, merge/dedupe the cues, and serve one WebVTT track.
 */

export interface SubtitleSegment {
  url: string;
  offsetMS: number;
  duration: number;
}

export interface ParsedSubtitlePlaylist {
  segments: SubtitleSegment[];
  contentDuration: number;
  skipped: number;
}

const EXTINF_RE = /^#EXTINF:\s*([0-9.]+)/;
const PLACEHOLDER_RE = /\/playout\/placeholder\/subtitles\//i;
const CHUNK_RE = /\/(\d+)-(\d+|end)\/(hls\/)?(text_en_cc|en-cc|en)\//i;

export function parseSubtitleSegments(
  playlist: string,
  playlistURL: string,
): ParsedSubtitlePlaylist {
  let base: URL | null = null;
  try {
    base = new URL(playlistURL);
  } catch {
    base = null;
  }

  const lines = playlist.replaceAll("\r\n", "\n").split("\n");
  const segments: SubtitleSegment[] = [];
  let pendingDuration = 0;
  let contentDuration = 0;
  let skipped = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") continue;

    if (line.startsWith("#EXTINF")) {
      const match = EXTINF_RE.exec(line);
      pendingDuration = match ? Number.parseFloat(match[1]!) || 0 : 0;
      continue;
    }
    if (line.startsWith("#")) continue;

    let segmentURL = line;
    if (base) {
      try {
        segmentURL = new URL(line, base).toString();
      } catch {
        // Keep the original URL.
      }
    }

    if (PLACEHOLDER_RE.test(segmentURL)) {
      // Ad placeholder: drop the segment and its duration.
      pendingDuration = 0;
      continue;
    }

    const offsetMS = chunkOffsetMS(segmentURL);
    if (offsetMS === null) {
      // Pluto also emits empty filler VTTs that carry no captions but are part
      // of the subtitle timeline. Keep their duration so the served track
      // matches the video, but do not try to parse them at offset zero.
      contentDuration += pendingDuration;
      pendingDuration = 0;
      skipped++;
      continue;
    }

    segments.push({ url: segmentURL, offsetMS, duration: pendingDuration });
    contentDuration += pendingDuration;
    pendingDuration = 0;
  }

  return { segments, contentDuration, skipped };
}

export function chunkOffsetMS(segmentURL: string): number | null {
  const match = CHUNK_RE.exec(segmentURL);
  if (!match) return null;
  const offset = Number.parseInt(match[1]!, 10);
  return Number.isFinite(offset) ? offset : null;
}
