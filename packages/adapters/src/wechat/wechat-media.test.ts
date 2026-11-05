import { createDecipheriv } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sticker, StickerEntry } from "./stickers.js";
import { BQB_BASE_URL, extractStickerTags, rankStickers, StickerLibrary } from "./stickers.js";
import { encodeWechatThreadId, WechatAdapter } from "./wechat-adapter.js";

const user = "o9cq80abc@im.wechat";
let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "wechat-media-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** An offline iLink API and CDN: records sendmessage items and keeps what was uploaded. */
function fakeServer(options: { cdnStatus?: number } = {}) {
  const sent: Record<string, unknown>[] = [];
  const uploads: { key: Buffer; ciphertext: Buffer; request: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/c2c/upload")) {
      const request = uploads.at(-1)!;
      request.ciphertext = Buffer.from(init?.body as Uint8Array);
      if (options.cdnStatus) return new Response("no", { status: options.cdnStatus });
      return new Response("", { status: 200, headers: { "x-encrypted-param": "download-param" } });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (url.pathname.endsWith("ilink/bot/getuploadurl")) {
      uploads.push({ key: Buffer.from(String(body.aeskey), "hex"), ciphertext: Buffer.alloc(0), request: body });
      return Response.json({ ret: 0, upload_param: "upload-param" });
    }
    if (url.pathname.endsWith("ilink/bot/sendmessage")) {
      const msg = body.msg as { item_list: Record<string, unknown>[] };
      sent.push(msg.item_list[0]!);
    }
    return Response.json({ ret: 0 });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent, uploads };
}

function adapter(server: ReturnType<typeof fakeServer>, stickers?: Pick<StickerLibrary, "pick">) {
  return new WechatAdapter({
    token: "bot-token",
    dataDir,
    pollInboundMessages: false,
    fetch: server.fetch,
    stickers: stickers ?? { pick: async () => undefined },
  });
}

function decrypt(key: Buffer, ciphertext: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

describe("WeChat pictures and files", () => {
  it("uploads an attached picture encrypted and sends it as an image after the text", async () => {
    const server = fakeServer();
    const png = Buffer.from("89504e470d0a1a0a-fake-png-bytes");
    await adapter(server).postMessage(encodeWechatThreadId(user), {
      markdown: "**图表**做好了",
      files: [{ data: png, filename: "chart.png", mimeType: "image/png" }],
    });

    expect(server.sent[0]).toEqual({ type: 1, text_item: { text: "图表做好了" } });
    const upload = server.uploads[0]!;
    expect(upload.request).toMatchObject({
      media_type: 1,
      to_user_id: user,
      rawsize: png.byteLength,
      filesize: upload.ciphertext.byteLength,
      no_need_thumb: true,
    });
    expect(decrypt(upload.key, upload.ciphertext)).toEqual(png);
    expect(server.sent[1]).toEqual({
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: "download-param",
          // base64 of the 32 hex characters, as Tencent's own client sends it
          aes_key: Buffer.from(upload.key.toString("hex")).toString("base64"),
          encrypt_type: 1,
        },
        mid_size: upload.ciphertext.byteLength,
      },
    });
  });

  it("sends other attachments as files with their name and size", async () => {
    const server = fakeServer();
    const pdf = Buffer.from("%PDF-1.7 fake");
    await adapter(server).postMessage(encodeWechatThreadId(user), {
      markdown: "",
      files: [{ data: pdf, filename: "report.pdf", mimeType: "application/pdf" }],
    });
    expect(server.uploads[0]!.request.media_type).toBe(3);
    expect(server.sent).toEqual([
      {
        type: 4,
        file_item: {
          media: expect.objectContaining({ encrypt_query_param: "download-param", encrypt_type: 1 }),
          file_name: "report.pdf",
          len: String(pdf.byteLength),
        },
      },
    ]);
  });

  it("fails the send when the CDN refuses an attachment, so delivery can retry it", async () => {
    const server = fakeServer({ cdnStatus: 400 });
    await expect(
      adapter(server).postMessage(encodeWechatThreadId(user), {
        markdown: "",
        files: [{ data: Buffer.from("x"), filename: "a.png", mimeType: "image/png" }],
      }),
    ).rejects.toThrow("media upload refused");
    expect(server.sent).toEqual([]);
  });
});

describe("WeChat stickers", () => {
  const sticker: Sticker = { name: "柯南00036-无语了.gif", mimeType: "image/gif", data: Buffer.from("GIF89a") };

  it("strips the tag from the text and sends one matching sticker after it", async () => {
    const server = fakeServer();
    const pick = vi.fn(async () => sticker);
    await adapter(server, { pick }).postMessage(
      encodeWechatThreadId(user),
      "这也太离谱了 [表情:无语] [表情：开心]",
    );
    expect(pick).toHaveBeenCalledTimes(1);
    expect(pick).toHaveBeenCalledWith("无语");
    expect(server.sent[0]).toEqual({ type: 1, text_item: { text: "这也太离谱了" } });
    expect(server.sent[1]).toMatchObject({ type: 2 });
    expect(decrypt(server.uploads[0]!.key, server.uploads[0]!.ciphertext)).toEqual(Buffer.from("GIF89a"));
  });

  it("sends a sticker on its own and drops one it cannot find without failing", async () => {
    const server = fakeServer();
    await adapter(server, { pick: async () => sticker }).postMessage(encodeWechatThreadId(user), "[表情:晚安]");
    expect(server.sent).toEqual([expect.objectContaining({ type: 2 })]);

    const quiet = fakeServer();
    const failing = { pick: vi.fn(async () => Promise.reject(new Error("offline"))) };
    await expect(
      adapter(quiet, failing).postMessage(encodeWechatThreadId(user), "好的 [表情:好的]"),
    ).resolves.toMatchObject({ threadId: encodeWechatThreadId(user) });
    expect(quiet.sent).toEqual([{ type: 1, text_item: { text: "好的" } }]);
  });

  it("reads tags in full-width brackets and leaves other brackets alone", () => {
    expect(extractStickerTags("先这样【表情:摸鱼】\n[链接](x)")).toEqual({
      text: "先这样\n[链接](x)",
      queries: ["摸鱼"],
    });
    expect(extractStickerTags("[注意] 没有表情")).toEqual({ text: "[注意] 没有表情", queries: [] });
  });

  it("ranks label matches above category matches", () => {
    const entries: StickerEntry[] = [
      { label: "猫猫00001-晚安", src: "a.gif", categoryTitle: "无语合集" },
      { label: "金馆长熊猫00041-无语", src: "b.gif", categoryTitle: "Panda金馆长熊猫" },
      { label: "柯南00036-无语了", src: "c.gif", categoryTitle: "柯南" },
    ];
    expect(rankStickers(entries, "柯南 无语").map((match) => [match.entry.src, match.score])).toEqual([
      ["c.gif", 4],
      ["b.gif", 2],
      ["a.gif", 1],
    ]);
    expect(rankStickers(entries, "生日")).toEqual([]);
  });
});

describe("sticker library", () => {
  const index = [
    { label: "柯南00036-无语了", src: "media/c.gif", categoryTitle: "柯南", bytes: 10 },
    { label: "反港独00001-无语", src: "media/p.gif", categoryTitle: "反港独", bytes: 10 },
    { label: "巨大00001-无语", src: "media/big.gif", categoryTitle: "巨大", bytes: 9_000_000 },
  ];

  function libraryFetch(options: { indexDown?: boolean } = {}) {
    return vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("catalog/search.json")) {
        return options.indexDown ? new Response("down", { status: 503 }) : Response.json(index);
      }
      if (url === `${BQB_BASE_URL}media/c.gif`) return new Response(Buffer.from("GIF89a"));
      return new Response("missing", { status: 404 });
    });
  }

  it("downloads a match from the library, skipping excluded and oversized sets", async () => {
    const fetch = libraryFetch();
    const library = new StickerLibrary({ dataDir, fetch: fetch as unknown as typeof globalThis.fetch });
    const picked = await library.pick("无语");
    expect(picked).toMatchObject({ name: "柯南00036-无语了.gif", mimeType: "image/gif" });
    expect(Buffer.from(picked!.data).toString()).toBe("GIF89a");
    expect(fetch.mock.calls.map(([url]) => String(url))).not.toContain(`${BQB_BASE_URL}media/p.gif`);
    expect(await library.pick("生日")).toBeUndefined();
  });

  it("falls back to the last saved index when the site is down", async () => {
    await new StickerLibrary({
      dataDir,
      fetch: libraryFetch() as unknown as typeof globalThis.fetch,
    }).pick("无语");
    expect(JSON.parse(await readFile(join(dataDir, "wechat-stickers-index.json"), "utf8"))).toHaveLength(1);

    const offline = new StickerLibrary({
      dataDir,
      fetch: libraryFetch({ indexDown: true }) as unknown as typeof globalThis.fetch,
    });
    expect(await offline.pick("无语")).toMatchObject({ name: "柯南00036-无语了.gif" });
  });
});
