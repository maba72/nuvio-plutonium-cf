/** Shared playback-session creation used by /session and the addon /stream endpoint. */

import type { Env } from "./types";
import { randomId } from "./util";

export interface SessionInput {
  masterUrl: string;
  mediaId: string;
  xff: string;
  country: string;
}

/**
 * Initialise a Durable Object playback session and return its 32-hex id.
 * Pass `id` to make a session deterministic (used by the Python proxy compat
 * endpoint); otherwise a fresh random id is generated.
 */
export async function createHlsSession(
  env: Env,
  input: SessionInput,
  id: string = randomId(),
): Promise<string> {
  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(id));
  const response = await stub.fetch(
    new Request("https://session/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...input }),
    }),
  );
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(detail || `session init failed (HTTP ${response.status})`);
  }
  // Consume the body so the DO request completes cleanly.
  await response.text();
  // Return immediately. The DO schedules its own subtitle alarm, and the
  // subs.m3u8/subs.vtt handlers make bounded progress on demand. Waiting for a
  // whole movie's captions here made /stream take up to ~100s on a cold cache,
  // so Nuvio showed the Pluto provider only after that delay.
  return id;
}

/**
 * Drive a long subtitle job to completion across Durable Object invocations.
 * DO/KV calls count against the generous internal-service budget, while each
 * step's upstream chunk fetches stay under the 50-subrequest external cap.
 */
export async function driveSubtitles(
  env: Env,
  id: string,
  maxRounds = 100,
): Promise<string> {
  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(id));
  // Three concurrent DO steps multiply Pluto fetch throughput while keeping
  // each DO invocation under the free plan's 50 external subrequests.
  const parallelSteps = 3;
  let status = "idle";
  for (let round = 0; round < maxRounds; round++) {
    const responses = await Promise.all(
      Array.from({ length: parallelSteps }, () =>
        stub.fetch(new Request("https://session/subtitle/step")),
      ),
    );
    for (const response of responses) {
      if (!response.ok) {
        const detail = (await response.text()).trim();
        throw new Error(detail || `subtitle step failed (HTTP ${response.status})`);
      }
      const data = (await response.json()) as { subtitles?: string };
      status = data.subtitles ?? "idle";
    }
    if (status === "done" || status === "none" || status === "error") return status;
  }
  return status;
}
