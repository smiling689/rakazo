import type { MessageBlock } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  botMessageContext,
  displayName,
  TAKEOVER_COMPUTER_PENDING_STATE,
} from "@rakazo/core";
import type { Prisma } from "@rakazo/db";

/** A run of the target bot, started by the sender's earlier message, that a new message joins. */
export type JoinedPeerRun = {
  runId: string;
  status: string;
  /** When it started working, or when it was queued if it has not started yet. */
  since: Date;
  /** The last step the run took, if any. */
  lastStep?: { tool?: string; at: Date };
  /** What the owner must do, when the run waits on them. */
  waitingFor?: string;
};

const WAIT_TEXT_MAX_CHARS = 200;

/**
 * The target bot's active run (working, or paused on the owner) that the sender started with an
 * earlier request. Runs another bot or the owner started are left alone.
 */
export async function findPeerRunToJoin(
  tx: Prisma.TransactionClient,
  input: { threadId: string; botId: string; fromBotId: string },
): Promise<JoinedPeerRun | undefined> {
  const runs = await tx.run.findMany({
    where: {
      threadId: input.threadId,
      botId: input.botId,
      trigger: "bot_message",
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 10,
    select: {
      id: true,
      status: true,
      createdAt: true,
      startedAt: true,
      sourceMessage: { select: { blocks: true } },
    },
  });
  const run = runs.find(
    (candidate) =>
      botMessageContext((candidate.sourceMessage?.blocks ?? []) as MessageBlock[])?.fromBotId ===
      input.fromBotId,
  );
  if (!run) return undefined;
  const lastStep = await tx.event.findFirst({
    where: { runId: run.id, type: "agent.tool.called" },
    orderBy: { seq: "desc" },
    select: { createdAt: true, payload: true },
  });
  const tool = (lastStep?.payload as { name?: unknown } | null)?.name;
  return {
    runId: run.id,
    status: run.status,
    since: run.startedAt ?? run.createdAt,
    lastStep: lastStep
      ? { at: lastStep.createdAt, tool: typeof tool === "string" ? tool : undefined }
      : undefined,
    waitingFor:
      run.status === "waiting_input" || run.status === "waiting_takeover"
        ? await waitingFor(tx, run.id, run.status)
        : undefined,
  };
}

/** The pending card's title, or the takeover's reason. */
async function waitingFor(
  tx: Prisma.TransactionClient,
  runId: string,
  status: string,
): Promise<string | undefined> {
  const messages = await tx.message.findMany({
    where: { runId, role: "bot" },
    orderBy: { seq: "desc" },
    take: 20,
    select: { blocks: true },
  });
  for (const message of messages) {
    for (const block of (Array.isArray(message.blocks) ? message.blocks : []) as MessageBlock[]) {
      if (status === "waiting_input" && block.kind === "ask" && block.status !== "answered")
        return clip(block.text ?? "");
      if (
        status === "waiting_takeover" &&
        block.kind === "computer" &&
        block.state === TAKEOVER_COMPUTER_PENDING_STATE
      )
        return clip(block.text ?? "");
    }
  }
  return undefined;
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > WAIT_TEXT_MAX_CHARS
    ? `${trimmed.slice(0, WAIT_TEXT_MAX_CHARS)}…`
    : trimmed;
}

function minutesAgo(at: Date, now: number): string {
  const minutes = Math.max(0, Math.round((now - at.getTime()) / 60_000));
  return minutes < 1 ? "under a minute ago" : `${minutes} min ago`;
}

/** What the sender is told: the run's real state, and that no second run was started. */
export function joinedPeerRunNote(
  botName: string,
  joined: JoinedPeerRun,
  now = Date.now(),
): string {
  const name = displayName(botName, "The bot");
  const added = `Your message was added to the run ${name} is already doing for your earlier request; no second run was started.`;
  const step = joined.lastStep
    ? ` Its last step${joined.lastStep.tool ? ` (${joined.lastStep.tool})` : ""} was ${minutesAgo(joined.lastStep.at, now)}.`
    : "";
  switch (joined.status) {
    case "waiting_input":
      return `${added} That run is paused waiting for the owner to answer a card in ${name}'s chat in the app${joined.waitingFor ? `: "${joined.waitingFor}"` : ""}. It reads your message only after the owner answers. Tell the owner what it waits for.`;
    case "waiting_takeover":
      return `${added} That run is paused waiting for the owner on ${name}'s computer screen${joined.waitingFor ? `: "${joined.waitingFor}"` : ""}. It reads your message only after the owner takes over and hands the screen back. Tell the owner what it waits for.`;
    case "queued":
      return `${added} That run has not started yet (queued ${minutesAgo(joined.since, now)}); it reads your message when it starts.`;
    default:
      return `${added} It has been working for ${minutesAgo(joined.since, now).replace(" ago", "")}.${step} It reads your message at its next step and answers a status question with message_bot. Its result comes back to you automatically; do not send more progress checks.`;
  }
}
