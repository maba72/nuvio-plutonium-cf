import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchText = vi.hoisted(() => vi.fn());
vi.mock("../src/pluto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pluto")>();
  return { ...actual, fetchText };
});

import { fetchCategories } from "../src/pluto-catalog";
import { upstreamConfig } from "../src/pluto";
import type { Env } from "../src/types";

function fakeEnv() {
  const store = new Map<string, string>();
  const env = {
    SUBS: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    },
  } as unknown as Env;
  return { env, store };
}

function categoriesBody(count: number): string {
  const items = Array.from({ length: count }, (_, index) => ({
    _id: `item-${index}`,
    name: `Item ${index}`,
    type: "movie",
  }));
  return JSON.stringify({ categories: [{ name: "Most Popular Movies", items }] });
}

describe("fetchCategories cache", () => {
  beforeEach(() => {
    fetchText.mockReset();
  });

  it("does not cache an empty Pluto response", async () => {
    const { env, store } = fakeEnv();
    fetchText.mockResolvedValueOnce(categoriesBody(0)).mockResolvedValueOnce(categoriesBody(1));
    const config = upstreamConfig(env, "1.2.3.4", "US");

    const first = (await fetchCategories(env, config)) as {
      categories: { items: unknown[] }[];
    };
    const second = (await fetchCategories(env, config)) as {
      categories: { items: unknown[] }[];
    };
    expect(first.categories[0]!.items).toHaveLength(0);
    expect(second.categories[0]!.items).toHaveLength(1);
    expect(fetchText).toHaveBeenCalledTimes(2);
    expect([...store.keys()]).toEqual(["catalog:categories:US:1.2.3.4"]);
    expect(JSON.parse([...store.values()][0]!).categories[0].items).toHaveLength(1);
  });

  it("separates caches by X-Forwarded-For", async () => {
    const { env, store } = fakeEnv();
    fetchText
      .mockResolvedValueOnce(categoriesBody(0))
      .mockResolvedValueOnce(categoriesBody(2));
    const nonUS = upstreamConfig(env, "", "US");
    const us = upstreamConfig(env, "74.83.52.188", "US");

    const nonUSData = (await fetchCategories(env, nonUS)) as {
      categories: { items: unknown[] }[];
    };
    const usData = (await fetchCategories(env, us)) as { categories: { items: unknown[] }[] };
    expect(nonUSData.categories[0]!.items).toHaveLength(0);
    expect(usData.categories[0]!.items).toHaveLength(2);
    expect(fetchText).toHaveBeenCalledTimes(2);
    expect([...store.keys()]).toEqual(["catalog:categories:US:74.83.52.188"]);
  });
});
