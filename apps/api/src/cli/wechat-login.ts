import { createInterface } from "node:readline/promises";
import { wechatQrLogin } from "@rakazo/adapters";

/**
 * Operator login for the WeChat channel: prints a QR code to scan with WeChat,
 * then the credentials to put in the environment. Output is line-oriented so
 * deploy tooling can render the QR code elsewhere:
 *   qrcode <content>     encode <content> as a QR code and scan it with WeChat
 *   status <message>     progress
 *   WECHAT_BOT_TOKEN=... and WECHAT_BASE_URL=...  once confirmed
 * Run in the API container: node dist/cli/wechat-login.js
 */
const say = (line: string) => process.stdout.write(`${line}\n`);

const login = await wechatQrLogin({
  showQr: (content) => say(`qrcode ${content}`),
  status: (message) => say(`status ${message}`),
  verificationCode: async () => {
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await prompt.question("Verification code shown in WeChat: ");
    } finally {
      prompt.close();
    }
  },
});
say(`status logged in as bot ${login.botId} for WeChat user ${login.userId}`);
say(`WECHAT_BOT_TOKEN=${login.token}`);
say(`WECHAT_BASE_URL=${login.baseUrl}`);
