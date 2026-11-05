import { createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { splitOutboundBody, wechatChatBubbles } from "../messaging-platforms.js";
import { WechatActivity } from "./activity.js";
import type { IlinkMessage } from "./ilink-client.js";
import type { Sticker, StickerEntry } from "./stickers.js";
import {
  chooseSticker,
  COLLECTED_FAMILY,
  extractStickerTags,
  rankStickers,
  StickerLibrary,
  sniffImageExtension,
} from "./stickers.js";
import {
  encodeWechatThreadId,
  WECHAT_TYPING_MAX_MS,
  WECHAT_TYPING_REFRESH_MS,
  WechatAdapter,
} from "./wechat-adapter.js";

const user = "o9cq80abc@im.wechat";
const GIF = Buffer.from("GIF89a-fake-gif");
const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG-fake-png")]);
let dataDir: string;
let adapters: WechatAdapter[];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "wechat-media-"));
  adapters = [];
});

afterEach(async () => {
  vi.useRealTimers();
  for (const adapter of adapters) await adapter.stopPolling();
  await rm(dataDir, { recursive: true, force: true });
});

/** An offline iLink API and CDN: queued inbound batches, recorded sends, kept uploads. */
function fakeServer(options: { cdnStatus?: number } = {}) {
  const sent: Record<string, unknown>[] = [];
  const requests: string[] = [];
  const uploads: { key: Buffer; ciphertext: Buffer; request: Record<string, unknown> }[] = [];
  const batches: Record<string, unknown>[] = [];
  const media = new Map<string, Uint8Array>();
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/c2c/upload")) {
      uploads.at(-1)!.ciphertext = Buffer.from(init?.body as Uint8Array);
      if (options.cdnStatus) return new Response("no", { status: options.cdnStatus });
      return new Response("", { status: 200, headers: { "x-encrypted-param": "download-param" } });
    }
    if (url.pathname.endsWith("/download")) {
      const data = media.get(url.searchParams.get("encrypted_query_param") ?? "");
      return data ? new Response(Buffer.from(data)) : new Response("missing", { status: 404 });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const path = url.pathname.replace(/^\//, "");
    requests.push(path);
    if (path === "ilink/bot/getupdates") {
      const next = batches.shift();
      if (next) return Response.json(next);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }
    if (path === "ilink/bot/getuploadurl") {
      uploads.push({ key: Buffer.from(String(body.aeskey), "hex"), ciphertext: Buffer.alloc(0), request: body });
      return Response.json({ ret: 0, upload_param: "upload-param" });
    }
    if (path === "ilink/bot/getconfig") return Response.json({ ret: 0, typing_ticket: "ticket-1" });
    if (path === "ilink/bot/sendmessage") {
      sent.push((body.msg as { item_list: Record<string, unknown>[] }).item_list[0]!);
    }
    return Response.json({ ret: 0 });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent, requests, uploads, batches, media };
}

function adapterFor(
  server: ReturnType<typeof fakeServer>,
  options: { stickers?: Pick<StickerLibrary, "pick" | "collect" | "remove">; poll?: boolean } = {},
) {
  const adapter = new WechatAdapter({
    token: "bot-token",
    dataDir,
    pollInboundMessages: options.poll ?? false,
    fetch: server.fetch,
    stickers: options.stickers ?? { pick: async () => undefined, collect: async () => true, remove: async () => {} },
  });
  adapters.push(adapter);
  return adapter;
}

function decrypt(key: Buffer, ciphertext: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Writes a sticker library (index.json + files) under the data directory. */
async function writeLibrary(dir: string, entries: (StickerEntry & { data: Buffer })[]) {
  const root = join(dataDir, "messaging", dir);
  for (const entry of entries) {
    await mkdir(join(root, entry.file, ".."), { recursive: true });
    await writeFile(join(root, entry.file), entry.data);
  }
  await writeFile(
    join(root, "index.json"),
    JSON.stringify(entries.map(({ data: _data, ...entry }) => entry)),
  );
}

describe("WeChat pictures and files", () => {
  it("uploads an attached picture encrypted and sends it as an image after the text", async () => {
    const server = fakeServer();
    await adapterFor(server).postMessage(encodeWechatThreadId(user), {
      markdown: "**图表**做好了",
      files: [{ data: PNG, filename: "chart.png", mimeType: "image/png" }],
    });

    expect(server.sent[0]).toEqual({ type: 1, text_item: { text: "图表做好了" } });
    const upload = server.uploads[0]!;
    expect(upload.request).toMatchObject({
      media_type: 1,
      to_user_id: user,
      rawsize: PNG.byteLength,
      filesize: upload.ciphertext.byteLength,
      no_need_thumb: true,
    });
    expect(decrypt(upload.key, upload.ciphertext)).toEqual(PNG);
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
    await adapterFor(server).postMessage(encodeWechatThreadId(user), {
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
      adapterFor(server).postMessage(encodeWechatThreadId(user), {
        markdown: "",
        files: [{ data: PNG, filename: "a.png", mimeType: "image/png" }],
      }),
    ).rejects.toThrow("media upload refused");
    expect(server.sent).toEqual([]);
  });
});

describe("WeChat stickers", () => {
  const sticker: Sticker = {
    name: "cat.gif",
    mimeType: "image/gif",
    data: GIF,
    ref: { file: "pets/cat.gif", collected: false },
  };

  it("strips the tag from the text and sends one matching sticker after it", async () => {
    const server = fakeServer();
    const pick = vi.fn(async () => sticker);
    await adapterFor(server, { stickers: { pick, collect: async () => true, remove: async () => {} } }).postMessage(
      encodeWechatThreadId(user),
      "这也太离谱了 [表情:无语] [表情：开心]",
    );
    expect(pick).toHaveBeenCalledTimes(1);
    expect(pick).toHaveBeenCalledWith("无语");
    expect(server.sent[0]).toEqual({ type: 1, text_item: { text: "这也太离谱了" } });
    expect(server.sent[1]).toMatchObject({ type: 2 });
    expect(decrypt(server.uploads[0]!.key, server.uploads[0]!.ciphertext)).toEqual(GIF);
  });

  it("sends a sticker on its own and drops one it cannot find without failing", async () => {
    const server = fakeServer();
    await adapterFor(server, { stickers: { pick: async () => sticker, collect: async () => true, remove: async () => {} } }).postMessage(
      encodeWechatThreadId(user),
      "[表情:晚安]",
    );
    expect(server.sent).toEqual([expect.objectContaining({ type: 2 })]);

    const quiet = fakeServer();
    const failing = {
      pick: vi.fn(async () => Promise.reject(new Error("gone"))),
      collect: async () => true,
      remove: async () => {},
    };
    await expect(
      adapterFor(quiet, { stickers: failing }).postMessage(encodeWechatThreadId(user), "好的 [表情:好的]"),
    ).resolves.toMatchObject({ threadId: encodeWechatThreadId(user) });
    expect(quiet.sent).toEqual([{ type: 1, text_item: { text: "好的" } }]);
  });

  it("reads sticker and collect tags in either bracket style and leaves other brackets alone", () => {
    expect(extractStickerTags("先这样【表情:摸鱼】\n[链接](x)")).toEqual({
      text: "先这样\n[链接](x)",
      queries: ["摸鱼"],
      collect: [],
      remove: false,
    });
    expect(extractStickerTags("收好啦 [收藏表情:猫猫 开心]")).toEqual({
      text: "收好啦",
      queries: [],
      collect: ["猫猫 开心"],
      remove: false,
    });
    expect(extractStickerTags("[注意] 没有表情")).toEqual({
      text: "[注意] 没有表情",
      queries: [],
      collect: [],
      remove: false,
    });
    expect(extractStickerTags("好，这张不发了【删除表情】")).toEqual({
      text: "好，这张不发了",
      queries: [],
      collect: [],
      remove: true,
    });
  });

  it("ranks label matches above text matches", () => {
    const entries: StickerEntry[] = [
      { file: "a.gif", label: "晚安", text: "猫猫 无语 合集", family: "萌宠" },
      { file: "b.gif", label: "无语", text: "熊猫", family: "萌宠" },
      { file: "c.gif", label: "猫猫无语了", text: "", family: "萌宠" },
    ];
    expect(rankStickers(entries, "猫猫 无语").map((match) => [match.entry.file, match.score])).toEqual([
      ["c.gif", 6],
      ["b.gif", 3],
      ["a.gif", 2],
    ]);
    expect(rankStickers(entries, "生日")).toEqual([]);
  });

  it("picks a family first, so one big set does not crowd out the rest", () => {
    const ranked = [
      ...Array.from({ length: 50 }, (_, i) => ({
        entry: { file: `whale${i}.gif`, label: "开心", text: "", family: "鲸鱼娘" },
        score: 3,
      })),
      { entry: { file: "cat.gif", label: "开心", text: "", family: "萌宠" }, score: 3 },
      { entry: { file: "weak.gif", label: "x", text: "开心", family: "动漫" }, score: 1 },
    ];
    // Rolls just under the halfway mark pick 鲸鱼娘, from there on 萌宠; 动漫 matches too weakly.
    expect(chooseSticker(ranked, () => 0.49)?.family).toBe("鲸鱼娘");
    expect(chooseSticker(ranked, () => 0.51)?.file).toBe("cat.gif");
    const collected = [
      ...ranked,
      { entry: { file: "mine.gif", label: "开心", text: "", family: COLLECTED_FAMILY }, score: 3 },
    ];
    // The collection weighs three families: 3 / (1 + 1 + 3) of the rolls land on it.
    expect(chooseSticker(collected, () => 0.5)?.file).toBe("mine.gif");
    expect(chooseSticker([], () => 0.5)).toBeUndefined();
  });

  it("serves pictures from the local library and the owner's collection", async () => {
    await writeLibrary("stickers", [
      { file: "pets/cat-happy.gif", label: "猫猫开心", text: "猫 开心", family: "萌宠", data: GIF },
      { file: "pets/../../../escape.gif", label: "开心", text: "", family: "萌宠", data: GIF },
    ]);
    const library = new StickerLibrary({ dataDir, random: () => 0 });
    expect(await library.pick("开心")).toMatchObject({ name: "cat-happy.gif", mimeType: "image/gif" });
    expect(await library.pick("生日")).toBeUndefined();

    expect(await library.collect(PNG, "我的 生日 快乐")).toBe(true);
    expect(await library.collect(Buffer.from("not a picture"), "生日")).toBe(false);
    const picked = await library.pick("生日");
    expect(picked).toMatchObject({ mimeType: "image/png" });
    expect(Buffer.from(picked!.data)).toEqual(PNG);
    const index = JSON.parse(
      await readFile(join(dataDir, "messaging", "stickers-collected", "index.json"), "utf8"),
    ) as StickerEntry[];
    expect(index).toEqual([expect.objectContaining({ label: "我的 生日 快乐", family: COLLECTED_FAMILY })]);
  });

  it("takes a removed sticker out of use: library ones are skipped, collected ones deleted", async () => {
    await writeLibrary("stickers", [
      { file: "a/one.gif", label: "开心", text: "", family: "鲸鱼娘", data: GIF },
      { file: "a/two.gif", label: "开心", text: "", family: "鲸鱼娘", data: GIF },
    ]);
    const library = new StickerLibrary({ dataDir, random: () => 0 });
    const first = await library.pick("开心");
    expect(first?.ref).toEqual({ file: "a/one.gif", collected: false });
    await library.remove(first!.ref);
    expect((await library.pick("开心"))?.ref.file).toBe("a/two.gif");
    await library.remove({ file: "a/two.gif", collected: false });
    expect(await library.pick("开心")).toBeUndefined();
    expect(
      JSON.parse(await readFile(join(dataDir, "messaging", "stickers-blocked.json"), "utf8")),
    ).toEqual(["a/one.gif", "a/two.gif"]);

    await library.collect(PNG, "生日");
    const mine = await library.pick("生日");
    expect(mine?.ref.collected).toBe(true);
    await library.remove(mine!.ref);
    expect(await library.pick("生日")).toBeUndefined();
    await expect(readFile(join(dataDir, "messaging", "stickers-collected", mine!.ref.file))).rejects.toThrow();
  });

  it("removes the sticker it sent last when a later reply carries [删除表情]", async () => {
    const server = fakeServer();
    const remove = vi.fn(async () => {});
    const adapter = adapterFor(server, { stickers: { pick: async () => sticker, collect: async () => true, remove } });
    await adapter.postMessage(encodeWechatThreadId(user), "哈哈 [表情:开心]");
    await adapter.postMessage(encodeWechatThreadId(user), "好，那张不发了 [删除表情]");
    expect(remove).toHaveBeenCalledWith({ file: "pets/cat.gif", collected: false });
    expect(server.sent.at(-1)).toEqual({ type: 1, text_item: { text: "好，那张不发了" } });

    const fresh = fakeServer();
    const untouched = vi.fn(async () => {});
    await adapterFor(fresh, {
      stickers: { pick: async () => undefined, collect: async () => true, remove: untouched },
    }).postMessage(encodeWechatThreadId("other@im.wechat"), "[删除表情]");
    expect(untouched).not.toHaveBeenCalled();
    expect(fresh.sent).toEqual([]);
  });

  it("recognises the picture types WeChat shows", () => {
    expect(sniffImageExtension(GIF)).toBe("gif");
    expect(sniffImageExtension(PNG)).toBe("png");
    expect(sniffImageExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
    expect(sniffImageExtension(Buffer.from("RIFF0000WEBPVP8 "))).toBe("webp");
    expect(sniffImageExtension(Buffer.from("%PDF"))).toBeUndefined();
  });

  it("collects the picture the owner sent last when a reply carries a collect tag", async () => {
    const server = fakeServer();
    const key = Buffer.from("0123456789abcdef");
    const cipher = createCipheriv("aes-128-ecb", key, null);
    server.media.set("their-pic", Buffer.concat([cipher.update(GIF), cipher.final()]));
    await new WechatActivity(dataDir, "bot-token").rememberImage(user, {
      media: { encrypt_query_param: "their-pic" },
      aeskey: key.toString("hex"),
    });
    const collect = vi.fn(async () => true);
    await adapterFor(server, { stickers: { pick: async () => undefined, collect, remove: async () => {} } }).postMessage(
      encodeWechatThreadId(user),
      "收好啦～ [收藏表情:猫猫 害羞]",
    );
    expect(collect).toHaveBeenCalledWith(GIF, "猫猫 害羞");
    expect(server.sent).toEqual([{ type: 1, text_item: { text: "收好啦～" } }]);
  });
});

describe("WeChat chat bubbles", () => {
  it("sends a short chatty reply in two or three paragraphs as separate bubbles", () => {
    expect(wechatChatBubbles("哈哈哈真的假的\n\n那你今天早点睡吧\n\n[表情:晚安]")).toEqual([
      "哈哈哈真的假的",
      "那你今天早点睡吧 [表情:晚安]",
    ]);
    expect(splitOutboundBody("wechat", "好呀\n\n我等会儿提醒你")).toEqual(["好呀", "我等会儿提醒你"]);
  });

  it("keeps lists, choices, single paragraphs and long replies in one message", () => {
    expect(wechatChatBubbles("你想怎么做？\n\n1. 现在去\n2. 明天再说")).toBeUndefined();
    expect(wechatChatBubbles("要点：\n- 一\n- 二\n\n就这些")).toBeUndefined();
    expect(wechatChatBubbles("就一句话")).toBeUndefined();
    expect(wechatChatBubbles("一\n\n二\n\n三\n\n四")).toBeUndefined();
    expect(wechatChatBubbles(`${"很长".repeat(60)}\n\n短`)).toBeUndefined();
  });
});

describe("WeChat reply watch", () => {
  const inbound = (id: number): IlinkMessage => ({
    message_id: id,
    from_user_id: user,
    message_type: 1,
    context_token: "ctx-1",
    item_list: [{ type: 1, text_item: { text: "帮我查一下" } }],
  });

  async function pollingAdapter(server: ReturnType<typeof fakeServer>) {
    const adapter = adapterFor(server, { poll: true });
    const { Chat } = await import("chat");
    const { createMemoryState } = await import("@chat-adapter/state-memory");
    const chat = new Chat({
      userName: "rakazo",
      adapters: { wechat: adapter },
      state: createMemoryState(),
      concurrency: "concurrent",
    });
    chat.onDirectMessage(async () => undefined);
    await chat.initialize();
    return adapter;
  }

  it("keeps typing until a reply goes out, and never sends words of its own", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const server = fakeServer();
    server.batches.push({ ret: 0, msgs: [inbound(1)], get_updates_buf: "c1" });
    const adapter = await pollingAdapter(server);
    await vi.waitFor(() => expect(server.requests).toContain("ilink/bot/getupdates"));
    const typing = () => server.requests.filter((path) => path === "ilink/bot/sendtyping").length;
    // Each check reads a file, so step the clock until typing has been re-sent a few times.
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(WECHAT_TYPING_REFRESH_MS);
      expect(typing()).toBeGreaterThan(3);
    });
    expect(server.sent).toEqual([]);

    // The reply goes out (from any process); typing stops.
    await adapter.postMessage(encodeWechatThreadId(user), "查好了");
    await vi.advanceTimersByTimeAsync(WECHAT_TYPING_REFRESH_MS * 2);
    const typingAfter = typing();
    await vi.advanceTimersByTimeAsync(WECHAT_TYPING_MAX_MS);
    expect(typing()).toBe(typingAfter);
    expect(server.sent).toEqual([{ type: 1, text_item: { text: "查好了" } }]);
  });
});
