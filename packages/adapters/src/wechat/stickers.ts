import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";

/**
 * Meme stickers (表情包) for WeChat replies. iLink has no sticker message type, so a sticker
 * goes out as a picture. A bot asks for one by writing `[表情:关键词]` in a reply and adds the
 * picture the owner just sent to their collection with `[收藏表情:标签]`; `[删除表情]` takes the
 * sticker it sent last out of use (see StickerLibrary.remove). The adapter strips the tags. Pictures come from two local libraries under the data directory, each an index.json of
 * `{file, label, text, family}` next to the files:
 * - `messaging/stickers`: built by the deployment from public sticker sets, cute ones only;
 * - `messaging/stickers-collected`: the owner's own collection, which this module writes.
 * A family (one set or style) is chosen first, so no single big set floods the replies; the
 * owner's collection is chosen more often than the rest.
 */
export const COLLECTED_FAMILY = "收藏";
const COLLECTED_WEIGHT = 3;
/** Big GIFs are slow to send and heavy on a phone; most stickers are a few dozen KB. */
const STICKER_MAX_BYTES = 1_500_000;
const MIME_BY_EXTENSION: Record<string, string> = {
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** `[表情:无语]`, `【表情：猫 开心】`: one tag asks for one sticker. */
const STICKER_TAG = /[[［【]表情[:：]\s*([^\]］】\n]{1,40}?)\s*[\]］】]/g;
/** `[收藏表情:猫猫 开心]`: keep the picture the owner just sent, under these words. */
const COLLECT_TAG = /[[［【]收藏表情[:：]\s*([^\]］】\n]{1,40}?)\s*[\]］】]/g;
/** `[删除表情]`: the owner does not want the sticker sent to them last. */
const REMOVE_TAG = /[[［【]删除表情[\]］】]/g;

export interface StickerEntry {
  file: string;
  label: string;
  text: string;
  family: string;
}

/** Which picture a sticker was, so it can be taken out of use later. */
export interface StickerRef {
  file: string;
  collected: boolean;
}

export interface Sticker {
  name: string;
  mimeType: string;
  data: Uint8Array;
  ref: StickerRef;
}

/** Removes sticker tags from a reply; returns the text, each tag's words in order, and whether to remove. */
export function extractStickerTags(text: string): {
  text: string;
  queries: string[];
  collect: string[];
  remove: boolean;
} {
  const queries: string[] = [];
  const collect: string[] = [];
  let remove = false;
  const stripped = text
    .replace(REMOVE_TAG, () => {
      remove = true;
      return "";
    })
    .replace(COLLECT_TAG, (_tag, label: string) => {
      collect.push(label.trim());
      return "";
    })
    .replace(STICKER_TAG, (_tag, query: string) => {
      queries.push(query.trim());
      return "";
    });
  if (queries.length === 0 && collect.length === 0 && !remove) return { text, queries, collect, remove };
  const tidied = stripped
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: tidied, queries, collect, remove };
}

function words(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,，、;；/|]+/)
    .filter(Boolean);
}

/** Matches, best first: each query word found in the label counts 3, elsewhere in the text 1. */
export function rankStickers(
  entries: StickerEntry[],
  query: string,
): { entry: StickerEntry; score: number }[] {
  const wanted = words(query);
  const scored: { entry: StickerEntry; score: number }[] = [];
  for (const entry of entries) {
    const label = entry.label.toLowerCase();
    const text = entry.text.toLowerCase();
    let score = 0;
    for (const word of wanted) score += label.includes(word) ? 3 : text.includes(word) ? 1 : 0;
    if (score > 0) scored.push({ entry, score });
  }
  return scored.sort((a, b) => b.score - a.score);
}

/**
 * One family at random among those that match about as well as the best one (the collection
 * weighted up), then one of that family's best matches at random.
 */
export function chooseSticker(
  ranked: { entry: StickerEntry; score: number }[],
  random: () => number,
): StickerEntry | undefined {
  const best = ranked[0]?.score ?? 0;
  if (best === 0) return undefined;
  const families = new Map<string, { score: number; entries: StickerEntry[] }>();
  for (const { entry, score } of ranked) {
    const family = families.get(entry.family);
    if (!family) families.set(entry.family, { score, entries: [entry] });
    else if (score === family.score) family.entries.push(entry);
  }
  const eligible = [...families.entries()].filter(([, family]) => family.score >= best - 1);
  const weight = (name: string) => (name === COLLECTED_FAMILY ? COLLECTED_WEIGHT : 1);
  let roll = random() * eligible.reduce((sum, [name]) => sum + weight(name), 0);
  const [, family] =
    eligible.find(([name]) => (roll -= weight(name)) < 0) ?? eligible[eligible.length - 1]!;
  return family.entries[Math.floor(random() * family.entries.length)];
}

/** The image type of a picture's bytes, or undefined when it is not one WeChat shows. */
export function sniffImageExtension(data: Uint8Array): string | undefined {
  const head = Buffer.from(data.subarray(0, 12));
  if (head.subarray(0, 4).toString("latin1") === "GIF8") return "gif";
  if (head[0] === 0x89 && head.subarray(1, 4).toString("latin1") === "PNG") return "png";
  if (head[0] === 0xff && head[1] === 0xd8) return "jpg";
  if (
    head.subarray(0, 4).toString("latin1") === "RIFF" &&
    head.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "webp";
  }
  return undefined;
}

export interface StickerLibraryOptions {
  /** The shared data directory (holds `messaging/`). */
  dataDir: string;
  random?: () => number;
}

interface LoadedIndex {
  mtimeMs: number;
  entries: StickerEntry[];
}

export class StickerLibrary {
  private readonly random: () => number;
  private readonly libraryDir: string;
  private readonly collectedDir: string;
  private readonly blockedPath: string;
  private readonly loaded = new Map<string, LoadedIndex>();
  private collecting: Promise<unknown> = Promise.resolve();

  constructor(options: StickerLibraryOptions) {
    this.random = options.random ?? Math.random;
    this.libraryDir = join(options.dataDir, "messaging", "stickers");
    this.collectedDir = join(options.dataDir, "messaging", "stickers-collected");
    // Outside the library directory, which the deployment rebuilds; its file names stay the same.
    this.blockedPath = join(options.dataDir, "messaging", "stickers-blocked.json");
  }

  /** One picture for `query`, or undefined when nothing matches. */
  async pick(query: string): Promise<Sticker | undefined> {
    const [library, collected, blocked] = await Promise.all([
      this.index(this.libraryDir),
      this.index(this.collectedDir),
      this.blocked(),
    ]);
    const usable = library.filter((entry) => !blocked.has(entry.file));
    const ranked = rankStickers([...collected, ...usable], query);
    // A picture that has gone missing is skipped for the next choice.
    for (let attempt = 0; attempt < 3 && ranked.length > 0; attempt++) {
      const entry = chooseSticker(ranked, this.random);
      if (!entry) return undefined;
      const sticker = await this.read(entry);
      if (sticker) return sticker;
      ranked.splice(
        ranked.findIndex((match) => match.entry === entry),
        1,
      );
    }
    return undefined;
  }

  /** Adds a picture to the owner's collection under `label`; false when it is not a picture. */
  async collect(data: Uint8Array, label: string): Promise<boolean> {
    const extension = sniffImageExtension(data);
    if (!extension || data.byteLength > STICKER_MAX_BYTES || !label.trim()) return false;
    const next = this.collecting.then(async () => {
      const file = `${createHash("sha256").update(data).digest("hex").slice(0, 24)}.${extension}`;
      await mkdir(this.collectedDir, { recursive: true, mode: 0o750 });
      await writeFile(join(this.collectedDir, file), data, { mode: 0o640 });
      const entries = (await this.index(this.collectedDir)).filter((entry) => entry.file !== file);
      entries.push({ file, label: label.trim(), text: label.trim(), family: COLLECTED_FAMILY });
      await this.writeIndex(entries);
    });
    this.collecting = next.catch(() => undefined);
    await next;
    return true;
  }

  /**
   * Takes a sticker out of use: a collected one is deleted from the collection, a library one is
   * listed in stickers-blocked.json, which pick skips (a rebuild of the library keeps it out too).
   */
  async remove(ref: StickerRef): Promise<void> {
    const next = this.collecting.then(async () => {
      if (ref.collected) {
        const entries = await this.index(this.collectedDir);
        await this.writeIndex(entries.filter((entry) => entry.file !== ref.file));
        await rm(join(this.collectedDir, ref.file), { force: true });
        return;
      }
      const blocked = await this.blocked();
      if (blocked.has(ref.file)) return;
      await mkdir(join(this.blockedPath, ".."), { recursive: true, mode: 0o750 });
      await writeFile(`${this.blockedPath}.tmp`, JSON.stringify([...blocked, ref.file]), { mode: 0o640 });
      await rename(`${this.blockedPath}.tmp`, this.blockedPath);
    });
    this.collecting = next.catch(() => undefined);
    await next;
  }

  private async blocked(): Promise<Set<string>> {
    const raw = await readFile(this.blockedPath, "utf8")
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => []);
    return new Set(Array.isArray(raw) ? raw.filter((file) => typeof file === "string") : []);
  }

  private async writeIndex(entries: StickerEntry[]): Promise<void> {
    const path = join(this.collectedDir, "index.json");
    await writeFile(`${path}.tmp`, JSON.stringify(entries), { mode: 0o640 });
    await rename(`${path}.tmp`, path);
    this.loaded.delete(this.collectedDir);
  }

  /** A directory's index, re-read when the file changes (the deployment rebuilds the library). */
  private async index(dir: string): Promise<StickerEntry[]> {
    const path = join(dir, "index.json");
    const mtimeMs = await stat(path).then(
      (info) => info.mtimeMs,
      () => -1,
    );
    if (mtimeMs < 0) return [];
    const cached = this.loaded.get(dir);
    if (cached?.mtimeMs === mtimeMs) return cached.entries;
    const entries = await readFile(path, "utf8")
      .then((text) => parseIndex(JSON.parse(text)))
      .catch(() => []);
    this.loaded.set(dir, { mtimeMs, entries });
    return entries;
  }

  private async read(entry: StickerEntry): Promise<Sticker | undefined> {
    const collected = entry.family === COLLECTED_FAMILY;
    const dir = collected ? this.collectedDir : this.libraryDir;
    const path = normalize(join(dir, entry.file));
    if (!path.startsWith(dir + sep)) return undefined;
    const extension = entry.file.split(".").pop()?.toLowerCase() ?? "";
    const mimeType = MIME_BY_EXTENSION[extension];
    if (!mimeType) return undefined;
    const data = await readFile(path).catch(() => undefined);
    if (!data || data.byteLength === 0 || data.byteLength > STICKER_MAX_BYTES) return undefined;
    return { name: entry.file.split("/").pop() ?? entry.file, mimeType, data, ref: { file: entry.file, collected } };
  }
}

function parseIndex(raw: unknown): StickerEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const { file, label, text, family } = item as Record<string, unknown>;
    if (typeof file !== "string" || typeof label !== "string" || !file || !label) return [];
    return [
      {
        file,
        label,
        text: typeof text === "string" ? text : label,
        family: typeof family === "string" && family ? family : "其他",
      },
    ];
  });
}
