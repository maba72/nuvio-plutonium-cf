import type { Range } from "./hls/cleaner";
import { absolutize, stripAds } from "./hls/cleaner";
import type { HlsMaster } from "./hls/master";
import { parseMaster, renderMaster } from "./hls/master";
import type { SubtitleSegment } from "./hls/subtitles";
import { parseSubtitleSegments } from "./hls/subtitles";
import type { UpstreamConfig } from "./pluto";
import { fetchText, isAllowedUpstream, masterUrlForMedia, upstreamConfig } from "./pluto";
import type { Env, SessionMeta, SubtitleState, VariantRecord } from "./types";
import {
  errorMessage,
  jsonResponse,
  mapLimit,
  sha256Hex,
  textResponse,
  toInt,
} from "./util";
import type { Cue, Window } from "./vtt";
import { cleanCues, durationMS, parseVtt, rebaseAfterAds, renderVtt } from "./vtt";

interface InitBody {
  id?: string;
  masterUrl?: string;
  mediaId?: string;
  xff?: string;
  country?: string;
}

interface VariantRow {
  text: string;
  duration: number;
  segment_count: number;
  ad_segments: number;
  ad_ranges: string;
  created: number;
}

interface SegmentRow {
  idx: number;
  url: string;
  offset_ms: number;
  duration: number;
}

interface RebasedTrack {
  key: string;
  text: string;
  duration: number;
  cueCount: number;
}

interface CachedSubtitleMetadata {
  duration?: number;
  cueCount?: number;
  created?: number;
}

/**
 * One Durable Object per playback session.
 *
 * Holds the parsed master, cleaned variant playlists, and the subtitle
 * generation job. SQLite-backed storage survives hibernation; the alarm
 * handler resumes long subtitle jobs in fresh invocations.
 */
export class SessionDurableObject implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  private meta: SessionMeta | null = null;
  private master: HlsMaster | null = null;
  private subtitle: SubtitleState | null = null;
  private config: UpstreamConfig | null = null;
  private rebasedTrack: RebasedTrack | null = null;
  private canonicalVtt: string | null = null;
  private canonicalKey: string | null = null;

  private readonly ready: Promise<void>;
  private schemaReady = false;
  private schemaPromise: Promise<void> | null = null;
  private subtitleJob: Promise<void> | null = null;
  private subtitleStart: Promise<void> | null = null;
  private readonly variantJobs = new Map<number, Promise<VariantRecord>>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    this.ready = this.state.blockConcurrencyWhile(async () => {
      await this.ensureSchema();

      this.meta = (await this.state.storage.get<SessionMeta>("meta")) ?? null;
      this.master = (await this.state.storage.get<HlsMaster>("master")) ?? null;
      this.subtitle = (await this.state.storage.get<SubtitleState>("sub")) ?? null;
      if (this.meta) {
        this.config = upstreamConfig(this.env, this.meta.xff, this.meta.country);
      }
    });
  }

  /**
   * `deleteAll()` drops every SQLite table, so the schema must be recreated if
   * this instance stays alive after a cleanup. This is idempotent and cheap.
   */
  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    if (this.schemaPromise) return this.schemaPromise;
    this.schemaPromise = (async () => {
      this.state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS variants (
          idx INTEGER PRIMARY KEY,
          text TEXT NOT NULL,
          duration REAL NOT NULL,
          segment_count INTEGER NOT NULL,
          ad_segments INTEGER NOT NULL,
          ad_ranges TEXT NOT NULL,
          created INTEGER NOT NULL
        )
      `);
      this.state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS sub_segments (
          idx INTEGER PRIMARY KEY,
          url TEXT NOT NULL,
          offset_ms INTEGER NOT NULL,
          duration REAL NOT NULL,
          processed INTEGER NOT NULL DEFAULT 0
        )
      `);
      this.state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS sub_results (
          idx INTEGER PRIMARY KEY,
          cues TEXT NOT NULL
        )
      `);
      this.schemaReady = true;
    })().finally(() => {
      this.schemaPromise = null;
    });
    await this.schemaPromise;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await this.ready;
      await this.ensureSchema();
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (request.method === "POST" && path === "/init") {
        return await this.handleInit(request);
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return jsonResponse({ error: "method not allowed" }, 405);
      }
      if (!this.meta) {
        return jsonResponse({ error: "session is not initialized" }, 404);
      }
      if (this.isExpired()) {
        await this.expire();
        return jsonResponse({ error: "session expired" }, 404);
      }

      if (path === "/master.m3u8" || path === "/master") {
        return this.handleMaster(url);
      }
      if (path === "/subs.m3u8") {
        return await this.handleSubtitlePlaylist();
      }
      if (path === "/subs.vtt") {
        return await this.handleSubtitleVtt();
      }
      if (path.startsWith("/v/")) {
        return await this.handleVariant(path);
      }
      if (path === "/health") {
        return this.handleHealth();
      }
      return jsonResponse({ error: "not found" }, 404);
    } catch (error) {
      console.error("session request failed", error);
      return jsonResponse({ error: errorMessage(error) }, 502);
    }
  }

  async alarm(): Promise<void> {
    await this.ready;
    await this.ensureSchema();
    if (!this.meta) {
      this.schemaReady = false;
      await this.state.storage.deleteAll();
      return;
    }
    if (this.isExpired()) {
      await this.expire();
      return;
    }

    await this.runSubtitleJob();
    if (!this.meta) return;

    if (this.subtitle?.status === "running" && this.hasUnprocessedSegments()) {
      await this.scheduleAlarm(1000);
      return;
    }
    await this.setTtlAlarm();
  }

  private async handleInit(request: Request): Promise<Response> {
    if (this.meta) {
      return jsonResponse({ ok: true, id: this.meta.id, existing: true });
    }

    let body: InitBody;
    try {
      body = (await request.json()) as InitBody;
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }

    const xff = typeof body.xff === "string" ? body.xff.trim() : "";
    const country =
      typeof body.country === "string" && body.country.trim()
        ? body.country.trim().toUpperCase()
        : this.env.PLUTO_COUNTRY || "US";
    const config = upstreamConfig(this.env, xff, country);

    let masterUrl =
      typeof body.masterUrl === "string" && body.masterUrl.trim()
        ? body.masterUrl.trim()
        : "";
    const mediaId = typeof body.mediaId === "string" ? body.mediaId.trim() : "";

    if (!masterUrl) {
      if (!mediaId) return jsonResponse({ error: "mediaId or masterUrl is required" }, 400);
      masterUrl = await masterUrlForMedia(mediaId, config);
    }

    if (!isAllowedUpstream(masterUrl, config.extraAllowedHosts, config.allowAnyUpstream, config.allowPrivateUpstream)) {
      return jsonResponse({ error: "master URL host is not allowed" }, 400);
    }

    const text = await fetchText(masterUrl, config, 25_000);
    const master = parseMaster(text, masterUrl);

    this.config = config;
    this.master = master;
    this.meta = {
      id: typeof body.id === "string" && body.id.trim() ? body.id.trim() : this.state.id.toString(),
      mediaId,
      masterUrl,
      xff: config.xff,
      country: config.country,
      created: Date.now(),
    };
    this.subtitle = null;
    this.rebasedTrack = null;
    this.canonicalVtt = null;
    this.canonicalKey = null;

    await this.state.storage.put({ meta: this.meta, master: this.master });
    await this.state.storage.delete("sub");

    if (master.subtitle) {
      await this.scheduleAlarm(1000);
    } else {
      await this.setTtlAlarm();
    }

    return jsonResponse({
      ok: true,
      id: this.meta.id,
      variants: master.variants.length,
      subtitles: Boolean(master.subtitle),
    });
  }

  private handleMaster(url: URL): Response {
    if (!this.master) return jsonResponse({ error: "master not initialized" }, 500);
    let prefix = url.searchParams.get("prefix") ?? "";
    if (!prefix.startsWith("/hls/") || prefix.includes("..")) prefix = "";
    const includeSubtitles =
      Boolean(this.master.subtitle) &&
      this.subtitle?.status !== "none" &&
      this.subtitle?.status !== "error";
    return textResponse(
      renderMaster(this.master, includeSubtitles, prefix),
      "application/vnd.apple.mpegurl",
      "no-store",
    );
  }

  private async handleVariant(path: string): Promise<Response> {
    const raw = path.slice("/v/".length).replace(/\.m3u8$/i, "");
    const index = Number.parseInt(raw, 10);
    if (!Number.isFinite(index) || String(index) !== raw) {
      return jsonResponse({ error: "invalid variant index" }, 404);
    }
    const variant = await this.getVariant(index);
    return textResponse(variant.text, "application/vnd.apple.mpegurl", "no-store");
  }

  private getVariant(index: number): Promise<VariantRecord> {
    if (!this.master || index < 0 || index >= this.master.variants.length) {
      return Promise.reject(new Error(`variant ${index} not found`));
    }

    const rows = this.state.storage.sql
      .exec(
        "SELECT text, duration, segment_count, ad_segments, ad_ranges, created FROM variants WHERE idx = ?",
        index,
      )
      .toArray() as unknown as VariantRow[];
    const row = rows[0];
    if (row) {
      return Promise.resolve({
        text: row.text,
        duration: Number(row.duration),
        segmentCount: Number(row.segment_count),
        adSegments: Number(row.ad_segments),
        adRanges: safeParseRanges(row.ad_ranges),
        created: Number(row.created),
      });
    }

    const existing = this.variantJobs.get(index);
    if (existing) return existing;

    const job = this.loadVariant(index).finally(() => {
      this.variantJobs.delete(index);
    });
    this.variantJobs.set(index, job);
    return job;
  }

  private async loadVariant(index: number): Promise<VariantRecord> {
    if (!this.master || !this.config) throw new Error("session is not initialized");
    const source = this.master.variants[index]?.url;
    if (!source) throw new Error(`variant ${index} not found`);

    const playlist = await fetchText(source, this.config, 25_000);
    const cleaned = stripAds(absolutize(playlist, source));
    const record: VariantRecord = {
      text: cleaned.text,
      duration: cleaned.duration,
      segmentCount: cleaned.segmentCount,
      adSegments: cleaned.adSegments,
      adRanges: cleaned.adRanges,
      created: Date.now(),
    };

    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO variants (idx, text, duration, segment_count, ad_segments, ad_ranges, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
      index,
      record.text,
      record.duration,
      record.segmentCount,
      record.adSegments,
      JSON.stringify(record.adRanges),
      record.created,
    );
    return record;
  }

  private async handleSubtitlePlaylist(): Promise<Response> {
    const track = await this.getRebasedTrack();
    if (
      !track &&
      (!this.subtitle ||
        this.subtitle.status === "none" ||
        this.subtitle.status === "error")
    ) {
      return jsonResponse({ error: "subtitle track unavailable" }, 404);
    }
    const duration =
      track?.duration ??
      (this.subtitle?.status === "done" ? this.subtitle.duration : undefined) ??
      this.subtitle?.contentDuration ??
      1;
    const target = Math.max(1, Math.ceil(duration));
    const playlist =
      `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n` +
      `#EXT-X-TARGETDURATION:${target}\n#EXT-X-MEDIA-SEQUENCE:0\n` +
      `#EXTINF:${duration.toFixed(3)},\nsubs.vtt\n#EXT-X-ENDLIST\n`;
    return textResponse(playlist, "application/vnd.apple.mpegurl", "no-store");
  }

  private async handleSubtitleVtt(): Promise<Response> {
    const track = await this.getRebasedTrack();
    if (track) {
      return textResponse(track.text, "text/vtt; charset=utf-8", "public, max-age=3600");
    }
    return textResponse("WEBVTT\n\n", "text/vtt; charset=utf-8", "no-store");
  }

  /**
   * Return the canonical KV track retimed to this session's ad-free video
   * timeline. KV always stores the original-timeline merge so the same cached
   * captions can be reused when a title is played with different ad breaks.
   */
  private async getRebasedTrack(): Promise<RebasedTrack | null> {
    await this.runSubtitleJob();
    const key = this.subtitle?.key;
    if (this.subtitle?.status !== "done" || !key) return null;
    if (this.rebasedTrack?.key === key) return this.rebasedTrack;

    // Reuse freshly generated text in this invocation; KV is eventually
    // consistent, so avoid reading our own write immediately.
    const canonical =
      this.canonicalKey === key && this.canonicalVtt
        ? this.canonicalVtt
        : await this.env.SUBS.get(`subs/${key}.vtt`, "text");
    if (!canonical) return null;

    let windows: Window[] = [];
    try {
      const variant = await this.getVariant(0);
      windows = variant.adRanges
        .filter((range) => range.end > range.start)
        .map((range) => ({
          start: Math.round(range.start * 1000),
          end: Math.round(range.end * 1000),
        }));
    } catch (error) {
      // Captions on the original timeline are still better than none.
      console.warn("ad rebase unavailable, serving original captions", {
        error: errorMessage(error),
      });
    }

    const rebased = rebaseAfterAds(parseVtt(canonical, 0), windows);
    const rebasedDuration = durationMS(rebased);
    const track: RebasedTrack = {
      key,
      text: renderVtt(rebased),
      duration: rebasedDuration > 0 ? rebasedDuration / 1000 : this.subtitle.duration ?? 0,
      cueCount: rebased.length,
    };
    this.rebasedTrack = track;
    return track;
  }

  private handleHealth(): Response {
    const variants = this.state.storage.sql
      .exec("SELECT COUNT(*) AS n FROM variants")
      .toArray() as unknown as { n: number }[];
    return jsonResponse({
      ok: true,
      created: this.meta?.created ?? 0,
      variants: Number(variants[0]?.n ?? 0),
      subtitles: this.subtitle?.status ?? "idle",
    });
  }

  private ensureSubtitleStarted(): Promise<void> {
    if (this.subtitleStart) return this.subtitleStart;
    this.subtitleStart = this.doEnsureSubtitleStarted().finally(() => {
      this.subtitleStart = null;
    });
    return this.subtitleStart;
  }

  private async doEnsureSubtitleStarted(): Promise<void> {
    if (!this.master || !this.config || !this.meta) {
      throw new Error("session is not initialized");
    }
    if (!this.master.subtitle) {
      if (this.subtitle?.status !== "none") {
        this.subtitle = { status: "none" };
        await this.saveSubtitle();
      }
      return;
    }
    if (
      this.subtitle &&
      (this.subtitle.status === "running" ||
        this.subtitle.status === "done" ||
        this.subtitle.status === "none" ||
        this.subtitle.status === "error")
    ) {
      return;
    }

    const playlistUrl = this.master.subtitle.uri;
    const mediaKey = this.meta.mediaId || this.meta.masterUrl;
    const key = await subtitleCacheKey(mediaKey, playlistUrl);

    const cacheKey = `subs/${key}.vtt`;
    const cached = await this.env.SUBS.getWithMetadata<CachedSubtitleMetadata>(cacheKey, "text");
    if (cached.value && this.cacheFresh(cached.metadata)) {
      const metadata = cached.metadata ?? {};
      this.subtitle = {
        status: "done",
        key,
        playlistUrl,
        duration: Number(metadata.duration ?? 0) || 0,
        cueCount: Number(metadata.cueCount ?? 0) || 0,
        created: Number(metadata.created ?? 0) || Date.now(),
      };
      this.canonicalVtt = null;
      this.canonicalKey = null;
      await this.saveSubtitle();
      return;
    }
    if (cached.value) {
      try {
        await this.env.SUBS.delete(cacheKey);
      } catch {
        // A stale value will be overwritten at the end of generation.
      }
    }

    const attempts = Math.max(1, toInt(this.env.SUBTITLE_FETCH_ATTEMPTS, 1));
    const playlist = await fetchText(playlistUrl, this.config, 30_000, attempts);
    const parsed = parseSubtitleSegments(playlist, playlistUrl);
    if (parsed.segments.length === 0) {
      this.subtitle = { status: "none", key, playlistUrl };
      await this.saveSubtitle();
      return;
    }

    this.insertSegments(parsed.segments);
    this.subtitle = {
      status: "running",
      key,
      playlistUrl,
      contentDuration: parsed.contentDuration,
      created: Date.now(),
    };
    await this.saveSubtitle();
    await this.scheduleAlarm(1000);
  }

  private runSubtitleJob(): Promise<void> {
    if (this.subtitleJob) return this.subtitleJob;
    this.subtitleJob = this.doRunSubtitleJob()
      .catch(async (error) => {
        console.error("subtitle job failed", error);
        if (this.subtitle) {
          this.subtitle.status = "error";
          this.subtitle.error = errorMessage(error);
          await this.saveSubtitle();
        }
        await this.setTtlAlarm();
      })
      .finally(() => {
        this.subtitleJob = null;
      });
    return this.subtitleJob;
  }

  private async doRunSubtitleJob(): Promise<void> {
    await this.ensureSubtitleStarted();
    if (!this.subtitle || this.subtitle.status !== "running") return;
    if (!this.config) throw new Error("session is not initialized");
    if (this.isExpired()) {
      await this.expire();
      return;
    }

    const concurrency = Math.max(1, toInt(this.env.SUBTITLE_CONCURRENCY, 6));
    const batchSize = Math.max(1, toInt(this.env.SUBTITLE_BATCH_SIZE, 16));
    const budget = Math.max(1, toInt(this.env.SUBREQUEST_BUDGET, 16));
    const attempts = Math.max(1, toInt(this.env.SUBTITLE_FETCH_ATTEMPTS, 1));
    let used = 0;

    while (true) {
      if (this.isExpired()) {
        await this.expire();
        return;
      }

      const rows = this.state.storage.sql
        .exec(
          "SELECT idx, url, offset_ms, duration FROM sub_segments WHERE processed = 0 ORDER BY idx LIMIT ?",
          batchSize,
        )
        .toArray() as unknown as SegmentRow[];

      if (rows.length === 0) {
        await this.assembleSubtitles();
        return;
      }

      let failed = 0;
      const results = await mapLimit(rows, concurrency, async (row) => {
        try {
          const body = await fetchText(row.url, this.config!, 20_000, attempts);
          return { idx: Number(row.idx), cues: parseVtt(body, Number(row.offset_ms)) };
        } catch (error) {
          failed++;
          console.warn("subtitle segment failed", {
            idx: row.idx,
            error: errorMessage(error),
          });
          return { idx: Number(row.idx), cues: [] as Cue[] };
        }
      });

      for (const result of results) {
        this.state.storage.sql.exec(
          "INSERT OR REPLACE INTO sub_results (idx, cues) VALUES (?, ?)",
          result.idx,
          JSON.stringify(result.cues),
        );
      }

      const placeholders = rows.map(() => "?").join(",");
      this.state.storage.sql.exec(
        `UPDATE sub_segments SET processed = 1 WHERE idx IN (${placeholders})`,
        ...rows.map((row) => Number(row.idx)),
      );

      if (failed > 0 && this.subtitle) {
        this.subtitle.failedSegments = (this.subtitle.failedSegments ?? 0) + failed;
        await this.saveSubtitle();
      }

      used += rows.length;
      if (used >= budget && this.hasUnprocessedSegments()) {
        await this.scheduleAlarm(1000);
        return;
      }
    }
  }

  private async assembleSubtitles(): Promise<void> {
    const rows = this.state.storage.sql
      .exec("SELECT cues FROM sub_results ORDER BY idx")
      .toArray() as unknown as { cues: string }[];

    const all: Cue[] = [];
    for (const row of rows) {
      try {
        const cues = JSON.parse(row.cues) as Cue[];
        if (Array.isArray(cues)) all.push(...cues);
      } catch {
        // Ignore a corrupt partial result.
      }
    }

    const cleaned = cleanCues(all);
    const text = renderVtt(cleaned);
    const cueDuration = durationMS(cleaned) / 1000;
    const contentDuration = this.subtitle?.contentDuration ?? 0;
    const duration = Math.max(contentDuration, cueDuration) || cueDuration || 1;
    const key = this.subtitle?.key;
    if (!key) throw new Error("subtitle cache key missing");

    await this.env.SUBS.put(`subs/${key}.vtt`, text, {
      expirationTtl: Math.max(60, toInt(this.env.SUBTITLE_CACHE_TTL_SECONDS, 604_800)),
      metadata: {
        duration,
        cueCount: cleaned.length,
        created: Date.now(),
      },
    });
    this.canonicalVtt = text;
    this.canonicalKey = key;

    this.subtitle = {
      ...this.subtitle,
      status: "done",
      duration,
      cueCount: cleaned.length,
      created: Date.now(),
    };
    await this.saveSubtitle();

    this.state.storage.sql.exec("DELETE FROM sub_segments");
    this.state.storage.sql.exec("DELETE FROM sub_results");
    await this.setTtlAlarm();
  }

  private insertSegments(segments: SubtitleSegment[]): void {
    this.state.storage.sql.exec("DELETE FROM sub_segments");
    this.state.storage.sql.exec("DELETE FROM sub_results");

    const chunkSize = 100;
    for (let start = 0; start < segments.length; start += chunkSize) {
      const chunk = segments.slice(start, start + chunkSize);
      const values = chunk.map(() => "(?, ?, ?, ?, 0)").join(", ");
      const args = chunk.flatMap((segment, offset) => [
        start + offset,
        segment.url,
        segment.offsetMS,
        segment.duration,
      ]);
      this.state.storage.sql.exec(
        `INSERT INTO sub_segments (idx, url, offset_ms, duration, processed) VALUES ${values}`,
        ...args,
      );
    }
  }

  private saveSubtitle(): Promise<void> {
    return this.state.storage.put("sub", this.subtitle);
  }

  private hasUnprocessedSegments(): boolean {
    const rows = this.state.storage.sql
      .exec("SELECT COUNT(*) AS n FROM sub_segments WHERE processed = 0")
      .toArray() as unknown as { n: number }[];
    return Number(rows[0]?.n ?? 0) > 0;
  }

  private isExpired(): boolean {
    return Boolean(this.meta && Date.now() > this.meta.created + this.sessionTtlMs());
  }

  private async expire(): Promise<void> {
    this.meta = null;
    this.master = null;
    this.subtitle = null;
    this.rebasedTrack = null;
    this.canonicalVtt = null;
    this.canonicalKey = null;
    this.schemaReady = false;
    await this.state.storage.deleteAll();
  }

  private sessionTtlMs(): number {
    return Math.max(60, toInt(this.env.SESSION_TTL_SECONDS, 86_400)) * 1000;
  }

  private subtitleCacheTtlMs(): number {
    return Math.max(60, toInt(this.env.SUBTITLE_CACHE_TTL_SECONDS, 604_800)) * 1000;
  }

  private cacheFresh(metadata: CachedSubtitleMetadata | null): boolean {
    if (!metadata) return false;
    const created = Number(metadata.created ?? 0);
    if (!Number.isFinite(created) || created <= 0) return false;
    return Date.now() - created <= this.subtitleCacheTtlMs();
  }

  private async scheduleAlarm(delayMs: number): Promise<void> {
    const target = Date.now() + Math.max(1, delayMs);
    const current = await this.state.storage.getAlarm();
    if (current === null || target < current) {
      await this.state.storage.setAlarm(target);
    }
  }

  private async setTtlAlarm(): Promise<void> {
    if (!this.meta) return;
    const target = this.meta.created + this.sessionTtlMs();
    if (target <= Date.now()) {
      await this.expire();
      return;
    }
    await this.state.storage.setAlarm(target);
  }
}

async function subtitleCacheKey(mediaKey: string, playlistUrl: string): Promise<string> {
  let path = playlistUrl;
  try {
    path = new URL(playlistUrl).pathname;
  } catch {
    // Keep the full URL if it is not parseable.
  }
  return (await sha256Hex(`v2|${mediaKey}|${path}`)).slice(0, 32);
}

function safeParseRanges(value: string): Range[] {
  try {
    const parsed = JSON.parse(value) as Range[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
