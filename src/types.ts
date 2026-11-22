import type { Range } from "./hls/cleaner";

export interface Env {
  SESSIONS: DurableObjectNamespace;
  SUBS: KVNamespace;

  PLUTO_XFF?: string;
  PLUTO_COUNTRY?: string;
  PLUTO_USER_AGENT?: string;
  PUBLIC_URL?: string;
  SESSION_TTL_SECONDS?: string;
  SUBTITLE_CACHE_TTL_SECONDS?: string;
  SUBTITLE_CONCURRENCY?: string;
  SUBTITLE_BATCH_SIZE?: string;
  SUBREQUEST_BUDGET?: string;
  SUBTITLE_FETCH_ATTEMPTS?: string;
  ALLOWED_UPSTREAM_HOSTS?: string;
  ALLOW_ANY_UPSTREAM?: string;
  /** Development only: allow localhost/private upstream hosts. */
  ALLOW_PRIVATE_UPSTREAM?: string;
}

export interface SessionMeta {
  id: string;
  mediaId: string;
  masterUrl: string;
  xff: string;
  country: string;
  created: number;
}

export type SubtitleStatus = "idle" | "running" | "done" | "error" | "none";

export interface SubtitleState {
  status: SubtitleStatus;
  key?: string;
  playlistUrl?: string;
  duration?: number;
  cueCount?: number;
  contentDuration?: number;
  created?: number;
  error?: string;
  failedSegments?: number;
}

export interface VariantRecord {
  text: string;
  duration: number;
  segmentCount: number;
  adSegments: number;
  adRanges: Range[];
  created: number;
}
