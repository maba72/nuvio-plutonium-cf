import { describe, expect, it } from "vitest";
import { firstHeaderValue, isIP, mapLimit, resolveXff, sha256Hex, toInt } from "../src/util";

describe("isIP", () => {
  it("accepts valid IPv4 and IPv6 without leading zeros", () => {
    expect(isIP("74.83.52.188")).toBe(true);
    expect(isIP("::1")).toBe(true);
    expect(isIP("2001:db8::1")).toBe(true);
    expect(isIP("01.2.3.4")).toBe(false);
    expect(isIP("999.1.1.1")).toBe(false);
    expect(isIP("not-an-ip")).toBe(false);
  });
});

describe("resolveXff", () => {
  it("prefers a valid query parameter", () => {
    const request = new Request("https://worker/x?xff=1.2.3.4", {
      headers: { "X-Forwarded-For": "5.6.7.8, 10.0.0.1" },
    });
    expect(resolveXff(request, new URL(request.url), "9.9.9.9")).toBe("1.2.3.4");
  });

  it("falls back to the header and then the environment", () => {
    const request = new Request("https://worker/x", {
      headers: { "X-Forwarded-For": "5.6.7.8, 10.0.0.1" },
    });
    expect(resolveXff(request, new URL(request.url), "9.9.9.9")).toBe("5.6.7.8");
    expect(resolveXff(new Request("https://worker/x"), new URL("https://worker/x"), "9.9.9.9")).toBe(
      "9.9.9.9",
    );
  });

  it("ignores invalid values", () => {
    const request = new Request("https://worker/x?xff=bad", {
      headers: { "X-Forwarded-For": "also-bad" },
    });
    expect(resolveXff(request, new URL(request.url), "9.9.9.9")).toBe("9.9.9.9");
    expect(resolveXff(new Request("https://worker/x"), new URL("https://worker/x"), "")).toBe("");
  });
});

describe("firstHeaderValue", () => {
  it("returns the first comma-separated value", () => {
    expect(firstHeaderValue("1.2.3.4, 5.6.7.8")).toBe("1.2.3.4");
    expect(firstHeaderValue(null)).toBe("");
  });
});

describe("sha256Hex", () => {
  it("is stable and 64 characters", async () => {
    const value = await sha256Hex("abc");
    expect(value).toHaveLength(64);
    expect(value).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("toInt", () => {
  it("parses and falls back", () => {
    expect(toInt("42", 1)).toBe(42);
    expect(toInt("nope", 7)).toBe(7);
    expect(toInt(3.9, 0)).toBe(3);
  });
});

describe("mapLimit", () => {
  it("processes items with bounded concurrency and preserves order", async () => {
    let active = 0;
    let peak = 0;
    const result = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (value) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return value * 2;
    });
    expect(result).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
