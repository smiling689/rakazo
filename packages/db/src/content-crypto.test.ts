import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DataKey } from "./content-crypto.js";
import {
  artifactKeyId,
  ContentDecryptionError,
  ciphertextKeyId,
  decryptText,
  encryptText,
  isSealedArtifact,
  jsonKeyIds,
  jsonNeedsSealing,
  legacyQuerySearchTokens,
  openArtifact,
  openJson,
  querySearchTokens,
  sealArtifact,
  sealJson,
  searchTerms,
  searchTokens,
} from "./content-crypto.js";

const key: DataKey = { id: "key-1", spaceId: "space-1", version: 1, key: randomBytes(32) };
const location = { table: "messages", column: "blocks", rowId: "row-1", owner: "thread-1" };

async function* from(...chunks: Uint8Array[]) {
  yield* chunks;
}
async function collect(source: AsyncIterable<Uint8Array>) {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}

describe("content ciphertext", () => {
  it("round-trips with a fresh IV and names its key", () => {
    const first = encryptText(key, location, "hello");
    const second = encryptText(key, location, "hello");
    expect(first).not.toBe(second);
    expect(first.startsWith("rkz1:key-1:")).toBe(true);
    expect(ciphertextKeyId(first)).toBe("key-1");
    expect(decryptText(key, location, first)).toBe("hello");
  });

  it("fails authentication when moved to another table, column, row or space", () => {
    const sealed = encryptText(key, location, "hello");
    for (const moved of [
      { ...location, table: "events" },
      { ...location, column: "payload" },
      { ...location, rowId: "row-2" },
      { ...location, owner: "thread-2" },
    ])
      expect(() => decryptText(key, moved, sealed)).toThrow(ContentDecryptionError);
    expect(() => decryptText({ ...key, spaceId: "space-2" }, location, sealed)).toThrow(
      ContentDecryptionError,
    );
  });

  it("detects tampering and wrong keys", () => {
    const sealed = encryptText(key, location, "hello");
    const flipped = `${sealed.slice(0, -2)}${sealed.at(-2) === "A" ? "B" : "A"}${sealed.at(-1)}`;
    expect(() => decryptText(key, location, flipped)).toThrow(ContentDecryptionError);
    expect(() => decryptText({ ...key, key: randomBytes(32) }, location, sealed)).toThrow(
      ContentDecryptionError,
    );
    expect(() => decryptText({ ...key, id: "key-2" }, location, sealed)).toThrow(
      ContentDecryptionError,
    );
  });

  it("seals JSON per element and keeps plain keys queryable", () => {
    const blocks = [
      { kind: "text", text: "secret" },
      { kind: "channel_message", channelId: "c1", text: "also secret", hop: 2 },
    ];
    const sealed = sealJson(blocks, new Set(["kind", "channelId"]), (plaintext) =>
      encryptText(key, location, plaintext),
    ) as Array<Record<string, unknown>>;
    expect(JSON.stringify(sealed)).not.toContain("secret");
    expect(sealed[1]).toMatchObject({ kind: "channel_message", channelId: "c1" });
    expect(sealed[1]).not.toHaveProperty("hop");
    expect(jsonKeyIds(sealed)).toEqual(["key-1", "key-1"]);
    expect(jsonNeedsSealing(sealed)).toBe(false);
    expect(jsonNeedsSealing(blocks)).toBe(true);
    expect(jsonNeedsSealing([])).toBe(false);
    expect(openJson(sealed, (value) => decryptText(key, location, value))).toEqual(blocks);
  });

  it("reads plaintext JSON unchanged", () => {
    const payload = { messageId: "m1", $sealed: "not ciphertext" };
    expect(openJson(payload, () => "unused")).toBe(payload);
    expect(jsonKeyIds(payload)).toEqual([]);
  });
});

describe("blind index tokens", () => {
  it("matches words and prefixes without revealing them, per key", () => {
    const tokens = new Set(
      searchTokens(key, { words: "Ship the Pelican report", strings: ["Ship the Pelican report"] }),
    );
    for (const token of querySearchTokens(key, "pelican SHIP", "word"))
      expect(tokens.has(token)).toBe(true);
    for (const token of querySearchTokens(key, "peli rep", "prefix"))
      expect(tokens.has(token)).toBe(true);
    expect(querySearchTokens(key, "elican", "prefix").every((token) => tokens.has(token))).toBe(
      false,
    );
    expect(querySearchTokens(key, "x", "prefix")).toEqual([]);
    const other = querySearchTokens({ ...key, key: randomBytes(32) }, "pelican", "word");
    expect(tokens.has(other[0]!)).toBe(false);
  });

  it("indexes CJK runs as bigrams and single characters", () => {
    expect(searchTerms("我喜欢喝咖啡")).toEqual(["我喜", "喜欢", "欢喝", "喝咖", "咖啡"]);
    expect(searchTerms("咖啡")).toEqual(["咖啡"]);
    expect(searchTerms("茶")).toEqual(["茶"]);
    expect(searchTerms("我用Python写爬虫")).toEqual(["我用", "python", "写爬", "爬虫"]);
    expect(searchTerms("喝茶", "index")).toEqual(["喝", "茶", "喝茶"]);
    expect(searchTerms("コーヒーが好き").slice(0, 2)).toEqual(["コー", "ーヒ"]);
    expect(searchTerms("Ship the report")).toEqual(["ship", "the", "report"]);
  });

  it("finds Chinese words inside a sentence, alone and mixed with English", () => {
    const text = "我昨天用Python写了一个爬虫，顺便喝了咖啡";
    const tokens = new Set(searchTokens(key, { words: text, strings: [text] }));
    const finds = (query: string, domain: "word" | "prefix" = "word") =>
      querySearchTokens(key, query, domain).every((token) => tokens.has(token));
    for (const query of ["咖啡", "爬虫", "写了", "喝", "python", "Python 爬虫", "一个爬虫"])
      expect(finds(query), query).toBe(true);
    expect(finds("咖啡", "prefix")).toBe(true);
    expect(finds("奶茶")).toBe(false);
    expect(finds("java 爬虫")).toBe(false);
  });

  it("keeps the query's tokens as older rows hold them, only for CJK queries", () => {
    // Releases before bigrams indexed each letter-or-digit run whole.
    const legacy = new Set(legacyQuerySearchTokens(key, "我喜欢喝咖啡 report", "word"));
    expect(legacy.size).toBe(2);
    expect(legacyQuerySearchTokens(key, "report", "word")).toBeUndefined();
    expect([...legacy].some((token) => querySearchTokens(key, "report", "word")[0] === token)).toBe(
      true,
    );
  });

  it("only indexes history text as words", () => {
    const tokens = new Set(searchTokens(key, { words: "", strings: ["photo.png"] }));
    expect(tokens.has(querySearchTokens(key, "photo", "word")[0]!)).toBe(false);
    expect(tokens.has(querySearchTokens(key, "photo", "prefix")[0]!)).toBe(true);
  });
});

describe("artifact stream", () => {
  for (const size of [0, 1, 64 * 1024 - 1, 64 * 1024, 64 * 1024 * 2, 200_001]) {
    it(`round-trips ${size} bytes`, async () => {
      const bytes = randomBytes(size);
      const sealed = await collect(
        sealArtifact(key, "file-1", from(bytes.subarray(0, 7), bytes.subarray(7))),
      );
      expect(isSealedArtifact(sealed)).toBe(true);
      expect(artifactKeyId(sealed)).toBe("key-1");
      if (size > 32) expect(sealed.includes(bytes.subarray(0, 32))).toBe(false);
      // Odd-sized reads split the header and segments across chunk boundaries.
      const pieces: Buffer[] = [];
      for (let offset = 0; offset < sealed.length; offset += 9_973)
        pieces.push(sealed.subarray(offset, offset + 9_973));
      pieces.unshift(sealed.subarray(0, 0));
      const opened = await collect(openArtifact(async () => key, "file-1", from(...pieces)));
      expect(opened.equals(bytes)).toBe(true);
    });
  }

  it("rejects truncation, splicing and the wrong file id", async () => {
    const bytes = randomBytes(64 * 1024 * 2 + 10);
    const sealed = await collect(sealArtifact(key, "file-1", from(bytes)));
    const open = (data: Buffer, fileId = "file-1") =>
      collect(openArtifact(async () => key, fileId, from(data)));
    await expect(open(sealed, "file-2")).rejects.toThrow(ContentDecryptionError);
    await expect(open(sealed.subarray(0, sealed.length - 30))).rejects.toThrow(
      ContentDecryptionError,
    );
    const header = sealed.length - (64 * 1024 + 16) * 2 - (10 + 16);
    await expect(open(sealed.subarray(0, header + 64 * 1024 + 16))).rejects.toThrow(
      ContentDecryptionError,
    );
    const swapped = Buffer.concat([
      sealed.subarray(0, header),
      sealed.subarray(header + 64 * 1024 + 16, header + 2 * (64 * 1024 + 16)),
      sealed.subarray(header, header + 64 * 1024 + 16),
      sealed.subarray(header + 2 * (64 * 1024 + 16)),
    ]);
    await expect(open(swapped)).rejects.toThrow(ContentDecryptionError);
  });

  it("does not treat plaintext as sealed", () => {
    expect(isSealedArtifact(Buffer.from("%PDF-1.7"))).toBe(false);
  });
});
