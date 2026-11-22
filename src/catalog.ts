/** Pure TypeScript port of the Go catalog/meta helpers. */

export type Json = Record<string, unknown>;

const YEAR_RE = /(19|20)\d{2}/;

function asMap(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function asSlice(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function idString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function floatValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function numberValue(value: unknown): number | string | null {
  const parsed = floatValue(value);
  if (parsed === null) return null;
  return Number.isInteger(parsed) ? parsed : String(parsed);
}

function intValue(value: unknown): number {
  return floatValue(value) ?? 0;
}

function firstNonEmpty(...values: string[]): string {
  return values.find((value) => value.trim() !== "") ?? "";
}

function imageUrl(value: unknown): string {
  if (typeof value === "string") return value;
  const map = asMap(value);
  if (!map) return "";
  return firstNonEmpty(asString(map.path), asString(map.url));
}

function coverUrl(item: Json, aspect: string): string {
  for (const raw of asSlice(item.covers)) {
    const cover = asMap(raw);
    if (cover && asString(cover.aspectRatio) === aspect) {
      const url = asString(cover.url);
      if (url) return url;
    }
  }
  return "";
}

function posterFor(item: Json): string {
  return firstNonEmpty(
    coverUrl(item, "347:500"),
    imageUrl(item.featuredImage),
    imageUrl(item.poster16_9),
  );
}

function backgroundFor(item: Json): string {
  return firstNonEmpty(
    coverUrl(item, "16:9"),
    imageUrl(item.featuredImage),
    imageUrl(item.poster16_9),
  );
}

function genresFor(item: Json): string[] {
  const genre = item.genre;
  if (typeof genre === "string") return genre.trim() ? [genre.trim()] : [];
  if (Array.isArray(genre)) {
    return genre.filter((entry): entry is string => typeof entry === "string" && entry !== "");
  }
  return [];
}

function peopleFor(item: Json, key: string): string[] {
  const clip = asMap(item.clip);
  if (!clip) return [];
  const out: string[] = [];
  for (const raw of asSlice(clip[key])) {
    const person = asMap(raw);
    const name = person
      ? firstNonEmpty(asString(person.name), asString(person.fullName))
      : asString(raw);
    if (name) out.push(name);
  }
  return out;
}

function firstYear(item: Json): string {
  const clip = asMap(item.clip);
  const values: unknown[] = [];
  if (clip) values.push(clip.originalReleaseDate);
  values.push(item.releaseDate, item.slug);
  for (const value of values) {
    const match = YEAR_RE.exec(asString(value));
    if (match) return match[0];
  }
  return "";
}

function itemYear(item: Json): string {
  const own = firstYear(item);
  if (own) return own;
  const years: number[] = [];
  for (const rawSeason of asSlice(item.seasons)) {
    const season = asMap(rawSeason);
    if (!season) continue;
    for (const rawEpisode of asSlice(season.episodes)) {
      const episode = asMap(rawEpisode);
      if (!episode) continue;
      const year = firstYear(episode);
      if (year) years.push(Number(year));
    }
  }
  return years.length ? String(Math.min(...years)) : "";
}

function runtimeMinutes(value: unknown): string {
  const milliseconds = floatValue(value);
  if (milliseconds === null || milliseconds <= 0) return "";
  return `${Math.round(milliseconds / 60_000)} min`;
}

function ratingFor(item: Json): string {
  const value = item.rating;
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function itemId(item: Json): string {
  return idString(item._id);
}

function prefixFor(mediaType: string): string {
  return mediaType === "series" ? "pluto:series:" : "pluto:movie:";
}

export function catalogItem(item: Json, mediaType: string): Json | null {
  const plutoId = itemId(item);
  const name = asString(item.name);
  if (!plutoId || !name) return null;

  const result: Json = {
    id: prefixFor(mediaType) + plutoId,
    type: mediaType,
    name,
    poster: posterFor(item),
    background: backgroundFor(item),
    description: firstNonEmpty(asString(item.summary), asString(item.description)),
    genres: genresFor(item),
    posterShape: "poster",
  };
  const year = itemYear(item);
  if (year) result.releaseInfo = year;
  const rating = ratingFor(item);
  if (rating) result.ageRating = rating;
  const runtime = runtimeMinutes(item.duration);
  if (runtime) result.runtime = runtime;
  return result;
}

export function findCategory(data: Json, name: string): Json[] {
  for (const raw of asSlice(data.categories)) {
    const category = asMap(raw);
    if (category && asString(category.name).toLowerCase() === name.toLowerCase()) {
      return asSlice(category.items).filter((item): item is Json => asMap(item) !== null);
    }
  }
  return [];
}

export function findItem(data: Json, plutoId: string): Json | null {
  for (const rawCategory of asSlice(data.categories)) {
    const category = asMap(rawCategory);
    if (!category) continue;
    for (const rawItem of asSlice(category.items)) {
      const item = asMap(rawItem);
      if (item && itemId(item) === plutoId) return item;
    }
  }
  return null;
}

function searchScore(query: string, meta: Json): number {
  const name = asString(meta.name).toLowerCase();
  if (name === query) return 100;
  if (name.startsWith(query)) return 80;
  if (name.includes(query)) return 60;
  for (const genre of Array.isArray(meta.genres) ? meta.genres : []) {
    if (typeof genre === "string" && genre.toLowerCase().includes(query)) return 40;
  }
  if (asString(meta.description).toLowerCase().includes(query)) return 20;
  return 0;
}

export function searchItems(data: Json, query: string, limit = 80): Json[] {
  const needle = query.trim().toLowerCase();
  if (!needle || limit <= 0) return [];

  const hits: Array<{ meta: Json; score: number }> = [];
  const seen = new Set<string>();
  for (const rawCategory of asSlice(data.categories)) {
    const category = asMap(rawCategory);
    if (!category) continue;
    for (const rawItem of asSlice(category.items)) {
      const item = asMap(rawItem);
      if (!item) continue;
      const itemType = asString(item.type);
      if (itemType !== "movie" && itemType !== "series") continue;
      const meta = catalogItem(item, itemType);
      if (!meta) continue;
      const id = asString(meta.id);
      if (!id || seen.has(id)) continue;
      const score = searchScore(needle, meta);
      if (score <= 0) continue;
      seen.add(id);
      hits.push({ meta, score });
    }
  }

  hits.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return asString(a.meta.name).toLowerCase().localeCompare(asString(b.meta.name).toLowerCase());
  });
  return hits.slice(0, limit).map((hit) => hit.meta);
}

export function metaForItem(item: Json, mediaType: string): Json {
  const meta: Json = {
    id: prefixFor(mediaType) + itemId(item),
    type: mediaType,
    name: firstNonEmpty(asString(item.name), "Untitled"),
    poster: posterFor(item),
    background: backgroundFor(item),
    description: firstNonEmpty(asString(item.description), asString(item.summary)),
    genres: genresFor(item),
    cast: peopleFor(item, "actors"),
    director: peopleFor(item, "directors"),
  };
  const year = itemYear(item);
  if (year) meta.releaseInfo = year;
  const rating = ratingFor(item);
  if (rating) meta.ageRating = rating;
  const runtime = runtimeMinutes(item.duration);
  if (runtime) meta.runtime = runtime;
  return meta;
}

export function episodeMeta(rawEpisode: unknown): Json | null {
  const episode = asMap(rawEpisode);
  if (!episode) return null;
  const plutoId = itemId(episode);
  if (!plutoId) return null;

  const result: Json = {
    id: `pluto:episode:${plutoId}`,
    title: firstNonEmpty(asString(episode.name), "Episode"),
    overview: firstNonEmpty(asString(episode.description), asString(episode.summary)),
    thumbnail: firstNonEmpty(posterFor(episode), backgroundFor(episode)),
  };
  const season = numberValue(episode.season);
  if (season !== null) result.season = season;
  const number = numberValue(episode.number);
  if (number !== null) result.episode = number;
  const year = firstYear(episode);
  if (year) result.released = year;
  const runtime = runtimeMinutes(episode.duration);
  if (runtime) result.runtime = runtime;
  return result;
}

export function seriesMeta(item: Json, seasonsData: Json): Json {
  const meta = metaForItem(item, "series");
  const videos: Json[] = [];
  const years: number[] = [];

  for (const rawSeason of asSlice(seasonsData.seasons)) {
    const season = asMap(rawSeason);
    if (!season) continue;
    const seasonNumber = floatValue(season.number);
    for (const rawEpisode of asSlice(season.episodes)) {
      const episode = asMap(rawEpisode);
      if (!episode) continue;
      if (episode.season === undefined || episode.season === null) {
        episode.season = seasonNumber ?? 0;
      }
      const video = episodeMeta(episode);
      if (!video) continue;
      videos.push(video);
      const year = firstYear(episode);
      if (year) years.push(Number(year));
    }
  }

  videos.sort((a, b) => {
    const seasonDiff = intValue(a.season) - intValue(b.season);
    if (seasonDiff !== 0) return seasonDiff;
    return intValue(a.episode) - intValue(b.episode);
  });

  if (videos.length > 0) {
    meta.videos = videos;
    const behavior = asMap(meta.behaviorHints) ?? {};
    behavior.defaultVideoId = videos[0]!.id;
    meta.behaviorHints = behavior;
  }
  if (meta.releaseInfo === undefined && years.length > 0) {
    meta.releaseInfo = String(Math.min(...years));
  }
  return meta;
}

export function streamMediaId(rawId: string): string {
  for (const prefix of ["pluto:movie:", "pluto:episode:"]) {
    if (rawId.startsWith(prefix) && rawId.length > prefix.length) {
      return rawId.slice(prefix.length);
    }
  }
  return "";
}
