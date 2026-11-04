import { getLogger } from "@rakazo/logging";
import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  ChatInstance,
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
  IlinkClient,
  IlinkError,
} from "./ilink-client.js";
import { WechatStateStore } from "./state.js";

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
}

const THREAD_PREFIX = "wechat:";

/** Processing failures are retried here: the cursor has already moved past the message. */
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
 * long-polled, so the server needs no public webhook. Replies are plain text,
 * since WeChat renders no Markdown.
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

  constructor(readonly config: WechatAdapterConfig) {
    this.client = new IlinkClient({
      token: config.token,
      baseUrl: config.baseUrl,
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
    this.store = new WechatStateStore(config.dataDir, config.token);
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
    const options: WebhookOptions = { waitUntil: (task) => void task.catch(() => undefined) };
    chat
      .processMessage(
        this,
        encodeWechatThreadId(raw.from_user_id),
        this.parseMessage(raw),
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

  async postMessage(threadId: string, message: AdapterPostableMessage) {
    const userId = decodeWechatThreadId(threadId);
    const body = outboundText(message).trim();
    if (!body) throw new Error("WeChat message content is empty or unsupported");
    const id = await this.client.sendText(userId, body, await this.store.context(userId));
    return { id, threadId, raw: { client_id: id } as IlinkMessage };
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
