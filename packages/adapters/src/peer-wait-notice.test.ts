import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bot-messages.js", () => ({
  loadBotMessageContext: vi.fn(),
  messageBot: vi.fn(),
}));

import { loadBotMessageContext, messageBot } from "./bot-messages.js";
import { peerWaitNoticeText, tellRequesterRunWaits } from "./peer-wait-notice.js";
import type { RunContext } from "./run-context.js";

function context(trigger = "bot_message") {
  return {
    deps: { prisma: {}, events: {}, jobs: {} },
    run: {
      id: "run-1",
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-life",
      userId: "user-1",
      trigger,
      sourceMessageId: "message-1",
    },
    bot: { id: "bot-life", name: "Life" },
    attempt: { id: "attempt-1" },
  } as unknown as RunContext;
}

describe("peerWaitNoticeText", () => {
  it("names what the owner must do and where", () => {
    const text = peerWaitNoticeText("Life", {
      kind: "approval",
      title: "Complete a payment on this page?",
      detail: "The page could not be checked, so this may complete a payment.",
    });
    expect(text).toContain("approval card is open in Life's chat in the app");
    expect(text).toContain('"Complete a payment on this page?"');
    expect(text).toContain("The page could not be checked");
    expect(text).toContain("Tell the owner now");
  });

  it("explains a screen takeover", () => {
    const text = peerWaitNoticeText("Life", {
      kind: "takeover",
      reason: "Cloudflare check on linux.do",
    });
    expect(text).toContain("Life's computer screen: Cloudflare check on linux.do");
    expect(text).toContain("takes over the screen");
  });

  it("clips a long card detail", () => {
    const text = peerWaitNoticeText("Life", {
      kind: "approval",
      title: "Run",
      detail: "x".repeat(900),
    });
    expect(text.length).toBeLessThan(700);
  });
});

describe("tellRequesterRunWaits", () => {
  beforeEach(() => {
    vi.mocked(loadBotMessageContext).mockReset();
    vi.mocked(messageBot).mockReset();
  });

  it("sends one status line per pause to the bot that asked", async () => {
    vi.mocked(loadBotMessageContext).mockResolvedValue({
      kind: "bot_message_received",
      fromBotId: "bot-wechat",
      fromBotName: "WeChat",
      text: "look up linux.do",
      intent: "request",
      hop: 1,
      repliesToRequest: false,
    } as Awaited<ReturnType<typeof loadBotMessageContext>>);
    vi.mocked(messageBot).mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof messageBot>>);
    const ctx = context();

    await tellRequesterRunWaits(ctx, { kind: "takeover", reason: "Cloudflare check" });

    expect(messageBot).toHaveBeenCalledWith(
      ctx.deps,
      ctx.run,
      { id: "bot-life", name: "Life" },
      expect.objectContaining({
        bot_id: "bot-wechat",
        intent: "status",
        deliveryKey: "wait-notice:run-1:attempt-1",
      }),
      { waitingSource: true, forceUnread: true },
    );
  });

  it("stays quiet for runs no bot asked for", async () => {
    await tellRequesterRunWaits(context("messaging"), { kind: "answer", title: "Which?" });
    expect(loadBotMessageContext).not.toHaveBeenCalled();
    expect(messageBot).not.toHaveBeenCalled();
  });

  it("does not answer a status or fyi message with a notice", async () => {
    vi.mocked(loadBotMessageContext).mockResolvedValue({
      kind: "bot_message_received",
      fromBotId: "bot-wechat",
      fromBotName: "WeChat",
      text: "fyi",
      intent: "fyi",
      hop: 1,
      repliesToRequest: false,
    } as Awaited<ReturnType<typeof loadBotMessageContext>>);
    await tellRequesterRunWaits(context(), { kind: "answer", title: "Which?" });
    expect(messageBot).not.toHaveBeenCalled();
  });

  it("never fails the pause", async () => {
    vi.mocked(loadBotMessageContext).mockRejectedValue(new Error("db down"));
    await expect(
      tellRequesterRunWaits(context(), { kind: "secret", title: "Password" }),
    ).resolves.toBeUndefined();
  });
});
