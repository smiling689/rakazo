import { groupCollectJob, runContinueJob } from "@rakazo/adapter-kit";
import { MessageBlock } from "@rakazo/contracts";
import {
  BOT_MESSAGE_MAX_LENGTH,
  botMessageContext,
  botMessageHopExhausted,
  botMessageMaxHops,
  buildGroupRepliesWakePrompt,
  clampBotMessage,
  mentionedGroupBotIds,
  nextBotMessageHop,
} from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
  lockOwnedGroup,
  touchGroupUpdatedAt,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";
import { runLeaseFor } from "./run-messages.js";

/** How long a bot's group post waits for the members it named before it gets what came in. */
export const GROUP_REPLY_WAIT_MS = 5 * 60_000;
const GROUP_COLLECT_FIRST_CHECK_MS = 20_000;
const GROUP_COLLECT_RECHECK_MS = 15_000;
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

type PostingRun = {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  sourceMessageId?: string | null;
};

function blocksOf(value: unknown): MessageBlock[] {
  const parsed = MessageBlock.array().safeParse(value);
  return parsed.success ? parsed.data : [];
}

/**
 * The bot-to-bot hop of the message that woke a run. Peer messages and handoffs carry it; a
 * bot's group post stores it; a bot's plain reply is one past the run that wrote it. A person's
 * message starts a chain at 0.
 */
export async function sourceChainHop(
  prisma: Pick<Prisma.TransactionClient, "message" | "run">,
  sourceMessageId: string | null | undefined,
): Promise<number> {
  let messageId = sourceMessageId ?? undefined;
  let steps = 0;
  while (messageId && steps <= botMessageMaxHops()) {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { role: true, blocks: true, hop: true, runId: true },
    });
    if (!message) break;
    if (message.hop != null) return message.hop + steps;
    const blocks = blocksOf(message.blocks);
    const handoff = blocks.find(
      (block): block is Extract<MessageBlock, { kind: "handoff" }> => block.kind === "handoff",
    );
    const carried = botMessageContext(blocks)?.hop ?? handoff?.hop;
    if (carried !== undefined) return carried + steps;
    if (message.role !== "bot" || !message.runId) break;
    const writer = await prisma.run.findUnique({
      where: { id: message.runId },
      select: { sourceMessageId: true },
    });
    steps += 1;
    messageId = writer?.sourceMessageId ?? undefined;
  }
  return steps;
}

/** Queue a run for each member a bot's group message named. Their replies are optional. */
async function wakeMembers(
  tx: Prisma.TransactionClient,
  run: Pick<PostingRun, "spaceId" | "userId">,
  threadId: string,
  messageId: string,
  botIds: readonly string[],
  prompt: string,
) {
  const runIds: string[] = [];
  for (const botId of botIds) {
    const task = await tx.task.create({
      data: { spaceId: run.spaceId, botId, threadId, userId: run.userId, prompt, status: "queued" },
    });
    const next = await tx.run.create({
      data: {
        spaceId: run.spaceId,
        botId,
        threadId,
        taskId: task.id,
        userId: run.userId,
        status: "queued",
        trigger: "follow_up",
        groupReplyOptional: true,
        sourceMessageId: messageId,
      },
      select: { id: true },
    });
    runIds.push(next.id);
  }
  return runIds;
}

async function enqueueRuns(deps: Pick<ExecutorDeps, "jobs">, runIds: readonly string[]) {
  for (const runId of runIds) {
    await deps.jobs.enqueue(runContinueJob(runId)).catch((error) => {
      // The queued run is durable and the job reconciler repairs a missed wake.
      getLogger().error("group post enqueue", error);
    });
  }
}

/**
 * A bot posts in a group. Members it names with @Name (or @所有人) wake and may reply there;
 * naming nobody wakes nobody. Posted from outside the group, the replies come back to the
 * poster's chat together once the named members finish.
 */
export async function postToGroup(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs" | "runLease">,
  run: PostingRun,
  groupId: string,
  input: { message: string; deliveryKey?: string },
) {
  const text = input.message.trim();
  if (!text || text.length > BOT_MESSAGE_MAX_LENGTH) {
    return { error: `message must contain 1 to ${BOT_MESSAGE_MAX_LENGTH} characters` } as const;
  }
  const hop = nextBotMessageHop(await sourceChainHop(deps.prisma, run.sourceMessageId));
  if (botMessageHopExhausted(hop)) {
    return {
      error: "bot-to-bot limit reached for this chain; answer with what you already have",
    } as const;
  }
  const committed = await deps.prisma.$transaction(async (tx) => {
    try {
      await lockOwnedGroup(tx, run, groupId);
    } catch (error) {
      if (error instanceof IsolationError)
        return { error: "group is no longer available" } as const;
      throw error;
    }
    const group = await tx.chatGroup.findFirst({
      where: { id: groupId, spaceId: run.spaceId, userId: run.userId, archivedAt: null },
      include: {
        thread: { select: { id: true } },
        members: {
          where: { bot: { archivedAt: null } },
          include: { bot: { select: { id: true, name: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!group?.thread) return { error: "group is no longer available" } as const;
    if (!group.members.some((member) => member.bot.id === run.botId)) {
      return { error: "you are not a member of this group" } as const;
    }
    const threadId = group.thread.id;
    const inGroup = threadId === run.threadId;
    for (const id of [...new Set([run.threadId, threadId])].sort()) {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${id} FOR UPDATE`;
    }
    const active = await tx.run.findFirst({
      where: { id: run.id, threadId: run.threadId, botId: run.botId, status: "running" },
      select: { id: true },
    });
    if (!active) return { error: "source run is no longer active" } as const;

    const clientNonce = `group-post:${input.deliveryKey ?? run.id}`;
    const existing = await tx.message.findUnique({
      where: { threadId_clientNonce: { threadId, clientNonce } },
      select: { sourceRuns: { select: { bot: { select: { name: true } } } } },
    });
    if (existing) {
      return {
        replayed: true,
        groupName: group.name,
        inGroup,
        named: existing.sourceRuns.map((woken) => woken.bot.name),
      } as const;
    }

    const named = mentionedGroupBotIds({
      text,
      members: group.members.map((member) => ({ id: member.bot.id, name: member.bot.name })),
    }).filter((botId) => botId !== run.botId);
    const blocks: MessageBlock[] = [{ kind: "text", text }];
    const message = await createThreadMessageInTransaction(tx, {
      threadId,
      role: "bot",
      blocks,
      botId: run.botId,
      // A post from another chat is not part of that run's own thread history.
      runId: inGroup ? run.id : undefined,
      lease: inGroup ? runLeaseFor(deps, run.id) : undefined,
      clientNonce,
      hop,
    });
    const runIds = await wakeMembers(tx, run, threadId, message.id, named, text);
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId,
      botId: run.botId,
      type: "thread.message.created",
      runId: inGroup ? run.id : undefined,
      lease: inGroup ? runLeaseFor(deps, run.id) : undefined,
      payload: { messageId: message.id, seq: message.seq, role: "bot", blocks, runIds },
    });
    await touchGroupUpdatedAt(tx, groupId);
    return {
      messageId: message.id,
      threadId,
      eventSeq: event.seq,
      runIds,
      inGroup,
      groupName: group.name,
      named: group.members
        .filter((member) => named.includes(member.bot.id))
        .map((member) => member.bot.name),
    } as const;
  });
  if ("error" in committed) return committed;
  if (!("replayed" in committed)) {
    await deps.events.notify(committed.threadId, committed.eventSeq).catch((error) => {
      getLogger().error("group post realtime notification", error);
    });
    await enqueueRuns(deps, committed.runIds);
    if (!committed.inGroup && committed.runIds.length) {
      await deps.jobs
        .enqueue(
          groupCollectJob(
            committed.messageId,
            run.id,
            new Date(Date.now() + GROUP_COLLECT_FIRST_CHECK_MS),
          ),
        )
        .catch((error) => getLogger().error("group collect enqueue", error));
    }
  }
  const names = committed.named.join(", ");
  return {
    ok: true,
    groupName: committed.groupName,
    woke: committed.named,
    note: !committed.named.length
      ? `Posted in ${committed.groupName}. It names no member, so nobody was woken; write @Name or @所有人 to ask someone.`
      : committed.inGroup
        ? `Posted in ${committed.groupName} and woke ${names}. They reply in this group.`
        : `Posted in ${committed.groupName} and woke ${names}. Their replies come back to you here together once they finish (at most about ${GROUP_REPLY_WAIT_MS / 60_000} minutes). End your turn now; do not wait, poll or post again.`,
  };
}

/**
 * A bot's reply in a group wakes the members it names. The member whose post woke it is left
 * out: the reply already reaches it.
 */
export async function wakeMembersNamedInReply(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: PostingRun,
  groupId: string,
  text: string,
) {
  if (!text.includes("@")) return;
  const hop = nextBotMessageHop(await sourceChainHop(deps.prisma, run.sourceMessageId));
  if (botMessageHopExhausted(hop)) return;
  const runIds = await deps.prisma.$transaction(async (tx) => {
    const group = await tx.chatGroup.findFirst({
      where: { id: groupId, spaceId: run.spaceId, userId: run.userId, archivedAt: null },
      include: {
        thread: { select: { id: true } },
        members: {
          where: { bot: { archivedAt: null } },
          include: { bot: { select: { id: true, name: true } } },
        },
      },
    });
    if (group?.thread?.id !== run.threadId) return [];
    const [reply, source] = await Promise.all([
      tx.message.findFirst({
        where: { threadId: run.threadId, runId: run.id, role: "bot" },
        orderBy: { seq: "desc" },
        select: { id: true },
      }),
      run.sourceMessageId
        ? tx.message.findUnique({
            where: { id: run.sourceMessageId },
            select: { role: true, botId: true },
          })
        : null,
    ]);
    if (!reply) return [];
    const asker = source?.role === "bot" ? source.botId : undefined;
    const named = mentionedGroupBotIds({
      text,
      members: group.members.map((member) => ({ id: member.bot.id, name: member.bot.name })),
    }).filter((botId) => botId !== run.botId && botId !== asker);
    if (!named.length) return [];
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
    // A retried completion must not wake the same members twice.
    const already = await tx.run.findFirst({
      where: { sourceMessageId: reply.id },
      select: { id: true },
    });
    if (already) return [];
    return wakeMembers(tx, run, run.threadId, reply.id, named, text);
  });
  await enqueueRuns(deps, runIds);
}

/**
 * Hand the poster the group replies once every member it named has finished, or after
 * GROUP_REPLY_WAIT_MS with whatever came in. Runs again until then.
 */
export async function collectGroupReplies(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  input: { messageId: string; askerRunId: string },
) {
  const post = await deps.prisma.message.findUnique({
    where: { id: input.messageId },
    select: {
      threadId: true,
      hop: true,
      createdAt: true,
      thread: { select: { group: { select: { name: true } } } },
      sourceRuns: {
        orderBy: { createdAt: "asc" },
        select: { id: true, status: true, bot: { select: { id: true, name: true } } },
      },
    },
  });
  if (!post?.sourceRuns.length) return;
  const pending = post.sourceRuns.some((woken) => !TERMINAL_RUN_STATUSES.has(woken.status));
  if (pending && Date.now() < post.createdAt.getTime() + GROUP_REPLY_WAIT_MS) {
    await deps.jobs.enqueue(
      groupCollectJob(
        input.messageId,
        input.askerRunId,
        new Date(Date.now() + GROUP_COLLECT_RECHECK_MS),
      ),
    );
    return;
  }
  const asker = await deps.prisma.run.findUnique({
    where: { id: input.askerRunId },
    select: {
      spaceId: true,
      userId: true,
      threadId: true,
      botId: true,
      bot: { select: { archivedAt: true } },
    },
  });
  if (!asker || asker.bot.archivedAt) return;

  const written = await deps.prisma.message.findMany({
    where: {
      threadId: post.threadId,
      role: "bot",
      runId: { in: post.sourceRuns.map((woken) => woken.id) },
    },
    orderBy: { seq: "asc" },
    select: { runId: true, blocks: true },
  });
  const replies = post.sourceRuns.map((woken) => {
    const text = written
      .filter((message) => message.runId === woken.id)
      .flatMap((message) => blocksOf(message.blocks))
      .flatMap((block) => (block.kind === "text" ? [block.text] : []))
      .join("\n\n")
      .trim();
    return {
      from: woken.bot,
      text: text
        ? clampBotMessage(text)
        : TERMINAL_RUN_STATUSES.has(woken.status)
          ? "(no reply)"
          : "(still working; a later reply will appear in the group)",
    };
  });
  const hop = post.hop ?? 1;
  const blocks: MessageBlock[] = replies.map((reply) => ({
    kind: "bot_message_received",
    fromBotId: reply.from.id,
    fromBotName: reply.from.name,
    text: reply.text,
    intent: "result",
    hop,
  }));
  const prompt = buildGroupRepliesWakePrompt({
    groupName: post.thread.group?.name ?? "group",
    replies,
  });
  const clientNonce = `group-replies:${input.messageId}`;
  const committed = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${asker.threadId} FOR UPDATE`;
    const existing = await tx.message.findUnique({
      where: { threadId_clientNonce: { threadId: asker.threadId, clientNonce } },
      select: { id: true },
    });
    if (existing) return null;
    const inbound = await createThreadMessageInTransaction(tx, {
      threadId: asker.threadId,
      role: "user",
      blocks,
      clientNonce,
    });
    const task = await tx.task.create({
      data: {
        spaceId: asker.spaceId,
        botId: asker.botId,
        threadId: asker.threadId,
        userId: asker.userId,
        prompt,
        status: "queued",
      },
    });
    const next = await tx.run.create({
      data: {
        spaceId: asker.spaceId,
        botId: asker.botId,
        threadId: asker.threadId,
        taskId: task.id,
        userId: asker.userId,
        status: "queued",
        trigger: "bot_message",
        sourceMessageId: inbound.id,
      },
      select: { id: true },
    });
    await tx.message.update({ where: { id: inbound.id }, data: { runId: next.id } });
    const event = await appendEventInTransaction(tx, {
      spaceId: asker.spaceId,
      threadId: asker.threadId,
      botId: asker.botId,
      type: "thread.message.created",
      runId: next.id,
      payload: { messageId: inbound.id, role: "user", blocks },
    });
    return { runId: next.id, eventSeq: event.seq };
  });
  if (!committed) return;
  await deps.events.notify(asker.threadId, committed.eventSeq).catch((error) => {
    getLogger().error("group replies realtime notification", error);
  });
  await enqueueRuns(deps, [committed.runId]);
}
