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
  return id;
}
