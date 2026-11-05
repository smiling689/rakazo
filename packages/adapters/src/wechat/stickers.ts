import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getLogger } from "@rakazo/logging";

/**
 * Meme stickers (表情包) for WeChat replies. iLink has no sticker message type, so a sticker
 * goes out as an image. A bot asks for one by writing `[表情:关键词]` in its reply; the
 * adapter strips the tag and sends one matching picture from ChineseBQB
 * (github.com/zhaoolee/ChineseBQB, ~5,900 labelled Chinese memes), whose published search
 * index names each picture, e.g. "柯南00036-无语了".
 */
export const BQB_BASE_URL = "https://zhaoolee.com/ChineseBQB/";
const INDEX_URL = `${BQB_BASE_URL}catalog/search.json`;
const INDEX_TTL_MS = 24 * 60 * 60_000;
const INDEX_MAX_BYTES = 20_000_000;
/** Big GIFs are slow to send and heavy on a phone; most stickers are a few dozen KB. */
const STICKER_MAX_BYTES = 1_500_000;
/** Political, pandemic and real-person-in-mourning sets do not belong in casual replies. */
const EXCLUDED_CATEGORIES = ["反港独", "冠状病毒", "特朗普", "那年那兔那些事", "袁隆平", "黑人抬棺"];
const MIME_BY_EXTENSION: Record<string, string> = {
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** `[表情:无语]`, `[表情：柯南 无语]`; one tag asks for one sticker. */
const STICKER_TAG = /[[［【]表情[:：]\s*([^\]］】\n]{1,40}?)\s*[\]］】]/g;

export interface StickerEntry {
  label: string;
  src: string;
  categoryTitle?: string;
  bytes?: number;
}

export interface Sticker {
  name: string;
  mimeType: string;
  data: Uint8Array;
}

/** Removes sticker tags from a reply; returns the text and the queries in order. */
export function extractStickerTags(text: string): { text: string; queries: string[] } {
  const queries: string[] = [];
  const stripped = text.replace(STICKER_TAG, (_tag, query: string) => {
    queries.push(query.trim());
    return "";
  });
  if (queries.length === 0) return { text, queries };
  const tidied = stripped
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: tidied, queries };
}

/** Matches, best first: each query word found in the label counts 2, in the category 1. */
export function rankStickers(
  entries: StickerEntry[],
  query: string,
): { entry: StickerEntry; score: number }[] {
  const words = query
    .toLowerCase()
    .split(/[\s,，、;；/|]+/)
    .filter(Boolean);
  const scored: { entry: StickerEntry; score: number }[] = [];
  for (const entry of entries) {
    const label = entry.label.toLowerCase();
    const category = (entry.categoryTitle ?? "").toLowerCase();
    let score = 0;
    for (const word of words) score += label.includes(word) ? 2 : category.includes(word) ? 1 : 0;
    if (score > 0) scored.push({ entry, score });
  }
  return scored.sort((a, b) => b.score - a.score);
}

export interface StickerLibraryOptions {
  /** Where the index is cached between restarts (the WeChat state directory). */
  dataDir: string;
  fetch?: typeof fetch;
  random?: () => number;
}

export class StickerLibrary {
  private entries: StickerEntry[] | undefined;
  private loadedAt = 0;
  private loading: Promise<StickerEntry[]> | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly random: () => number;
  private readonly cachePath: string;

  constructor(options: StickerLibraryOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.random = options.random ?? Math.random;
    this.cachePath = join(options.dataDir, "wechat-stickers-index.json");
  }

  /** One picture for `query`, or undefined when nothing matches or the library is unreachable. */
  async pick(query: string): Promise<Sticker | undefined> {
    const entries = await this.index();
    const ranked = rankStickers(entries, query);
    const top = ranked[0]?.score ?? 0;
    // Any of the best matches, at random, so the same word does not always bring the same face;
    // try a few in case one picture is gone or oversized.
    const pool = ranked.filter((match) => match.score === top).map((match) => match.entry);
    const order = [...pool];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    for (const entry of order.slice(0, 3)) {
      const sticker = await this.download(entry).catch((error: unknown) => {
        getLogger().warn("wechat sticker download failed", { error: String(error) });
        return undefined;
      });
      if (sticker) return sticker;
    }
    return undefined;
  }

  private async index(): Promise<StickerEntry[]> {
    if (this.entries && Date.now() - this.loadedAt < INDEX_TTL_MS) return this.entries;
    this.loading ??= this.loadIndex().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async loadIndex(): Promise<StickerEntry[]> {
    try {
      const response = await this.fetchImpl(INDEX_URL, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > INDEX_MAX_BYTES) throw new Error("index too large");
      const entries = parseIndex(JSON.parse(text));
      if (entries.length === 0) throw new Error("empty index");
      this.entries = entries;
      this.loadedAt = Date.now();
      await writeFile(`${this.cachePath}.tmp`, JSON.stringify(entries))
        .then(() => rename(`${this.cachePath}.tmp`, this.cachePath))
        .catch(() => undefined);
      return entries;
    } catch (error) {
      getLogger().warn("wechat sticker index unavailable", { error: String(error) });
      if (this.entries) return this.entries;
      // The site is down: fall back to the copy from the last good download, retry in an hour.
      const cached = await readFile(this.cachePath, "utf8")
        .then((text) => parseIndex(JSON.parse(text)))
        .catch(() => []);
      this.entries = cached;
      this.loadedAt = Date.now() - INDEX_TTL_MS + 60 * 60_000;
      return cached;
    }
  }

  private async download(entry: StickerEntry): Promise<Sticker | undefined> {
    const url = new URL(entry.src, BQB_BASE_URL);
    if (url.origin !== new URL(BQB_BASE_URL).origin) return undefined;
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength === 0 || data.byteLength > STICKER_MAX_BYTES) return undefined;
    const extension = url.pathname.split(".").pop()?.toLowerCase() ?? "";
    const mimeType = MIME_BY_EXTENSION[extension];
    if (!mimeType) return undefined;
    return { name: `${entry.label}.${extension}`, mimeType, data };
  }
}

function parseIndex(raw: unknown): StickerEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const { label, src, categoryTitle, bytes } = item as Record<string, unknown>;
    if (typeof label !== "string" || typeof src !== "string" || !label || !src) return [];
    const category = typeof categoryTitle === "string" ? categoryTitle : undefined;
    if (category && EXCLUDED_CATEGORIES.some((excluded) => category.includes(excluded))) return [];
    const size = typeof bytes === "number" ? bytes : undefined;
    if (size !== undefined && size > STICKER_MAX_BYTES) return [];
    return [{ label, src, ...(category ? { categoryTitle: category } : {}), ...(size ? { bytes: size } : {}) }];
  });
}
