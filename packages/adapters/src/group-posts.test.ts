import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  collectGroupReplies,
  GROUP_REPLY_WAIT_MS,
  postToGroup,
  sourceChainHop,
  wakeMembersNamedInReply,
} from "./group-posts.js";

const members = [
  { id: "bot-a", name: "WeChat" },
  { id: "bot-b", name: "Campus" },
  { id: "bot-c", name: "Life" },
];

type StoredMessage = {
  role: string;
  blocks: unknown;
  hop?: number | null;
  runId?: string | null;
  botId?: string | null;
};

function harness(options: {
  groupThreadId?: string;
  messages?: Record<string, StoredMessage>;
  runs?: Record<string, { sourceMessageId: string | null }>;
}) {
  const messages = options.messages ?? {};
  const runs = options.runs ?? {};
  let nextRun = 0;
  const runCreate = vi.fn(async (_args: { data: Record<string, unknown> }) => ({
    id: `woken-${++nextRun}`,
  }));
  const messageCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: "post-1",
    seq: 4,
    ...args.data,
  }));
  const findMessage = vi.fn(async (args: { where: { id?: string } }) => {
    const found = args.where.id ? messages[args.where.id] : undefined;
    return found ? { hop: null, runId: null, botId: null, ...found } : null;
  });
  const tx = {
    $queryRaw: vi.fn(async (..._args: unknown[]) => [{ id: "group-1" }]),
    // Marks the group unread for its Space members.
    $executeRaw: vi.fn(async (..._args: unknown[]) => 1),
    chatGroup: {
      findFirst: vi.fn(async () => ({
        id: "group-1",
        name: "All",
        thread: { id: options.groupThreadId ?? "group-thread" },
        members: members.map((bot) => ({ bot })),
      })),
      update: vi.fn(async () => ({ id: "group-1" })),
    },
    run: {
      findFirst: vi.fn(async () => ({ id: "run-a" })),
      findUnique: vi.fn(async (args: { where: { id: string } }) => ({
        status: "running",
        ...runs[args.where.id],
      })),
      create: runCreate,
    },
    message: {
      findUnique: findMessage,
      findFirst: vi.fn(async () => ({ id: "reply-1" })),
      create: messageCreate,
      update: vi.fn(async () => ({})),
    },
    thread: {
      update: vi.fn(async (args: { select: { nextMessageSeq?: boolean } }) =>
        args.select.nextMessageSeq ? { nextMessageSeq: 5 } : { nextEventSeq: 2 },
      ),
    },
    task: { create: vi.fn(async () => ({ id: "task-1" })) },
    event: { create: vi.fn(async () => ({ seq: 1 })) },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
    message: { findUnique: findMessage, findMany: vi.fn(async () => []) },
    run: tx.run,
  };
  return {
    deps: {
      prisma: prisma as unknown as PrismaClient,
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async (_job: unknown) => undefined) },
    },
    prisma,
    runCreate,
    messageCreate,
    tx,
  };
}

const asker = {
  id: "run-a",
  spaceId: "space-1",
  threadId: "dm-thread",
  botId: "bot-a",
  userId: "user-1",
  sourceMessageId: "user-message",
};

describe("sourceChainHop", () => {
  it("counts a bot's plain replies back to the post that carries a hop", async () => {
    const { prisma } = harness({
      messages: {
        reply: { role: "bot", blocks: [{ kind: "text", text: "@Life" }], runId: "run-b" },
        post: { role: "bot", blocks: [{ kind: "text", text: "@Campus" }], hop: 2 },
      },
      runs: { "run-b": { sourceMessageId: "post" } },
    });
    expect(await sourceChainHop(prisma as unknown as PrismaClient, "reply")).toBe(3);
  });

  it("starts at zero on a person's message", async () => {
    const { prisma } = harness({
      messages: { "user-message": { role: "user", blocks: [{ kind: "text", text: "hi" }] } },
    });
    expect(await sourceChainHop(prisma as unknown as PrismaClient, "user-message")).toBe(0);
  });
});

describe("postToGroup", () => {
  it("wakes only the members it names, as optional replies, and collects for the poster", async () => {
    const h = harness({
      messages: { "user-message": { role: "user", blocks: [{ kind: "text", text: "ask" }] } },
    });
    const result = await postToGroup(h.deps as never, asker, "group-1", {
      message: "@Campus @WeChat 明天有提醒吗",
    });
    expect(result).toMatchObject({ ok: true, woke: ["Campus"] });
    expect(h.messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          threadId: "group-thread",
          role: "bot",
          botId: "bot-a",
          runId: undefined,
          hop: 1,
        }),
      }),
    );
    expect(h.runCreate).toHaveBeenCalledTimes(1);
    expect(h.runCreate.mock.calls[0]?.[0].data).toMatchObject({
      botId: "bot-b",
      threadId: "group-thread",
      trigger: "follow_up",
      groupReplyOptional: true,
      sourceMessageId: "post-1",
    });
    expect(h.deps.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "group.collect",
        payload: { messageId: "post-1", askerRunId: "run-a" },
      }),
    );
  });

  it("reaches every other member with @所有人 and nobody without a name", async () => {
    const everyone = harness({});
    await postToGroup(everyone.deps as never, asker, "group-1", { message: "@所有人 有提醒吗" });
    expect(everyone.runCreate.mock.calls.map((call) => call[0].data.botId)).toEqual([
      "bot-b",
      "bot-c",
    ]);

    const nobody = harness({});
    const result = await postToGroup(nobody.deps as never, asker, "group-1", {
      message: "FYI: done",
    });
    expect(result).toMatchObject({ ok: true, woke: [] });
    expect(nobody.runCreate).not.toHaveBeenCalled();
    expect(nobody.deps.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("refuses once the chain limit is reached", async () => {
    const h = harness({
      messages: {
        "user-message": {
          role: "user",
          blocks: [
            {
              kind: "bot_message_received",
              fromBotId: "bot-c",
              fromBotName: "Life",
              text: "x",
              hop: 6,
            },
          ],
        },
      },
    });
    const result = await postToGroup(h.deps as never, asker, "group-1", { message: "@Campus hi" });
    expect(result).toHaveProperty("error");
    expect(h.messageCreate).not.toHaveBeenCalled();
  });
});

describe("wakeMembersNamedInReply", () => {
  it("wakes the members a group reply names, except itself and the bot whose post it answers", async () => {
    const h = harness({
      groupThreadId: "group-thread",
      messages: {
        post: { role: "bot", blocks: [{ kind: "text", text: "@Campus" }], botId: "bot-a", hop: 1 },
      },
    });
    // No member was woken by this reply yet.
    h.tx.run.findFirst = vi.fn(async () => null) as never;
    await wakeMembersNamedInReply(
      h.deps as never,
      { ...asker, id: "run-b", botId: "bot-b", threadId: "group-thread", sourceMessageId: "post" },
      "group-1",
      "@WeChat 有两项 @Life 你那边呢 @Campus",
    );
    expect(h.runCreate.mock.calls.map((call) => call[0].data)).toEqual([
      expect.objectContaining({
        botId: "bot-c",
        sourceMessageId: "reply-1",
        groupReplyOptional: true,
      }),
    ]);
  });
});

describe("collectGroupReplies", () => {
  function collecting(statuses: string[], createdAt: Date) {
    const h = harness({});
    const sourceRuns = statuses.map((status, index) => ({
      id: `woken-${index}`,
      status,
      bot: members[index + 1]!,
    }));
    Object.assign(h.prisma.message, {
      findUnique: vi.fn(async () => ({
        threadId: "group-thread",
        hop: 2,
        createdAt,
        thread: { group: { name: "All" } },
        sourceRuns,
      })),
      findMany: vi.fn(async () => [
        { runId: "woken-0", blocks: [{ kind: "text", text: "Canvas 08:00" }] },
      ]),
    });
    h.tx.message.findUnique = vi.fn(async () => null) as never;
    Object.assign(h.prisma.run, {
      findUnique: vi.fn(async () => ({
        spaceId: "space-1",
        userId: "user-1",
        threadId: "dm-thread",
        botId: "bot-a",
        bot: { archivedAt: null },
      })),
    });
    return h;
  }

  it("checks again while a named member is still working", async () => {
    const h = collecting(["completed", "running"], new Date());
    await collectGroupReplies(h.deps as never, { messageId: "post-1", askerRunId: "run-a" });
    expect(h.deps.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "group.collect" }),
    );
    expect(h.messageCreate).not.toHaveBeenCalled();
  });

  it("hands the poster every member's reply in one wake once they finish", async () => {
    const h = collecting(["completed", "completed"], new Date());
    await collectGroupReplies(h.deps as never, { messageId: "post-1", askerRunId: "run-a" });
    expect(h.messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          threadId: "dm-thread",
          role: "user",
          clientNonce: "group-replies:post-1",
          blocks: [
            expect.objectContaining({ fromBotName: "Campus", text: "Canvas 08:00", hop: 2 }),
            expect.objectContaining({ fromBotName: "Life", text: "(no reply)" }),
          ],
        }),
      }),
    );
    expect(h.runCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ botId: "bot-a", trigger: "bot_message" }),
      }),
    );
  });

  it("stops waiting after the reply window", async () => {
    const h = collecting(
      ["completed", "running"],
      new Date(Date.now() - GROUP_REPLY_WAIT_MS - 1000),
    );
    await collectGroupReplies(h.deps as never, { messageId: "post-1", askerRunId: "run-a" });
    expect(h.messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blocks: [
            expect.objectContaining({ fromBotName: "Campus" }),
            expect.objectContaining({
              fromBotName: "Life",
              text: expect.stringContaining("still working"),
            }),
          ],
        }),
      }),
    );
  });
});
