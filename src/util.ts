/** Small shared helpers for the Worker. */

export function firstHeaderValue(value: string | null): string {
  if (!value) return "";
  const comma = value.indexOf(",");
  return (comma >= 0 ? value.slice(0, comma) : value).trim();
}

/** Validate an IPv4 or IPv6 address before echoing it into X-Forwarded-For. */
export function isIP(value: string): boolean {
  const input = value.trim();
  if (!input) return false;
  return isIPv4(input) || isIPv6(input);
}

function isIPv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (part.length > 1 && part.startsWith("0")) return false;
    const number = Number(part);
    return number >= 0 && number <= 255;
  });
}

function isIPv6(value: string): boolean {
  if (!value.includes(":")) return false;
  if (!/^[0-9a-fA-F:]+$/.test(value)) return false;
  if ((value.match(/::/g) ?? []).length > 1) return false;
  const groups = value.split(":").filter(Boolean);
  if (groups.length > 8) return false;
  return groups.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group));
}

export function resolveXff(request: Request, url: URL, fallback: string): string {
  const candidates = [
    url.searchParams.get("xff") ?? "",
    firstHeaderValue(request.headers.get("X-Forwarded-For")),
    fallback,
  ];
  for (const candidate of candidates) {
    if (isIP(candidate)) return candidate.trim();
  }
  return "";
}

export function toInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(String(value ?? ""));
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export function parseBool(value: unknown): boolean {
  return String(value ?? "").trim().toLowerCase() === "true";
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  async function run(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => run()));
  return results;
}

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  Vary: "Origin",
};

export function jsonResponse(payload: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(CORS_HEADERS);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  if (extra) {
    new Headers(extra).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(payload), { status, headers });
}

export function textResponse(
  body: string,
  contentType: string,
  cacheControl = "no-store",
  status = 200,
): Response {
  const headers = new Headers(CORS_HEADERS);
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", cacheControl);
  headers.set("Content-Length", String(new TextEncoder().encode(body).byteLength));
  return new Response(body, { status, headers });
}

export function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: message }, status);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
