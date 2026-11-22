import { describe, expect, it } from "vitest";
import {
  buildMasterUrl,
  isAllowedUpstream,
  upstreamConfig,
  type BootSession,
} from "../src/pluto";

describe("buildMasterUrl", () => {
  const boot: BootSession = {
    token: "token-123",
    stitcher: "https://cfd-v4-service-channel-stitcher-use1-1.prd.pluto.tv",
    stitcherParams: "deviceType=web&country=US&jwt=old",
  };

  it("builds a stitcher URL and overrides the jwt", () => {
    const url = new URL(buildMasterUrl(boot, "abc/def"));
    expect(url.host).toBe("cfd-v4-service-channel-stitcher-use1-1.prd.pluto.tv");
    expect(url.pathname).toBe("/v2/stitch/hls/episode/abc%2Fdef/master.m3u8");
    expect(url.searchParams.get("deviceType")).toBe("web");
    expect(url.searchParams.get("country")).toBe("US");
    expect(url.searchParams.get("jwt")).toBe("token-123");
    expect(url.searchParams.get("masterJWTPassthrough")).toBe("1");
  });

  it("accepts a bare stitcher host", () => {
    const url = new URL(
      buildMasterUrl({ ...boot, stitcher: "stitcher.example/", stitcherParams: "" }, "1"),
    );
    expect(url.host).toBe("stitcher.example");
  });
});

describe("isAllowedUpstream", () => {
  it("allows Pluto hosts", () => {
    expect(
      isAllowedUpstream(
        "https://cfd-v4-service-channel-stitcher-use1-1.prd.pluto.tv/master.m3u8",
      ),
    ).toBe(true);
    expect(isAllowedUpstream("https://siloh-ns1.plutotv.net/seg.ts")).toBe(true);
  });

  it("blocks lookalikes, LAN, and non-http schemes", () => {
    expect(isAllowedUpstream("https://evilpluto.tv/")).toBe(false);
    expect(isAllowedUpstream("http://192.168.1.1/")).toBe(false);
    expect(isAllowedUpstream("http://127.0.0.1/")).toBe(false);
    expect(isAllowedUpstream("ftp://pluto.tv/seg.ts")).toBe(false);
  });

  it("honours extra host patterns", () => {
    const extra = ["example.com", "*.example.net"];
    expect(isAllowedUpstream("https://example.com/a.m3u8", extra)).toBe(true);
    expect(isAllowedUpstream("https://cdn.example.net/a.m3u8", extra)).toBe(true);
    expect(isAllowedUpstream("https://cdn.example.org/a.m3u8", extra)).toBe(false);
  });

  it("only allows private hosts in explicit development mode", () => {
    expect(isAllowedUpstream("http://127.0.0.1:8788/a.m3u8", [], false, true)).toBe(true);
    expect(isAllowedUpstream("http://127.0.0.1:8788/a.m3u8", [], true, false)).toBe(false);
  });
});

describe("upstreamConfig", () => {
  it("merges env defaults and explicit values", () => {
    const config = upstreamConfig(
      {
        PLUTO_XFF: "9.9.9.9",
        PLUTO_COUNTRY: "gb",
        ALLOWED_UPSTREAM_HOSTS: "example.com, *.example.net",
        ALLOW_ANY_UPSTREAM: "true",
      },
      "1.2.3.4",
    );
    expect(config.xff).toBe("1.2.3.4");
    expect(config.country).toBe("GB");
    expect(config.extraAllowedHosts).toEqual(["example.com", "*.example.net"]);
    expect(config.allowAnyUpstream).toBe(true);
    expect(config.allowPrivateUpstream).toBe(false);
  });
});
