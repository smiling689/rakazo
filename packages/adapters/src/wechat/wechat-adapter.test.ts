import { createCipheriv } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { Message, Thread } from "chat";
import { Chat } from "chat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messagingPlatformsFromEnv, splitOutboundBody } from "../messaging-platforms.js";
import type { IlinkMessage } from "./ilink-client.js";
import {
  decodeWechatThreadId,
  encodeWechatThreadId,
  WECHAT_EXPIRED_PAUSE_MS,
  WECHAT_UNREADABLE_LABEL,
  WechatAdapter,
} from "./wechat-adapter.js";

/** An offline iLink server: queued getupdates batches, then long-polls that hold until aborted. */
function fakeIlink() {
  const batches: Record<string, unknown>[] = [];
  const requests: { path: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const media = new Map<string, Uint8Array>();
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/download")) {
      const data = media.get(url.searchParams.get("encrypted_query_param") ?? "");
      return data ? new Response(Buffer.from(data)) : new Response("missing", { status: 404 });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const path = url.pathname.replace(/^\//, "");
    requests.push({ path, body, headers: new Headers(init?.headers) });
    if (path === "ilink/bot/getupdates") {
      const next = batches.shift();
      if (next) return Response.json(next);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }
    if (path === "ilink/bot/getconfig") return Response.json({ ret: 0, typing_ticket: "ticket-1" });
    return Response.json({ ret: 0 });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, batches, requests, media };
}

const user = "o9cq80abc@im.wechat";
let dataDir: string;
let adapters: WechatAdapter[];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "wechat-adapter-"));
  adapters = [];
});

afterEach(async () => {
  vi.useRealTimers();
  for (const adapter of adapters) await adapter.stopPolling();
  await rm(dataDir, { recursive: true, force: true });
});

function adapterFor(server: ReturnType<typeof fakeIlink>, pollInboundMessages: boolean) {
  const adapter = new WechatAdapter({
    token: "bot-token",
    dataDir,
    pollInboundMessages,
    fetch: server.fetch,
  });
  adapters.push(adapter);
  return adapter;
}

async function chatWith(adapter: WechatAdapter) {
  const chat = new Chat({
    userName: "rakazo",
    adapters: { wechat: adapter },
    state: createMemoryState(),
    concurrency: "concurrent",
  });
  const received: { thread: Thread; message: Message }[] = [];
  chat.onDirectMessage(async (thread, message) => {
    received.push({ thread, message });
  });
  await chat.initialize();
  return received;
}

function inbound(overrides: Partial<IlinkMessage>): IlinkMessage {
  return {
    message_id: 1,
    from_user_id: user,
    to_user_id: "bot@im.bot",
    create_time_ms: 1_700_000_000_000,
    message_type: 1,
    context_token: "ctx-1",
    item_list: [{ type: 1, text_item: { text: "hello *there*" } }],
    ...overrides,
  };
}

describe("WechatAdapter", () => {
  it("round-trips user ids through thread ids", () => {
    const threadId = encodeWechatThreadId(user);
    expect(threadId.startsWith("wechat:")).toBe(true);
    expect(decodeWechatThreadId(threadId)).toBe(user);
    expect(() => decodeWechatThreadId("telegram:1")).toThrow();
  });

  it("polls direct messages into the Chat SDK and skips echoes and groups", async () => {
    const server = fakeIlink();
    server.batches.push({
      ret: 0,
      get_updates_buf: "cursor-1",
      msgs: [
        inbound({}),
        inbound({ message_id: 2, message_type: 2 }),
        inbound({ message_id: 3, group_id: "group@chatroom" }),
        inbound({
          message_id: 4,
          item_list: [
            {
              type: 3,
              voice_item: { text: "voice words" },
              ref_msg: { message_item: { type: 1, text_item: { text: "earlier" } } },
            },
          ],
        }),
      ],
    });
    const received = await chatWith(adapterFor(server, true));
    await vi.waitFor(() => expect(received).toHaveLength(2));

    expect(received[0]!.message.text).toBe("hello *there*");
    expect(received[0]!.message.author.userId).toBe(user);
    expect(received[0]!.thread.id).toBe(encodeWechatThreadId(user));
    expect(received[0]!.thread.isDM).toBe(true);
    expect(received[1]!.message.text).toBe("> earlier\nvoice words");

    const polls = server.requests.filter((request) => request.path === "ilink/bot/getupdates");
    expect(polls[0]!.body.get_updates_buf).toBe("");
    await vi.waitFor(() => expect(polls.length).toBeGreaterThanOrEqual(2));
    expect(polls[1]!.body.get_updates_buf).toBe("cursor-1");
    const headers = polls[0]!.headers;
    expect(headers.get("authorization")).toBe("Bearer bot-token");
    expect(headers.get("authorizationtype")).toBe("ilink_bot_token");
    expect(headers.get("ilink-app-id")).toBe("bot");
  });

  it("hands the bot a note for a message with nothing readable instead of dropping it", async () => {
    const server = fakeIlink();
    server.batches.push({
      ret: 0,
      get_updates_buf: "cursor-1",
      msgs: [inbound({ message_id: 7, item_list: [{ type: 19 } as never] })],
    });
    const received = await chatWith(adapterFor(server, true));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]!.message.text).toBe(WECHAT_UNREADABLE_LABEL);
    // The adapter itself never answers; the bot does.
    expect(server.requests.some((request) => request.path === "ilink/bot/sendmessage")).toBe(false);
  });

  it("keeps messages without any id apart", async () => {
    const server = fakeIlink();
    const bare = (text: string) =>
      inbound({ message_id: undefined, item_list: [{ type: 1, text_item: { text } }] });
    server.batches.push({ ret: 0, get_updates_buf: "cursor-1", msgs: [bare("one"), bare("two")] });
    const received = await chatWith(adapterFor(server, true));
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[0]!.message.id).not.toBe(received[1]!.message.id);
  });

  it("resumes from the saved cursor and replies with the saved context from any process", async () => {
    const server = fakeIlink();
    server.batches.push({ ret: 0, get_updates_buf: "cursor-9", msgs: [inbound({})] });
    const received = await chatWith(adapterFor(server, true));
    await vi.waitFor(() => expect(received).toHaveLength(1));

    // A send-only process (the worker) shares the data directory.
    const sender = adapterFor(server, false);
    const sent = await sender.postMessage(encodeWechatThreadId(user), {
      markdown: "**Done.** See [the report](https://example.com/r).",
    });
    const send = server.requests.find((request) => request.path === "ilink/bot/sendmessage")!;
    const msg = send.body.msg as Record<string, unknown>;
    expect(msg.to_user_id).toBe(user);
    expect(msg.context_token).toBe("ctx-1");
    expect(msg.client_id).toBe(sent.id);
    const [item] = msg.item_list as { text_item: { text: string } }[];
    expect(item!.text_item.text).not.toContain("**");
    expect(item!.text_item.text).toContain("Done.");

    // A restarted poller continues after the saved cursor.
    for (const adapter of adapters) await adapter.stopPolling();
    const restarted = fakeIlink();
    await chatWith(adapterFor(restarted, true));
    await vi.waitFor(() => expect(restarted.requests.length).toBeGreaterThan(0));
    expect(restarted.requests[0]!.body.get_updates_buf).toBe("cursor-9");
  });

  it("decrypts inbound images on demand", async () => {
    const server = fakeIlink();
    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const plain = Buffer.from("fake-jpeg-bytes");
    server.media.set("img-param", Buffer.concat([cipher.update(plain), cipher.final()]));
    server.batches.push({
      ret: 0,
      get_updates_buf: "c",
      msgs: [
        inbound({
          item_list: [
            {
              type: 2,
              image_item: {
                aeskey: key.toString("hex"),
                media: { encrypt_query_param: "img-param" },
              },
            },
          ],
        }),
      ],
    });
    const received = await chatWith(adapterFor(server, true));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    const [image] = received[0]!.message.attachments;
    expect(image!.type).toBe("image");
    expect(Buffer.from((await image!.fetchData!()) as Buffer).toString()).toBe("fake-jpeg-bytes");
  });

  it("shows typing with a ticket fetched once", async () => {
    const server = fakeIlink();
    const adapter = adapterFor(server, false);
    await adapter.startTyping(encodeWechatThreadId(user));
    await adapter.startTyping(encodeWechatThreadId(user));
    const paths = server.requests.map((request) => request.path);
    expect(paths.filter((path) => path === "ilink/bot/getconfig")).toHaveLength(1);
    expect(paths.filter((path) => path === "ilink/bot/sendtyping")).toHaveLength(2);
  });

  it("pauses polling when the login has expired", async () => {
    // Only timeouts are fake: the poller reads its state file with real I/O.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const settle = async (count: number) => {
      for (let i = 0; i < 200 && server.requests.length < count; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    const server = fakeIlink();
    server.batches.push({ ret: -14, errmsg: "session timeout" });
    await chatWith(adapterFor(server, true));
    await settle(1);
    await vi.advanceTimersByTimeAsync(WECHAT_EXPIRED_PAUSE_MS - 1_000);
    await settle(2);
    expect(server.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle(2);
    expect(server.requests).toHaveLength(2);
  });
});

describe("WeChat platform wiring", () => {
  it("mounts only with a bot token", () => {
    expect(messagingPlatformsFromEnv({}).map((platform) => platform.provider)).toEqual([]);
    const [platform] = messagingPlatformsFromEnv({ wechatBotToken: "t", dataDir: "/tmp/x" });
    expect(platform!.provider).toBe("wechat");
    expect(platform!.capabilities).toEqual({ direct: true, groups: false, receipt: "typing" });
  });

  it("splits long replies at line breaks under the part limit", () => {
    const paragraph = `${"字".repeat(1_200)}\n\n`;
    const parts = splitOutboundBody("wechat", paragraph.repeat(5));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(3_000);
    expect(parts.join("").replace(/\s/g, "")).toBe(paragraph.repeat(5).replace(/\s/g, ""));
    expect(splitOutboundBody("wechat", "short")).toEqual(["short"]);
  });
});
