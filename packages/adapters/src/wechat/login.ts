import { randomBytes } from "node:crypto";
import { ILINK_DEFAULT_BASE_URL, ilinkHeaders } from "./ilink-client.js";

/** The bot credentials a confirmed QR-code login returns. */
export interface WechatLogin {
  token: string;
  /** API host to use from now on (WECHAT_BASE_URL). */
  baseUrl: string;
  botId: string;
  /** The WeChat user who scanned and confirmed. */
  userId: string;
}

export interface WechatLoginIo {
  /** Show a QR code; `content` is the string to encode (scan it with WeChat). */
  showQr(content: string): void;
  status(message: string): void;
  /** Ask for the verification code WeChat displays, when it requests one. */
  verificationCode(): Promise<string>;
  /** Test seam: replace the HTTP boundary. */
  fetch?: typeof fetch;
}

const QR_POLL_TIMEOUT_MS = 40_000;
const QR_REFRESHES = 3;

/**
 * Tencent's iLink QR-code login: fetch a code, show it, and poll until the
 * scanning WeChat user confirms. Returns the bot token the adapter needs.
 */
export async function wechatQrLogin(io: WechatLoginIo): Promise<WechatLogin> {
  const fetchImpl = io.fetch ?? fetch;
  for (let refresh = 0; refresh < QR_REFRESHES; refresh++) {
    const created = await json(
      fetchImpl(`${ILINK_DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`, {
        method: "POST",
        headers: {
          ...ilinkHeaders(),
          "Content-Type": "application/json",
          AuthorizationType: "ilink_bot_token",
          "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString("base64"),
        },
        body: JSON.stringify({ local_token_list: [] }),
        signal: AbortSignal.timeout(15_000),
      }),
    );
    const qrcode = text(created.qrcode);
    const content = text(created.qrcode_img_content);
    if (!qrcode || !content) throw new Error("iLink returned no QR code");
    io.showQr(content);

    let pollBase = ILINK_DEFAULT_BASE_URL;
    let verifyCode = "";
    for (;;) {
      const query = new URLSearchParams({
        qrcode,
        ...(verifyCode ? { verify_code: verifyCode } : {}),
      });
      let result: Record<string, unknown>;
      try {
        result = await json(
          fetchImpl(`${pollBase}/ilink/bot/get_qrcode_status?${query}`, {
            headers: ilinkHeaders(),
            signal: AbortSignal.timeout(QR_POLL_TIMEOUT_MS),
          }),
        );
      } catch {
        continue; // The status long-poll timed out or dropped; ask again.
      }
      const status = text(result.status);
      if (status === "confirmed") {
        const token = text(result.bot_token);
        if (!token) throw new Error("iLink confirmed the login without a bot token");
        return {
          token,
          baseUrl: text(result.baseurl) || ILINK_DEFAULT_BASE_URL,
          botId: text(result.ilink_bot_id),
          userId: text(result.ilink_user_id),
        };
      }
      if (status === "scaned") io.status("scanned; confirm the login in WeChat");
      else if (status === "scaned_but_redirect" && text(result.redirect_host)) {
        pollBase = `https://${text(result.redirect_host)}`;
      } else if (status === "need_verifycode") {
        verifyCode = (await io.verificationCode()).trim();
      } else if (status === "verify_code_blocked") {
        throw new Error("too many wrong verification codes; try again later");
      } else if (status === "binded_redirect") {
        throw new Error("this WeChat account is already bound to another bot login");
      } else if (status === "expired") {
        io.status("QR code expired; fetching a new one");
        break;
      }
    }
  }
  throw new Error("the QR code expired too many times");
}

async function json(response: Promise<Response>): Promise<Record<string, unknown>> {
  const result = await response;
  if (!result.ok) throw new Error(`iLink login request failed: HTTP ${result.status}`);
  const parsed: unknown = await result.json();
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
