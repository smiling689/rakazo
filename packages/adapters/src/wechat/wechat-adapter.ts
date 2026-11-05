import { getLogger } from "@rakazo/logging";
import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  ChatInstance,
  FileUpload,
  FormattedContent,
  WebhookOptions,
} from "chat";
import {
  Message,
  markdownToPlainText,
  NotImplementedError,
  paragraph,
  root,
  stringifyMarkdown,
  text,
  toPlainText,
} from "chat";
import type { IlinkMessage, IlinkMessageItem } from "./ilink-client.js";
import {
  ILINK_ITEM,
  ILINK_LONG_POLL_TIMEOUT_MS,
  ILINK_SESSION_EXPIRED,
  ILINK_UPLOAD,
  IlinkClient,
  IlinkError,
} from "./ilink-client.js";
import { WechatStateStore } from "./state.js";
import { extractStickerTags, StickerLibrary } from "./stickers.js";

export interface WechatAdapterConfig {
  /** Bot token from the QR-code login (`wechat-login` CLI). */
  token: string;
  baseUrl?: string | undefined;
  /** Shared data directory; holds the poll cursor and reply contexts. */
  dataDir: string;
  /** Long-poll inbound after initialize (the API process only). */
  pollInboundMessages: boolean;
  /** Test seam: replace the HTTP boundary. */
  fetch?: typeof fetch;
  /** Test seam: replace the sticker library. */
  stickers?: Pick<StickerLibrary, "pick">;
}

/** WeChat shows these as pictures; anything else goes out as a file. */
const WECHAT_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"]);

const THREAD_PREFIX = "wechat:";

/** Processing failures are retried here: the cursor has already moved past the message. */
/** Sent back when a message has nothing the bot can read (forwarded chat records, link cards, ...). */
export const WECHAT_UNSUPPORTED_REPLY =
  "这条消息我收不到内容：微信的 bot 接口只转发文字、语音、图片、文件和视频，合并转发的聊天记录、链接卡片和小程序都过不来。可以把文字复制过来，或者截图发我。";

export const WECHAT_RETRY_DELAYS_MS = [5_000, 30_000, 120_000];
/** After this many failed polls in a row, wait before polling again. */
const POLL_FAILURES_BEFORE_BACKOFF = 3;
export const WECHAT_POLL_BACKOFF_MS = 30_000;
/** An expired login stays expired until someone scans a new QR code; check back rarely. */
export const WECHAT_EXPIRED_PAUSE_MS = 10 * 60_000;
const TYPING_TICKET_TTL_MS = 10 * 60_000;

export function encodeWechatThreadId(userId: string): string {
  return `${THREAD_PREFIX}${Buffer.from(userId).toString("base64url")}`;
}

export function decodeWechatThreadId(threadId: string): string {
  if (!threadId.startsWith(THREAD_PREFIX)) throw new Error(`Invalid WeChat thread ID: ${threadId}`);
  const userId = Buffer.from(threadId.slice(THREAD_PREFIX.length), "base64url").toString();
  if (!userId) throw new Error(`Invalid WeChat thread ID: ${threadId}`);
  return userId;
}

/**
 * Personal WeChat through Tencent's iLink bot API. Direct messages only: an
 * iLink bot is its own contact and is not delivered group traffic. Inbound is
 * long-polled, so the server needs no public webhook. Replies are plain text
 * (WeChat renders no Markdown), plus the pictures and files a reply attaches and
 * a meme picture for a `[表情:...]` tag (see stickers.ts).
 */
export class WechatAdapter implements Adapter<string, IlinkMessage> {
  readonly name = "wechat";
  readonly userName = "wechat";
  private readonly client: IlinkClient;
  private readonly store: WechatStateStore;
  private chat: ChatInstance | undefined;
  private polling: AbortController | undefined;
  private readonly retries = new Set<ReturnType<typeof setTimeout>>();
  private readonly typingTickets = new Map<string, { ticket: string; expires: number }>();
  private readonly stickers: Pick<StickerLibrary, "pick">;

  constructor(readonly config: WechatAdapterConfig) {
    this.client = new IlinkClient({
      token: config.token,
      baseUrl: config.baseUrl,
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
    this.store = new WechatStateStore(config.dataDir, config.token);
    this.stickers =
      config.stickers ??
      new StickerLibrary({ dataDir: config.dataDir, ...(config.fetch ? { fetch: config.fetch } : {}) });
  }

  async initialize(chat: ChatInstance) {
    this.chat = chat;
    if (this.config.pollInboundMessages && !this.polling) {
      this.polling = new AbortController();
      void this.poll(this.polling.signal);
    }
  }

  /** Stop the long-poll loop; the surface calls this on shutdown. */
  async stopPolling() {
    this.polling?.abort();
    this.polling = undefined;
    for (const timer of this.retries) clearTimeout(timer);
    this.retries.clear();
  }

  async disconnect() {
    await this.stopPolling();
  }

  private async poll(signal: AbortSignal) {
    let cursor = await this.store.cursor();
    let timeoutMs = ILINK_LONG_POLL_TIMEOUT_MS;
    let failures = 0;
    while (!signal.aborted) {
      try {
        const batch = await this.client.getUpdates(cursor, timeoutMs, signal);
        failures = 0;
        timeoutMs = batch.nextTimeoutMs ?? timeoutMs;
        const contexts: Record<string, string> = {};
        for (const raw of batch.messages) {
          if (raw.from_user_id && raw.context_token) {
            contexts[raw.from_user_id] = raw.context_token;
          }
        }
        // Save contexts before dispatching, so a reply can already use them.
        if (batch.cursor !== cursor || Object.keys(contexts).length) {
          await this.store.update(batch.cursor, contexts);
          cursor = batch.cursor;
        }
        for (const raw of batch.messages) this.dispatch(raw);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof IlinkError && error.code === ILINK_SESSION_EXPIRED) {
          getLogger().error("wechat login expired; run the wechat-login CLI and restart", {});
          await sleep(WECHAT_EXPIRED_PAUSE_MS, signal);
          continue;
        }
        // A long-poll that simply ran out of time is not a failure.
        if (error instanceof Error && error.name === "TimeoutError") continue;
        failures++;
        getLogger().warn("wechat poll failed", { error: String(error), failures });
        if (failures >= POLL_FAILURES_BEFORE_BACKOFF) {
          failures = 0;
          await sleep(WECHAT_POLL_BACKOFF_MS, signal);
        }
      }
    }
  }

  /** Hands one inbound message to the Chat SDK, retrying if processing fails. */
  private dispatch(raw: IlinkMessage, attempt = 0) {
    // Our own sends echo back as bot messages; groups never reach an iLink bot.
    if (raw.message_type === 2 || raw.group_id || !raw.from_user_id) return;
    const chat = this.chat;
    if (!chat) return;
    const message = this.parseMessage(raw);
    if (attempt === 0 && !message.text && message.attachments.length === 0) {
      // iLink carries text, voice, image, file and video only; a forwarded chat record, a link card or
      // a mini program arrives without anything readable. Tell the sender instead of dropping it.
      getLogger().info("wechat message without readable content", {
        itemTypes: (raw.item_list ?? []).map((item) => item.type),
      });
      void this.replyUnsupported(raw.from_user_id);
      return;
    }
    const options: WebhookOptions = { waitUntil: (task) => void task.catch(() => undefined) };
    chat
      .processMessage(
        this,
        encodeWechatThreadId(raw.from_user_id),
        message,
        // The first attempt already marked the message seen.
        attempt ? { ...options, deduplicate: false } : options,
      )
      .catch((error: unknown) => {
        const delay = WECHAT_RETRY_DELAYS_MS[attempt];
        getLogger().warn("wechat inbound processing failed", {
          error: String(error),
          retrying: delay !== undefined,
        });
        if (delay === undefined || !this.polling) return;
        const timer = setTimeout(() => {
          this.retries.delete(timer);
          this.dispatch(raw, attempt + 1);
        }, delay);
        timer.unref?.();
        this.retries.add(timer);
      });
  }

  private async replyUnsupported(userId: string) {
    try {
      await this.client.sendText(
        userId,
        WECHAT_UNSUPPORTED_REPLY,
        await this.store.context(userId),
      );
    } catch (error) {
      getLogger().warn("wechat unsupported-message reply failed", { error: String(error) });
    }
  }

  parseMessage(raw: IlinkMessage): Message<IlinkMessage> {
    const userId = raw.from_user_id ?? "unknown";
    const items = raw.item_list ?? [];
    const body = items
      .map((item) => itemText(item))
      .filter(Boolean)
      .join("\n");
    return new Message({
      id: String(raw.message_id ?? raw.seq ?? raw.client_id ?? raw.create_time_ms ?? ""),
      threadId: encodeWechatThreadId(userId),
      text: body,
      // WeChat text is literal: asterisks and underscores are not formatting.
      formatted: root([paragraph([text(body)])]),
      raw,
      author: { userId, userName: userId, fullName: "", isBot: false, isMe: false },
      attachments: items.flatMap((item) => this.attachment(item)),
      isMention: true,
      metadata: {
        dateSent: new Date(raw.create_time_ms ?? Date.now()),
        edited: false,
      },
    });
  }

  private attachment(item: IlinkMessageItem): Attachment[] {
    const download = (media: Parameters<IlinkClient["downloadMedia"]>[0], hexKey?: string) => () =>
      this.client.downloadMedia(media, hexKey);
    if (item.type === ILINK_ITEM.image && item.image_item?.media) {
      const image = item.image_item;
      return [
        {
          type: "image",
          name: "image.jpg",
          mimeType: "image/jpeg",
          fetchData: download(image.media!, image.aeskey),
        },
      ];
    }
    if (item.type === ILINK_ITEM.file && item.file_item?.media) {
      const file = item.file_item;
      const size = Number(file.len);
      return [
        {
          type: "file",
          name: file.file_name || "file",
          mimeType: "application/octet-stream",
          ...(size > 0 ? { size } : {}),
          fetchData: download(file.media!),
        },
      ];
    }
    if (item.type === ILINK_ITEM.video && item.video_item?.media) {
      return [
        {
          type: "video",
          name: "video.mp4",
          mimeType: "video/mp4",
          fetchData: download(item.video_item.media),
        },
      ];
    }
    return [];
  }

  /**
   * Text, then each file (a picture when WeChat can show it), then at most one sticker for a
   * `[表情:...]` tag. One bubble per item; a sticker that cannot be found or sent is dropped
   * quietly so a retry never repeats the text.
   */
  async postMessage(threadId: string, message: AdapterPostableMessage) {
    const userId = decodeWechatThreadId(threadId);
    const context = await this.store.context(userId);
    const { text: body, queries } = extractStickerTags(outboundText(message).trim());
    const files = typeof message === "object" && "files" in message ? (message.files ?? []) : [];
    if (!body && files.length === 0 && queries.length === 0) {
      throw new Error("WeChat message content is empty or unsupported");
    }
    let id = "";
    if (body) id = await this.client.sendText(userId, body, context);
    for (const file of files) id = await this.sendUpload(userId, file, context);
    const query = queries[0];
    if (query) {
      try {
        const sticker = await this.stickers.pick(query);
        if (sticker) {
          id = await this.sendUpload(
            userId,
            { data: Buffer.from(sticker.data), filename: sticker.name, mimeType: sticker.mimeType },
            context,
          );
        }
      } catch (error) {
        getLogger().warn("wechat sticker failed", { error: String(error) });
      }
    }
    return { id, threadId, raw: { client_id: id } as IlinkMessage };
  }

  private async sendUpload(userId: string, file: FileUpload, context: string | undefined) {
    const data = await uploadBytes(file.data);
    const image = WECHAT_IMAGE_TYPES.has(file.mimeType ?? "");
    const uploaded = await this.client.uploadMedia(
      userId,
      data,
      image ? ILINK_UPLOAD.image : ILINK_UPLOAD.file,
    );
    return image
      ? this.client.sendImage(userId, uploaded, context)
      : this.client.sendFile(userId, file.filename, uploaded, context);
  }

  async startTyping(threadId: string) {
    const userId = decodeWechatThreadId(threadId);
    try {
      let cached = this.typingTickets.get(userId);
      if (!cached || cached.expires < Date.now()) {
        const ticket = await this.client.typingTicket(userId, await this.store.context(userId));
        if (!ticket) return;
        cached = { ticket, expires: Date.now() + TYPING_TICKET_TTL_MS };
        this.typingTickets.set(userId, cached);
      }
      await this.client.sendTyping(userId, cached.ticket);
    } catch (error) {
      // A missing typing indicator must never hold up the reply.
      getLogger().warn("wechat typing failed", { error: String(error) });
    }
  }

  async openDM(userId: string) {
    return encodeWechatThreadId(userId);
  }
  isDM() {
    return true;
  }
  encodeThreadId(userId: string) {
    return encodeWechatThreadId(userId);
  }
  decodeThreadId(threadId: string) {
    return decodeWechatThreadId(threadId);
  }
  channelIdFromThreadId(threadId: string) {
    return threadId;
  }
  renderFormatted(content: FormattedContent) {
    return stringifyMarkdown(content);
  }
  async handleWebhook(): Promise<Response> {
    // Inbound is long-polled; nothing posts to a WeChat webhook.
    return new Response("Not found", { status: 404 });
  }
  async editMessage(): Promise<never> {
    throw new NotImplementedError("WeChat messages cannot be edited");
  }
  async deleteMessage(): Promise<never> {
    throw new NotImplementedError("WeChat messages cannot be deleted");
  }
  async addReaction(): Promise<never> {
    throw new NotImplementedError("WeChat reactions are not supported");
  }
  async removeReaction(): Promise<never> {
    throw new NotImplementedError("WeChat reactions are not supported");
  }
  async fetchMessages(): Promise<never> {
    throw new NotImplementedError("WeChat message history is not supported");
  }
  async fetchThread(): Promise<never> {
    throw new NotImplementedError("WeChat thread metadata is not supported");
  }
}

/** The text one item contributes: its words, a voice transcript, or a quoted message. */
function itemText(item: IlinkMessageItem): string {
  const own =
    item.type === ILINK_ITEM.text
      ? (item.text_item?.text ?? "")
      : item.type === ILINK_ITEM.voice
        ? (item.voice_item?.text ?? "")
        : "";
  const quoted = item.ref_msg?.message_item ? itemText(item.ref_msg.message_item) : "";
  const quote = quoted || item.ref_msg?.title || "";
  if (!quote) return own;
  const lines = quote.split("\n").map((line) => `> ${line}`);
  return [...lines, own].filter(Boolean).join("\n");
}

function outboundText(message: AdapterPostableMessage): string {
  if (typeof message === "string") return message;
  if ("markdown" in message && typeof message.markdown === "string") {
    return markdownToPlainText(message.markdown);
  }
  if ("ast" in message && message.ast) return toPlainText(message.ast);
  if ("raw" in message && typeof message.raw === "string") return message.raw;
  return "";
}

async function uploadBytes(data: FileUpload["data"]): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(await data.arrayBuffer());
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
