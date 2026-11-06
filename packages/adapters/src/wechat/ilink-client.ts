import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * Direct client for Tencent's iLink bot API, which connects a personal WeChat
 * account to a bot through an official QR-code login. Wire format per
 * Tencent's published protocol (github.com/Tencent/openclaw-weixin,
 * docs/protocol.md): JSON over HTTPS, long-polled inbound, per-peer context
 * tokens on replies, and AES-128-ECB encrypted CDN media.
 */
export const ILINK_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const ILINK_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

/** The protocol version these requests follow, sent as 0x00MMNNPP like the reference client. */
const PROTOCOL_VERSION = "2.4.10";
const APP_ID = "bot";
const BOT_AGENT = "Rakazo";
/**
 * Business codes, as Hermes Agent's WeChat adapter handles them
 * (github.com/NousResearch/hermes-agent, plugins/platforms/weixin/adapter.py):
 * -14 is an expired session. On getupdates that is the login (scan a new QR
 * code); on sendmessage it can be just the peer's context token. -2 is the
 * frequency limit, except that with errmsg "unknown error" or "prepare failed"
 * it is a stale session too: the peer has not written for a long time.
 */
export const ILINK_SESSION_EXPIRED = -14;
export const ILINK_RATE_LIMITED = -2;
const ILINK_STALE_SESSION_MESSAGES = new Set(["unknown error", "prepare failed"]);
/** iLink gives no retry-after; its limit holds for minutes once a few messages went out quickly. */
export const ILINK_RATE_LIMIT_RETRY_SECONDS = 180;

export const ILINK_LONG_POLL_TIMEOUT_MS = 35_000;
const ILINK_REQUEST_TIMEOUT_MS = 15_000;
const ILINK_MEDIA_MAX_BYTES = 25_000_000;

export interface IlinkMessageItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: { aeskey?: string; media?: IlinkMedia; mid_size?: number };
  voice_item?: { text?: string; media?: IlinkMedia };
  file_item?: { file_name?: string; len?: string; media?: IlinkMedia };
  video_item?: { media?: IlinkMedia; video_size?: number };
  ref_msg?: { title?: string; message_item?: IlinkMessageItem };
}

export interface IlinkMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  full_url?: string;
  /** 1 on media this client uploads (AES-128-ECB). */
  encrypt_type?: number;
}

/** What `getuploadurl` calls media_type. */
export const ILINK_UPLOAD = { image: 1, video: 2, file: 3 } as const;

/** One file on the CDN, ready to go into an image or file item. */
export interface IlinkUploaded {
  media: IlinkMedia;
  /** Plaintext bytes. */
  size: number;
  /** Ciphertext bytes (an image item's mid_size). */
  cipherSize: number;
}

export interface IlinkMessage {
  seq?: number;
  message_id?: number | string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  group_id?: string;
  /** 1 user, 2 bot. */
  message_type?: number;
  item_list?: IlinkMessageItem[];
  context_token?: string;
}

export const ILINK_ITEM = { text: 1, image: 2, voice: 3, file: 4, video: 5 } as const;

/**
 * What a failed request means for a retry: wait out a rate limit, send again without the
 * peer's context token after a stale session, or give up on a refusal that will not change.
 */
export type IlinkFailure = "rate_limited" | "stale_session" | "permanent";

export class IlinkError extends Error {
  /** Seconds to wait before retrying; the messaging outbox reads it like a platform's retry-after. */
  readonly retryAfter: number | undefined;

  constructor(
    message: string,
    readonly code?: number,
    readonly failure?: IlinkFailure,
  ) {
    super(message);
    this.name = "IlinkError";
    this.retryAfter = failure === "rate_limited" ? ILINK_RATE_LIMIT_RETRY_SECONDS : undefined;
  }
}

export interface IlinkClientConfig {
  token: string;
  baseUrl?: string | undefined;
  /** Test seam: replace the HTTP boundary. */
  fetch?: typeof fetch;
}

export class IlinkClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly config: IlinkClientConfig) {
    this.baseUrl = (config.baseUrl || ILINK_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = config.fetch ?? fetch;
  }

  /** Long-polls for inbound messages after `cursor`; resolves empty when the hold times out. */
  async getUpdates(
    cursor: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ messages: IlinkMessage[]; cursor: string; nextTimeoutMs?: number }> {
    const body = await this.post(
      "ilink/bot/getupdates",
      { get_updates_buf: cursor },
      timeoutMs + 5_000,
      signal,
    );
    const code = failureCode(body);
    if (code !== undefined) {
      throw new IlinkError(`getupdates failed: ${code} ${stringOf(body.errmsg)}`.trim(), code);
    }
    const next = stringOf(body.get_updates_buf);
    const hold = Number(body.longpolling_timeout_ms);
    return {
      messages: Array.isArray(body.msgs) ? (body.msgs as IlinkMessage[]) : [],
      cursor: next || cursor,
      ...(hold > 0 ? { nextTimeoutMs: hold } : {}),
    };
  }

  /** Sends one text message; returns the client id the message was sent under. */
  async sendText(toUserId: string, text: string, contextToken?: string): Promise<string> {
    return this.sendItem(toUserId, { type: ILINK_ITEM.text, text_item: { text } }, contextToken);
  }

  /** Sends an uploaded image (a photo, a chart, a sticker). */
  async sendImage(toUserId: string, uploaded: IlinkUploaded, contextToken?: string): Promise<string> {
    return this.sendItem(
      toUserId,
      { type: ILINK_ITEM.image, image_item: { media: uploaded.media, mid_size: uploaded.cipherSize } },
      contextToken,
    );
  }

  /** Sends an uploaded file under `fileName`. */
  async sendFile(
    toUserId: string,
    fileName: string,
    uploaded: IlinkUploaded,
    contextToken?: string,
  ): Promise<string> {
    return this.sendItem(
      toUserId,
      {
        type: ILINK_ITEM.file,
        file_item: { media: uploaded.media, file_name: fileName, len: String(uploaded.size) },
      },
      contextToken,
    );
  }

  /** One message with one item (WeChat shows one bubble per message). */
  private async sendItem(
    toUserId: string,
    item: IlinkMessageItem,
    contextToken?: string,
  ): Promise<string> {
    const clientId = `rakazo-${randomUUID()}`;
    const body = await this.post(
      "ilink/bot/sendmessage",
      {
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          ...(contextToken ? { context_token: contextToken } : {}),
          item_list: [item],
        },
      },
      ILINK_REQUEST_TIMEOUT_MS,
    );
    const failure = requestFailure("sendmessage", body);
    if (failure) throw failure;
    return clientId;
  }

  /**
   * Encrypts `data` with a fresh AES-128-ECB key and uploads it to the CDN for `toUserId`
   * (getuploadurl, then a POST of the ciphertext; the CDN answers with the download parameter).
   */
  async uploadMedia(
    toUserId: string,
    data: Uint8Array,
    mediaType: (typeof ILINK_UPLOAD)[keyof typeof ILINK_UPLOAD],
  ): Promise<IlinkUploaded> {
    if (data.byteLength > ILINK_MEDIA_MAX_BYTES) {
      throw new IlinkError("media is too large", undefined, "permanent");
    }
    const plain = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const key = randomBytes(16);
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const filekey = randomBytes(16).toString("hex");
    const body = await this.post(
      "ilink/bot/getuploadurl",
      {
        filekey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize: plain.byteLength,
        rawfilemd5: createHash("md5").update(plain).digest("hex"),
        filesize: encrypted.byteLength,
        no_need_thumb: true,
        aeskey: key.toString("hex"),
      },
      ILINK_REQUEST_TIMEOUT_MS,
    );
    const failure = requestFailure("getuploadurl", body);
    if (failure) throw failure;
    const full = stringOf(body.upload_full_url).trim();
    const param = stringOf(body.upload_param);
    if (!full && !param) throw new IlinkError("getuploadurl returned no upload URL");
    const url =
      full ||
      `${ILINK_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(param)}&filekey=${encodeURIComponent(filekey)}`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Uint8Array(encrypted),
          signal: AbortSignal.timeout(60_000),
        });
        if (response.status >= 400 && response.status < 500) {
          // A client error will not get better on retry.
          throw new IlinkError(
            `media upload refused: HTTP ${response.status}`,
            response.status,
            "permanent",
          );
        }
        const download = response.headers.get("x-encrypted-param");
        if (response.status !== 200 || !download) {
          throw new Error(`media upload failed: HTTP ${response.status}`);
        }
        return {
          // aes_key is base64 of the 32-character hex string, as the reference client sends it.
          media: {
            encrypt_query_param: download,
            aes_key: Buffer.from(key.toString("hex")).toString("base64"),
            encrypt_type: 1,
          },
          size: plain.byteLength,
          cipherSize: encrypted.byteLength,
        };
      } catch (error) {
        if (error instanceof IlinkError) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new IlinkError("media upload failed");
  }

  /** A typing ticket for one peer, needed by sendTyping. */
  async typingTicket(userId: string, contextToken?: string): Promise<string | undefined> {
    const body = await this.post(
      "ilink/bot/getconfig",
      { ilink_user_id: userId, ...(contextToken ? { context_token: contextToken } : {}) },
      10_000,
    );
    return failureCode(body) === undefined ? stringOf(body.typing_ticket) || undefined : undefined;
  }

  async sendTyping(userId: string, ticket: string): Promise<void> {
    await this.post(
      "ilink/bot/sendtyping",
      { ilink_user_id: userId, typing_ticket: ticket, status: 1 },
      10_000,
    );
  }

  /** Downloads and decrypts one CDN media object. */
  async downloadMedia(media: IlinkMedia, hexKey?: string): Promise<Buffer> {
    const url =
      media.full_url ||
      (media.encrypt_query_param
        ? `${ILINK_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
        : undefined);
    if (!url) throw new IlinkError("media has no download location");
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new IlinkError(`media download failed: HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length"));
    if (declared > ILINK_MEDIA_MAX_BYTES) throw new IlinkError("media is too large");
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > ILINK_MEDIA_MAX_BYTES) throw new IlinkError("media is too large");
    const key = mediaKey(hexKey, media.aes_key);
    if (!key) return data;
    const decipher = createDecipheriv("aes-128-ecb", key, null);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }

  private async post(
    path: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await this.fetchImpl(`${this.baseUrl}/${path}`, {
      method: "POST",
      headers: {
        ...ilinkHeaders(),
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        Authorization: `Bearer ${this.config.token}`,
        "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString("base64"),
      },
      body: JSON.stringify({ ...payload, base_info: BASE_INFO }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new IlinkError(`${path} failed: HTTP ${response.status}`);
    const text = await response.text();
    if (!text.trim()) return {};
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  }
}

const BASE_INFO = { channel_version: PROTOCOL_VERSION, bot_agent: BOT_AGENT };

/** Headers every iLink request carries, including the unauthenticated QR-code login. */
export function ilinkHeaders(): Record<string, string> {
  const [major = 0, minor = 0, patch = 0] = PROTOCOL_VERSION.split(".").map(Number);
  return {
    "iLink-App-Id": APP_ID,
    "iLink-App-ClientVersion": String(
      ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff),
    ),
  };
}

/** The nonzero `ret` or `errcode` of a response, when it reports a failure. */
function failureCode(body: Record<string, unknown>): number | undefined {
  for (const key of ["ret", "errcode"]) {
    const value = body[key];
    if (typeof value === "number" && value !== 0) return value;
  }
  return undefined;
}

/** A send or upload request's business failure, classified for retries; undefined on success. */
function requestFailure(path: string, body: Record<string, unknown>): IlinkError | undefined {
  const code = failureCode(body);
  if (code === undefined) return undefined;
  const message = stringOf(body.errmsg) || stringOf(body.msg);
  const failure: IlinkFailure | undefined =
    code === ILINK_SESSION_EXPIRED ||
    (code === ILINK_RATE_LIMITED && ILINK_STALE_SESSION_MESSAGES.has(message.trim().toLowerCase()))
      ? "stale_session"
      : code === ILINK_RATE_LIMITED
        ? "rate_limited"
        : undefined;
  return new IlinkError(`${path} failed: ${code} ${message}`.trim(), code, failure);
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Media keys arrive as 32 hex characters, or base64 of either 16 raw bytes or that hex string. */
export function mediaKey(hexKey?: string, base64Key?: string): Buffer | undefined {
  if (hexKey && /^[0-9a-f]{32}$/i.test(hexKey)) return Buffer.from(hexKey, "hex");
  if (!base64Key) return undefined;
  const decoded = Buffer.from(base64Key, "base64");
  if (decoded.byteLength === 16) return decoded;
  const text = decoded.toString("ascii");
  return /^[0-9a-f]{32}$/i.test(text) ? Buffer.from(text, "hex") : undefined;
}
