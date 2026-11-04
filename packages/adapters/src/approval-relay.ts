import type { JobPublisher } from "@rakazo/adapter-kit";
import { messagingDeliverJob, runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import {
  CARD_TITLE_ESCAPED_CHARACTERS,
  chatAppAskText,
  isApprovalAskBlock,
  isChoiceAskBlock,
  resolveAskChoice,
} from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  cancelRunsInTransaction,
  createThreadMessageInTransaction,
  retireWaitingQuestionInTransaction,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/**
 * Approval relay. A bot woken by another bot's message runs in its own chat, so when it stops for the
 * owner's approval or choice, the card waits where the owner is not looking and the bot that asked never
 * hears about it. The relay copies that card into the chat the owner is in (the bot at the start of the
 * message_bot chain, mirrored to its chat app when the owner wrote from there) as an ordinary choice with
 * its own waiting run. Only a person answers it, exactly as any card: tapping it, typing the option in the
 * composer, or replying with its number from the linked chat app. Its run never reaches the model: the
 * worker hands the answer to the original card (`settleApprovalRelay`) and closes it. The bots involved
 * gain no way to approve anything themselves.
 */

export interface ApprovalRelayDeps {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "answerRunInput" | "notify">;
  jobs: Pick<JobPublisher, "enqueue">;
}

const NONCE_PREFIX = "approval-relay";
const MAX_CHAIN_HOPS = 6;
const DETAIL_MAX_CHARS = 600;
const ALLOW = { id: "allow", label: "允许" };
const DENY = { id: "deny", label: "拒绝" };
const ALLOW_WORDS = new Set(["allow", "1", "允许", "同意", "批准", "yes", "y", "ok", "可以", "好"]);
const DENY_WORDS = new Set(["deny", "2", "拒绝", "不", "不行", "不要", "no", "n"]);
const ESCAPED = new RegExp(`\\\\(${CARD_TITLE_ESCAPED_CHARACTERS})`, "g");

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;
type Target = { runId: string; messageId: string };

/** `approval-relay:<target run>:<target message>:<attempt>`; the run that holds a relay card. */
function relayNonce(target: Target, attempt: number): string {
  return `${NONCE_PREFIX}:${target.runId}:${target.messageId}:${attempt}`;
}
function parseRelayNonce(nonce: string | null): (Target & { attempt: number }) | null {
  const parts = nonce?.split(":");
  if (parts?.length !== 4 || parts[0] !== NONCE_PREFIX) return null;
  const attempt = Number(parts[3]);
  return Number.isInteger(attempt) ? { runId: parts[1]!, messageId: parts[2]!, attempt } : null;
}

function pendingAsk(blocks: unknown): AskBlock | undefined {
  const parsed = MessageBlockSchema.array().safeParse(blocks);
  if (!parsed.success) return undefined;
  return parsed.data.find(
    (block): block is AskBlock => block.kind === "ask" && block.status !== "answered",
  );
}

/** A card the relay can carry: an approval (allow or deny, never "always") or a plain choice. */
function relayable(ask: AskBlock): "approval" | "choice" | undefined {
  if (isApprovalAskBlock(ask)) return "approval";
  if (isChoiceAskBlock(ask)) return "choice";
  return undefined;
}

function relayCard(botName: string, ask: AskBlock, kind: "approval" | "choice"): AskBlock {
  const title = (ask.text ?? "").replace(ESCAPED, "$1").trim();
  const detail = (ask.detail ?? "").trim();
  const shownDetail =
    detail.length > DETAIL_MAX_CHARS ? `${detail.slice(0, DETAIL_MAX_CHARS)}…` : detail;
  const text =
    kind === "approval"
      ? [`${botName} 请求你批准：${title}`, shownDetail].filter(Boolean).join("\n")
      : `${botName} 问你：${title}`;
  return {
    kind: "ask",
    text,
    status: "pending",
    actions:
      kind === "approval" ? [ALLOW, DENY] : ask.actions!.map(({ id, label }) => ({ id, label })),
  };
}

/** Where the owner is: the bot that started the message_bot chain, and how that run began. */
async function chainRoot(
  prisma: PrismaClient,
  run: { botId: string; createdAt: Date; sourceMessageId: string | null },
): Promise<{ botId: string; threadId: string; trigger: string } | null> {
  let current = run;
  let root: { botId: string; threadId: string; trigger: string } | null = null;
  for (let hop = 0; hop < MAX_CHAIN_HOPS && current.sourceMessageId; hop += 1) {
    const source = await prisma.message.findUnique({
      where: { id: current.sourceMessageId },
      select: { blocks: true },
    });
    const received = (source?.blocks as MessageBlock[] | undefined)?.find(
      (block) => block.kind === "bot_message_received",
    );
    if (received?.kind !== "bot_message_received") break;
    const senderThread = await prisma.thread.findFirst({
      where: { botId: received.fromBotId },
      select: { id: true },
    });
    if (!senderThread) break;
    // The sender's echo of this delivery tells which of its runs sent it.
    const echoes = await prisma.message.findMany({
      where: { threadId: senderThread.id, role: "bot", createdAt: { lte: current.createdAt } },
      orderBy: { seq: "desc" },
      take: 30,
      select: { runId: true, blocks: true },
    });
    const echo = echoes.find((message) =>
      (message.blocks as MessageBlock[]).some(
        (block) => block.kind === "bot_message_sent" && block.toBotId === current.botId,
      ),
    );
    const senderRun = echo?.runId
      ? await prisma.run.findUnique({
          where: { id: echo.runId },
          select: { botId: true, createdAt: true, sourceMessageId: true, trigger: true },
        })
      : null;
    root = {
      botId: received.fromBotId,
      threadId: senderThread.id,
      trigger: senderRun?.trigger ?? "user",
    };
    if (senderRun?.trigger !== "bot_message") break;
    current = senderRun;
  }
  return root;
}

/**
 * After a run stops: a bot woken by another bot that now waits on the owner gets its card copied to the
 * chat the owner is in. Idempotent per card.
 */
export async function relayPeerAsk(deps: ApprovalRelayDeps, runId: string): Promise<void> {
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      botId: true,
      status: true,
      trigger: true,
      clientNonce: true,
      createdAt: true,
      sourceMessageId: true,
      bot: { select: { name: true } },
    },
  });
  if (run?.status !== "waiting_input" || run.trigger !== "bot_message") return;
  if (parseRelayNonce(run.clientNonce)) return;
  const message = await deps.prisma.message.findFirst({
    where: { runId, role: "bot" },
    orderBy: { seq: "desc" },
    select: { id: true, blocks: true },
  });
  const ask = message ? pendingAsk(message.blocks) : undefined;
  const kind = ask ? relayable(ask) : undefined;
  if (!message || !ask || !kind) return;
  const root = await chainRoot(deps.prisma, run);
  if (!root || root.botId === run.botId) return;
  await createRelay(deps, {
    spaceId: run.spaceId,
    userId: run.userId,
    root,
    target: { runId, messageId: message.id },
    card: relayCard(run.bot.name, ask, kind),
    attempt: 0,
  });
}

async function createRelay(
  deps: ApprovalRelayDeps,
  input: {
    spaceId: string;
    userId: string;
    root: { botId: string; threadId: string; trigger: string };
    target: Target;
    card: AskBlock;
    attempt: number;
  },
): Promise<void> {
  const clientNonce = relayNonce(input.target, input.attempt);
  if (await deps.prisma.run.findFirst({ where: { clientNonce }, select: { id: true } })) return;
  const { root } = input;
  const committed = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const task = await tx.task.create({
      data: {
        spaceId: input.spaceId,
        botId: root.botId,
        threadId: root.threadId,
        userId: input.userId,
        prompt: input.card.text,
        status: "running",
      },
    });
    const relay = await tx.run.create({
      data: {
        spaceId: input.spaceId,
        botId: root.botId,
        threadId: root.threadId,
        taskId: task.id,
        userId: input.userId,
        status: "waiting_input",
        trigger: "bot_message",
        clientNonce,
        // Nothing to mirror: the chat-app copy is queued below.
        messagingMirroredAt: new Date(),
      },
      select: { id: true },
    });
    const message = await createThreadMessageInTransaction(tx, {
      threadId: root.threadId,
      role: "bot",
      blocks: [input.card],
      botId: root.botId,
      runId: relay.id,
    });
    const event = { spaceId: input.spaceId, threadId: root.threadId, botId: root.botId };
    await appendEventInTransaction(tx, {
      ...event,
      type: "thread.message.created",
      runId: relay.id,
      payload: { messageId: message.id, role: "bot", blocks: [input.card] },
    });
    return appendEventInTransaction(tx, {
      ...event,
      type: "run.waiting_input",
      runId: relay.id,
      payload: { userId: input.userId },
    });
  });
  await deps.events.notify(root.threadId, committed.seq).catch(() => undefined);
  // The owner wrote from a chat app: the card goes there too, answerable by its number.
  const identity =
    root.trigger === "messaging"
      ? await deps.prisma.messagingIdentity.findUnique({ where: { botId: root.botId } })
      : null;
  const body = chatAppAskText(input.card);
  if (identity && body) {
    await deps.prisma.messagingOutbound.createMany({
      data: [{ idempotencyKey: clientNonce, kind: "dm", identityId: identity.id, body }],
      skipDuplicates: true,
    });
    await deps.jobs.enqueue(messagingDeliverJob()).catch((error) => {
      getLogger().error("approval relay delivery enqueue", error);
    });
  }
}

function decision(answer: string, card: AskBlock): string | undefined {
  const normalized = answer
    .trim()
    .toLowerCase()
    .replace(/[\s.。!！,，]+$/u, "");
  const isApproval = card.actions?.some((action) => action.id === ALLOW.id);
  if (isApproval) {
    if (ALLOW_WORDS.has(normalized)) return ALLOW.id;
    if (DENY_WORDS.has(normalized)) return DENY.id;
    return undefined;
  }
  const number = /^[1-9]$/.test(normalized) ? card.actions?.[Number(normalized) - 1] : undefined;
  return (number ?? resolveAskChoice(answer, card.actions))?.label;
}

/**
 * A relay run the worker was asked to continue: hand the owner's answer to the original card and close
 * the relay without a model call. Returns false for every other run.
 */
export async function settleApprovalRelay(
  deps: ApprovalRelayDeps,
  runId: string,
): Promise<boolean> {
  const relay = await deps.prisma.run.findUnique({
    where: { id: runId },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      botId: true,
      threadId: true,
      taskId: true,
      status: true,
      clientNonce: true,
    },
  });
  const ref = parseRelayNonce(relay?.clientNonce ?? null);
  if (!relay || !ref) return false;
  if (relay.status !== "queued") return true;
  const relayMessage = await deps.prisma.message.findFirst({
    where: { runId, role: "bot" },
    orderBy: { seq: "desc" },
    select: { blocks: true },
  });
  const card = (relayMessage?.blocks as MessageBlock[] | undefined)?.find(
    (block): block is AskBlock => block.kind === "ask",
  );
  const target = await deps.prisma.run.findUnique({
    where: { id: ref.runId },
    select: { spaceId: true, threadId: true, userId: true, status: true },
  });
  const answer = card?.answer ? decision(card.answer, card) : undefined;
  let forwarded = false;
  if (
    card &&
    answer &&
    target?.status === "waiting_input" &&
    target.spaceId === relay.spaceId &&
    target.userId === relay.userId
  ) {
    forwarded = await deps.events.answerRunInput({
      spaceId: target.spaceId,
      threadId: target.threadId,
      runId: ref.runId,
      messageId: ref.messageId,
      answeredByUserId: relay.userId,
      answer,
    });
    if (forwarded) await deps.jobs.enqueue(runContinueJob(ref.runId));
  }
  await closeRelay(deps, relay, "completed");
  // An answer the relay could not read (free text in the composer or chat app) asks again.
  if (!forwarded && card && target?.status === "waiting_input" && ref.attempt < 3) {
    // Same place as before: the chat app too if the last copy went there.
    const sentToChatApp = await deps.prisma.messagingOutbound.findFirst({
      where: { idempotencyKey: relayNonce(ref, ref.attempt) },
      select: { id: true },
    });
    await createRelay(deps, {
      spaceId: relay.spaceId,
      userId: relay.userId,
      root: {
        botId: relay.botId,
        threadId: relay.threadId,
        trigger: sentToChatApp ? "messaging" : "user",
      },
      target: ref,
      card: { ...card, status: "pending", answer: undefined },
      attempt: ref.attempt + 1,
    });
  }
  return true;
}

async function closeRelay(
  deps: ApprovalRelayDeps,
  relay: { id: string; spaceId: string; threadId: string; botId: string; taskId: string },
  status: "completed",
): Promise<void> {
  const now = new Date();
  const committed = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const closed = await tx.run.updateMany({
      where: { id: relay.id, status: "queued" },
      data: { status, completedAt: now, checkpoint: null },
    });
    if (closed.count !== 1) return null;
    await tx.task.updateMany({ where: { id: relay.taskId }, data: { status } });
    return appendEventInTransaction(tx, {
      spaceId: relay.spaceId,
      threadId: relay.threadId,
      botId: relay.botId,
      type: "run.completed",
      runId: relay.id,
      payload: {},
    });
  });
  if (committed) await deps.events.notify(relay.threadId, committed.seq).catch(() => undefined);
}

/**
 * The original card moved on (answered in its own chat, or the run ended): retire relay cards still
 * waiting for it, so a stale copy cannot be answered.
 */
export async function retireStaleRelays(deps: ApprovalRelayDeps, runId: string): Promise<void> {
  const target = await deps.prisma.run.findUnique({
    where: { id: runId },
    select: { status: true },
  });
  if (!target || target.status === "waiting_input") return;
  const relays = await deps.prisma.run.findMany({
    where: { clientNonce: { startsWith: `${NONCE_PREFIX}:${runId}:` }, status: "waiting_input" },
    select: { id: true, spaceId: true, threadId: true, botId: true, taskId: true, userId: true },
  });
  for (const relay of relays) {
    const committed = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${relay.threadId} FOR UPDATE`;
      const retired = await retireWaitingQuestionInTransaction(tx, {
        spaceId: relay.spaceId,
        threadId: relay.threadId,
        botId: relay.botId,
        runId: relay.id,
        answer: "已在原对话处理",
      });
      if (retired) return true;
      await cancelRunsInTransaction(tx, [relay], new Date());
      return true;
    });
    if (committed) getLogger().info("approval relay retired", { relayRunId: relay.id });
  }
}
