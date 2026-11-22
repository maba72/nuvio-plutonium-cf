/**
 * Pluto master playlist parsing and rewriting.
 *
 * Port of the master handling in nuvio-plutonium/internal/hls/session.go.
 */

export interface MasterVariant {
  attributes: string;
  url: string;
}

export interface SubtitleRendition {
  uri: string;
  language: string;
  name: string;
}

export interface HlsMaster {
  variants: MasterVariant[];
  subtitle: SubtitleRendition | null;
}

const AUDIO_ATTR_RE = /(^|,)\s*AUDIO="[^"]*"/i;
const SUBS_ATTR_RE = /(^|,)\s*SUBTITLES="[^"]*"/i;

export function parseMaster(text: string, masterURL: string): HlsMaster {
  let base: URL | null = null;
  try {
    base = new URL(masterURL);
  } catch {
    base = null;
  }

  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const master: HlsMaster = { variants: [], subtitle: null };
  let subtitleCandidate: SubtitleRendition | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-MEDIA:")) {
      const attributes = parseAttributes(line.slice("#EXT-X-MEDIA:".length));
      if ((attributes.TYPE ?? "").toUpperCase() === "SUBTITLES" && attributes.URI) {
        let uri = attributes.URI;
        if (base) {
          try {
            uri = new URL(uri, base).toString();
          } catch {
            // Keep the original URI.
          }
        }
        uri = ensureJwt(uri, masterURL);
        const candidate: SubtitleRendition = {
          uri,
          language: attributes.LANGUAGE ?? "",
          name: attributes.NAME ?? "",
        };
        // Prefer an English rendition, but keep the first candidate otherwise.
        if (!subtitleCandidate || isEnglish(candidate)) {
          subtitleCandidate = candidate;
        }
      }
      continue;
    }

    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;

    const attributes = line.slice("#EXT-X-STREAM-INF:".length).trim();
    let next = index + 1;
    while (next < lines.length) {
      const candidate = lines[next]!.trim();
      if (candidate !== "" && !candidate.startsWith("#")) break;
      next++;
    }
    if (next >= lines.length) continue;

    let uri = lines[next]!.trim();
    if (base) {
      try {
        uri = new URL(uri, base).toString();
      } catch {
        // Keep the original URI.
      }
    }
    uri = ensureJwt(uri, masterURL);
    master.variants.push({ attributes, url: uri });
    index = next;
  }

  master.subtitle = subtitleCandidate;
  if (master.variants.length === 0) {
    throw new Error("master playlist had no variants");
  }
  return master;
}

/**
 * Render the cleaned master. `prefix` is prepended to our relative URIs; it is
 * empty for /hls/<session>/master.m3u8 and "/hls/<session>/" for the Python
 * proxy-compatible /master.m3u8?url=... endpoint.
 */
export function renderMaster(
  master: HlsMaster,
  includeSubtitles: boolean,
  prefix = "",
): string {
  if (master.variants.length === 0) {
    throw new Error("no playable variants");
  }
  const base = prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
  const out: string[] = ["#EXTM3U", "#EXT-X-VERSION:5"];

  if (includeSubtitles && master.subtitle) {
    const language = master.subtitle.language.trim().toLowerCase().startsWith("en")
      ? master.subtitle.language.trim().toLowerCase()
      : "en";
    out.push(
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI="${base}subs.m3u8",LANGUAGE="${language.replace(/"/g, "")}"`,
    );
  }

  for (let index = 0; index < master.variants.length; index++) {
    const variant = master.variants[index]!;
    let attributes = stripAttribute(variant.attributes, AUDIO_ATTR_RE);
    attributes = stripAttribute(attributes, SUBS_ATTR_RE);
    if (includeSubtitles && master.subtitle) {
      if (attributes !== "") attributes += ",";
      attributes += 'SUBTITLES="subs"';
    }
    out.push(`#EXT-X-STREAM-INF:${attributes}`);
    out.push(`${base}v/${index}.m3u8`);
  }

  return out.join("\n") + "\n";
}

function stripAttribute(attributes: string, pattern: RegExp): string {
  let value = attributes.replace(pattern, "$1");
  while (value.includes(",,")) value = value.replaceAll(",,", ",");
  return value.replace(/^[,\s]+|[,\s]+$/g, "").trim();
}

/** Parse comma-separated HLS attributes, respecting quoted values. */
export function parseAttributes(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  let remaining = value;

  while (remaining.length > 0) {
    remaining = remaining.replace(/^[,\s]+/, "");
    if (!remaining) break;

    const equals = remaining.indexOf("=");
    if (equals < 0) break;

    const key = remaining.slice(0, equals).trim().toUpperCase();
    remaining = remaining.slice(equals + 1);

    let val: string;
    if (remaining.startsWith('"')) {
      remaining = remaining.slice(1);
      const end = remaining.indexOf('"');
      if (end < 0) {
        val = remaining;
        remaining = "";
      } else {
        val = remaining.slice(0, end);
        remaining = remaining.slice(end + 1);
      }
    } else {
      const end = remaining.indexOf(",");
      if (end < 0) {
        val = remaining;
        remaining = "";
      } else {
        val = remaining.slice(0, end);
        remaining = remaining.slice(end + 1);
      }
    }

    if (key) out[key] = val.trim();
  }
  return out;
}

/** Copy the master URL's jwt query parameter onto a resolved child URL. */
export function ensureJwt(rawURL: string, masterURL: string): string {
  let target: URL;
  try {
    target = new URL(rawURL);
  } catch {
    return rawURL;
  }
  if (target.searchParams.get("jwt")) return target.toString();

  let master: URL;
  try {
    master = new URL(masterURL);
  } catch {
    return target.toString();
  }
  const token = master.searchParams.get("jwt");
  if (!token) return target.toString();
  target.searchParams.set("jwt", token);
  return target.toString();
}

function isEnglish(rendition: SubtitleRendition): boolean {
  const language = rendition.language.trim().toLowerCase();
  if (language === "en" || language.startsWith("en-") || language.startsWith("en_")) {
    return true;
  }
  return rendition.name.toLowerCase().includes("english");
}
