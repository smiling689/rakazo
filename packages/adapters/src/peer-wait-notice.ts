import { displayName } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { loadBotMessageContext, messageBot } from "./bot-messages.js";
import type { RunContext } from "./run-context.js";

/** What a paused run waits for: a question, an approval (payments too), a secret, or the screen. */
export type PeerWait =
  | { kind: "answer"; title: string }
  | { kind: "approval"; title: string; detail?: string }
  | { kind: "secret"; title: string }
  | { kind: "takeover"; reason: string };

const DETAIL_MAX_CHARS = 300;

/**
 * The status line the asking bot gets. It names what the owner must do and where, because the card or
 * screen waits in this bot's chat in the app, which the owner is not looking at.
 */
export function peerWaitNoticeText(botName: string, wait: PeerWait): string {
  const name = displayName(botName, "The bot");
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
  const tail = `${name} does nothing more on this request until then. Tell the owner now; messaging ${name} again does not move it.`;
  switch (wait.kind) {
    case "answer":
      return `Waiting for the owner: ${name} asked a question in its chat in the app: "${clip(wait.title, 300)}". The owner answers it there. ${tail}`;
    case "approval": {
      const detail = wait.detail?.trim() ? ` (${clip(wait.detail.trim(), DETAIL_MAX_CHARS)})` : "";
      return `Waiting for the owner: an approval card is open in ${name}'s chat in the app: "${clip(wait.title, 200)}"${detail}. Only the owner can allow or deny it there. ${tail}`;
    }
    case "secret":
      return `Waiting for the owner: ${name} needs "${clip(wait.title, 200)}" entered securely in its chat in the app. Never ask the owner to send it in chat. ${tail}`;
    case "takeover":
      return `Waiting for the owner on ${name}'s computer screen: ${clip(wait.reason, 300)}. The owner opens ${name}'s chat in the app, takes over the screen, and hands it back when done; ${name} then continues. ${tail}`;
  }
}

/**
 * A run another bot woke has just paused for the owner. Tell that bot, which is the one talking to the
 * owner, so the wait does not sit unseen in this bot's chat. One notice per pause (keyed by attempt);
 * never fails the pause.
 */
export async function tellRequesterRunWaits(ctx: RunContext, wait: PeerWait): Promise<void> {
  const { deps, run, bot } = ctx;
  if (run.trigger !== "bot_message") return;
  try {
    const source = await loadBotMessageContext(deps.prisma, run.sourceMessageId);
    if (!source) return;
    const intent = source.intent ?? "request";
    if (intent !== "request" && intent !== "question") return;
    const sent = await messageBot(
      deps,
      run,
      { id: bot.id, name: bot.name },
      {
        bot_id: source.fromBotId,
        message: peerWaitNoticeText(bot.name, wait),
        intent: "status",
        deliveryKey: `wait-notice:${run.id}:${ctx.attempt.id}`,
      },
      { waitingSource: true, forceUnread: true },
    );
    if (!sent.ok)
      getLogger().warn("peer wait notice not sent", { runId: run.id, error: sent.error });
  } catch (error) {
    getLogger().error("peer wait notice", error);
  }
}
