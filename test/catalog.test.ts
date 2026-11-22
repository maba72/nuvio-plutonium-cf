import { describe, expect, it } from "vitest";
import {
  catalogItem,
  findCategory,
  findItem,
  metaForItem,
  searchItems,
  seriesMeta,
  streamMediaId,
  type Json,
} from "../src/catalog";
import { addonManifest, CATALOG_ROWS } from "../src/addon";

const movie: Json = {
  _id: "42",
  type: "movie",
  name: "Test Movie",
  releaseDate: "2019-04-01T00:00:00Z",
  duration: 5_400_000,
  rating: "PG-13",
  genre: "Action",
  summary: "A test summary.",
  covers: [
    { aspectRatio: "347:500", url: "https://images.pluto.tv/poster.jpg" },
    { aspectRatio: "16:9", url: "https://images.pluto.tv/backdrop.jpg" },
  ],
  clip: {
    actors: [{ name: "Actor A" }],
    directors: [{ fullName: "Director B" }],
  },
};

const series: Json = {
  _id: "7",
  type: "series",
  name: "Test Series",
  genre: ["Drama", "Comedy"],
};

const data: Json = {
  categories: [
    { name: "Most Popular Movies", items: [movie, series] },
    { name: "Top Titles", items: [movie] },
  ],
};

describe("catalog helpers", () => {
  it("converts a Pluto item into a Nuvio meta preview", () => {
    const meta = catalogItem(movie, "movie");
    expect(meta).toMatchObject({
      id: "pluto:movie:42",
      type: "movie",
      name: "Test Movie",
      poster: "https://images.pluto.tv/poster.jpg",
      background: "https://images.pluto.tv/backdrop.jpg",
      description: "A test summary.",
      genres: ["Action"],
      releaseInfo: "2019",
      ageRating: "PG-13",
      runtime: "90 min",
    });
  });

  it("finds categories case-insensitively and items by Pluto id", () => {
    expect(findCategory(data, "most popular movies")).toHaveLength(2);
    expect(findItem(data, "7")?.name).toBe("Test Series");
    expect(findItem(data, "missing")).toBeNull();
  });

  it("ranks search results and deduplicates by id", () => {
    const results = searchItems(data, "test movie", 80);
    expect(results[0]?.id).toBe("pluto:movie:42");
    expect(searchItems(data, "drama")[0]?.id).toBe("pluto:series:7");
    expect(searchItems(data, "  ")).toEqual([]);
  });

  it("builds movie metadata with cast and director", () => {
    const meta = metaForItem(movie, "movie");
    expect(meta.cast).toEqual(["Actor A"]);
    expect(meta.director).toEqual(["Director B"]);
  });

  it("builds series metadata with sorted episodes", () => {
    const seasons: Json = {
      seasons: [
        {
          number: 2,
          episodes: [{ _id: "e2", name: "Second", number: 1, releaseDate: "2021-01-01" }],
        },
        {
          number: 1,
          episodes: [{ _id: "e1", name: "Pilot", number: 2, releaseDate: "2020-01-01" }],
        },
      ],
    };
    const meta = seriesMeta(series, seasons);
    expect(meta.videos).toHaveLength(2);
    expect((meta.videos as Json[]).map((video) => video.id)).toEqual([
      "pluto:episode:e1",
      "pluto:episode:e2",
    ]);
    expect((meta.behaviorHints as Json).defaultVideoId).toBe("pluto:episode:e1");
    expect(meta.releaseInfo).toBe("2020");
  });

  it("extracts stream media ids only from Pluto prefixes", () => {
    expect(streamMediaId("pluto:movie:42")).toBe("42");
    expect(streamMediaId("pluto:episode:e1")).toBe("e1");
    expect(streamMediaId("other:42")).toBe("");
  });
});

describe("addon manifest", () => {
  it("has the required id and all seven catalog rows", () => {
    const manifest = addonManifest();
    expect(manifest.id).toBe("org.maba.pluto-catalog");
    expect(manifest.catalogs).toHaveLength(7);
    expect(CATALOG_ROWS.every((row) => row.id.startsWith("pluto-"))).toBe(true);
    expect(manifest.resources).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "stream" })]),
    );
  });
});
