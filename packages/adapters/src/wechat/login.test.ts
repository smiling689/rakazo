import { describe, expect, it, vi } from "vitest";
import { wechatQrLogin } from "./login.js";

function server(statuses: Record<string, unknown>[]) {
  const urls: string[] = [];
  let codes = 0;
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("get_bot_qrcode")) {
      codes++;
      return Response.json({
        qrcode: `qr-${codes}`,
        qrcode_img_content: `https://qr.example/${codes}`,
      });
    }
    return Response.json(statuses.shift() ?? { status: "wait" });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, urls };
}

function io(fetch: typeof globalThis.fetch) {
  const shown: string[] = [];
  return {
    shown,
    io: {
      fetch,
      showQr: (content: string) => shown.push(content),
      status: () => undefined,
      verificationCode: async () => "1234",
    },
  };
}

describe("wechatQrLogin", () => {
  it("follows a redirect and a verification code to the bot credentials", async () => {
    const fake = server([
      { status: "wait" },
      { status: "scaned_but_redirect", redirect_host: "redirect.example" },
      { status: "need_verifycode" },
      {
        status: "confirmed",
        bot_token: "token-1",
        baseurl: "https://api.example",
        ilink_bot_id: "bot@im.bot",
        ilink_user_id: "owner@im.wechat",
      },
    ]);
    const { io: loginIo, shown } = io(fake.fetch);
    await expect(wechatQrLogin(loginIo)).resolves.toEqual({
      token: "token-1",
      baseUrl: "https://api.example",
      botId: "bot@im.bot",
      userId: "owner@im.wechat",
    });
    expect(shown).toEqual(["https://qr.example/1"]);
    expect(fake.urls.at(-1)).toContain("https://redirect.example/ilink/bot/get_qrcode_status");
    expect(fake.urls.at(-1)).toContain("verify_code=1234");
  });

  it("shows a fresh QR code when one expires", async () => {
    const fake = server([{ status: "expired" }, { status: "confirmed", bot_token: "t" }]);
    const { io: loginIo, shown } = io(fake.fetch);
    const login = await wechatQrLogin(loginIo);
    expect(shown).toEqual(["https://qr.example/1", "https://qr.example/2"]);
    expect(login.baseUrl).toBe("https://ilinkai.weixin.qq.com");
  });
});
