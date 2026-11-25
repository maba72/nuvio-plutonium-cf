import { beforeEach, describe, expect, it, vi } from "vitest";

const bootSession = vi.hoisted(() => vi.fn());
const fetchTextWithHeaders = vi.hoisted(() => vi.fn());

vi.mock("../src/pluto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pluto")>();
  return { ...actual, bootSession, fetchTextWithHeaders };
});

import { parseGeneralStreamId, resolvePlutoMediaId } from "../src/resolve";
import { upstreamConfig } from "../src/pluto";
import type { Json } from "../src/catalog";
import type { Env } from "../src/types";

function fakeEnv(apiKey = "test-key") {
  const store = new Map<string, string>();
  const env = {
    TMDB_API_KEY: apiKey,
    SUBS: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    },
  } as unknown as Env;
  return { env, store };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockPluto(rows: Json[], details: Json[]) {
  fetchTextWithHeaders.mockImplementation(async (url: string) => {
    if (url.includes("/v1/search")) return JSON.stringify({ data: rows });
    if (url.includes("/v4/vod/slugs")) {
      const slugs = new URL(url).searchParams.get("slugs")?.split(",") ?? [];
      return JSON.stringify(details.filter((item) => slugs.includes(String(item.slug))));
    }
    throw new Error(`unexpected Pluto URL: ${url}`);
  });
}

function mockTmdb(details: Record<string, Json>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const match = /\/3\/(movie|tv)\/(\d+)/.exec(url);
    if (match && details[match[2]!]) return jsonResponse(details[match[2]!]);
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("parseGeneralStreamId", () => {
  it("parses TMDb and IMDb ids with optional episode coordinates", () => {
    expect(parseGeneralStreamId("tmdb:597", "movie")).toEqual({
      kind: "movie",
      source: "tmdb",
      id: "597",
      season: null,
      episode: null,
    });
    expect(parseGeneralStreamId("tmdb:1399:1:2", "series")).toEqual({
      kind: "series",
      source: "tmdb",
      id: "1399",
      season: 1,
      episode: 2,
    });
    expect(parseGeneralStreamId("tt0903747:3:4", "series")).toEqual({
      kind: "series",
      source: "imdb",
      id: "tt0903747",
      season: 3,
      episode: 4,
    });
    expect(parseGeneralStreamId("movie:597", "movie")?.id).toBe("597");
    expect(parseGeneralStreamId("series:1399:1:2", "series")?.kind).toBe("series");
  });

  it("rejects ids from other providers or without a numeric/IMDb token", () => {
    expect(parseGeneralStreamId("pluto:movie:abc", "movie")).toBeNull();
    expect(parseGeneralStreamId("kitsu:123", "series")).toBeNull();
    expect(parseGeneralStreamId("anilist:123", "series")).toBeNull();
    expect(parseGeneralStreamId("mal:123", "series")).toBeNull();
    expect(parseGeneralStreamId("tt0903747/1/2", "series")).toMatchObject({
      kind: "series",
      source: "imdb",
      id: "tt0903747",
      season: 1,
      episode: 2,
    });
  });
});

describe("resolvePlutoMediaId", () => {
  beforeEach(() => {
    bootSession.mockReset();
    fetchTextWithHeaders.mockReset();
    vi.unstubAllGlobals();
    bootSession.mockResolvedValue({
      token: "token",
      stitcher: "https://stitcher.example",
      stitcherParams: "",
      search: "https://search.example",
      vod: "https://vod.example",
    });
  });

  it("matches a movie by TMDb title/year even when Pluto's slug year is wrong", async () => {
    const { env, store } = fakeEnv();
    const config = upstreamConfig(env, "74.83.52.188", "US");
    const fetchMock = mockTmdb({
      "603": {
        id: 603,
        title: "The Matrix",
        original_title: "The Matrix",
        release_date: "1999-03-31",
        alternative_titles: { titles: [] },
      },
    });
    mockPluto(
      [{ id: "row-1", slug: "the-matrix-1991-1-1", name: "The Matrix", type: "movie" }],
      [
        {
          _id: "media-603",
          slug: "the-matrix-1991-1-1",
          name: "The Matrix",
          type: "movie",
          clip: { originalReleaseDate: "1999-03-31T00:00:00Z" },
        },
      ],
    );

    await expect(resolvePlutoMediaId(env, config, "tmdb:603", "movie")).resolves.toBe(
      "media-603",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchTextWithHeaders).toHaveBeenCalledTimes(2);
    expect([...store.keys()]).toEqual(["resolve:movie:tmdb:603:x:x:US:74.83.52.188"]);

    // The second lookup is served from KV without another TMDb/Pluto request.
    await expect(resolvePlutoMediaId(env, config, "tmdb:603", "movie")).resolves.toBe(
      "media-603",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchTextWithHeaders).toHaveBeenCalledTimes(2);
  });

  it("selects the series that actually contains the requested episode", async () => {
    const { env } = fakeEnv();
    const config = upstreamConfig(env, "74.83.52.188", "US");
    mockTmdb({
      "126027": {
        id: 126027,
        name: "Ghosts",
        original_name: "Ghosts",
        first_air_date: "2021-10-07",
        alternative_titles: { results: [] },
      },
    });
    mockPluto(
      [
        { id: "row-a", slug: "ghosts-cbs-rolling-4", name: "Ghosts", type: "series" },
        { id: "row-b", slug: "ghosts-ptv6", name: "Ghosts", type: "series" },
      ],
      [
        {
          _id: "series-cbs",
          slug: "ghosts-cbs-rolling-4",
          name: "Ghosts",
          type: "series",
          seasons: [
            {
              number: 6,
              episodes: [{ _id: "ep-6-1", name: "Halloween", number: 1 }],
            },
          ],
        },
        {
          _id: "series-ptv",
          slug: "ghosts-ptv6",
          name: "Ghosts",
          type: "series",
          seasons: [
            {
              number: 1,
              episodes: [
                { _id: "ep-1-1", name: "Pilot", number: 1 },
                { _id: "ep-1-2", name: "Hello!", number: 2 },
              ],
            },
          ],
        },
      ],
    );

    await expect(
      resolvePlutoMediaId(env, config, "tmdb:126027:1:2", "series"),
    ).resolves.toBe("ep-1-2");
  });

  it("does nothing without a TMDb key", async () => {
    const { env } = fakeEnv("");
    const config = upstreamConfig(env, "", "US");
    await expect(resolvePlutoMediaId(env, config, "tmdb:597", "movie")).resolves.toBe("");
    expect(bootSession).not.toHaveBeenCalled();
    expect(fetchTextWithHeaders).not.toHaveBeenCalled();
  });

  it("returns an empty id when no Pluto candidate matches", async () => {
    const { env } = fakeEnv();
    const config = upstreamConfig(env, "74.83.52.188", "US");
    mockTmdb({
      "999999": {
        id: 999999,
        title: "Not On Pluto",
        original_title: "Not On Pluto",
        release_date: "2020-01-01",
        alternative_titles: { titles: [] },
      },
    });
    mockPluto([], []);

    await expect(resolvePlutoMediaId(env, config, "tmdb:999999", "movie")).resolves.toBe("");
  });
});
