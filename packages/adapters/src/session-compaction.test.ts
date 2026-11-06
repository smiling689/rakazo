import { beforeEach, describe, expect, it, vi } from "vitest";

const summarize = vi.hoisted(() => vi.fn(async () => "## Goals and requests\n- 新摘要"));
vi.mock("./history-compaction.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  summarizeConversation: summarize,
  transcriptLines: async (_prisma: unknown, _thread: unknown, batch: Array<{ seq: number }>) =>
    batch.map((message) => `User ${message.seq}: ${"字".repeat(1_000)}`),
}));

const { compactSessionHistory } = await import("./session-compaction.js");
const { memoryFlushNonce } = await import("./session-context.js");

const now = new Date("2026-11-06T12:00:00Z");
const text = (chars: number) => [{ kind: "text", text: "字".repeat(chars) }];

function harness(options: {
  messages: number;
  charsEach: number;
  minutesSinceLast: number;
  cursor?: number | null;
  flush?: { seq: number; status: string; minutesAgo?: number } | null;
  /** Characters of reply text in the stored transcript of each bot message's run. */
  transcriptChars?: number;
}) {
  const thread = {
    id: "thread-1",
    botId: "bot-1",
    userId: "user-1",
    spaceId: "space-1",
    nextMessageSeq: options.messages,
    historyCompactedUpToSeq: options.cursor ?? null,
    historyCompactionRetryAfterSeq: null,
    historyCompactionSummary: null as string | null,
    historyCompactionGeneration: 0,
    bot: { archivedAt: null },
  };
  const messages = Array.from({ length: options.messages }, (_, seq) => ({
    seq,
    role: seq % 2 === 0 ? "user" : "bot",
    botId: seq % 2 === 0 ? null : "bot-1",
    runId: seq % 2 === 0 ? null : `run-${seq}`,
    blocks: text(options.charsEach),
    createdAt: new Date(
      now.getTime() - (options.minutesSinceLast + options.messages - 1 - seq) * 60_000,
    ),
  }));
  const runCreate = vi.fn(async () => ({ id: "flush-run" }));
  const tx = {
    $queryRaw: vi.fn(async () => []),
    run: { findUnique: vi.fn(async () => null), create: runCreate },
    task: { create: vi.fn(async () => ({ id: "task-1" })) },
  };
  const update = vi.fn(async (args: { data: Record<string, unknown> }) => {
    Object.assign(thread, args.data);
    return { count: 1 };
  });
  const prisma = {
    thread: { findUniqueOrThrow: vi.fn(async () => ({ ...thread })), updateMany: update },
    run: {
      findFirst: vi.fn(async () =>
        options.flush
          ? {
              status: options.flush.status,
              clientNonce: memoryFlushNonce("thread-1", options.flush.seq),
              createdAt: new Date(now.getTime() - (options.flush.minutesAgo ?? 1) * 60_000),
            }
          : null,
      ),
    },
    message: {
      findMany: vi.fn(async (args: { where: { seq: { gt: number; lte?: number } } }) =>
        messages.filter(
          (message) =>
            message.seq > args.where.seq.gt &&
            (args.where.seq.lte === undefined || message.seq <= args.where.seq.lte),
        ),
      ),
    },
    turnReplay: {
      findMany: vi.fn(async (args: { where: { runId: { in: string[] } } }) =>
        options.transcriptChars
          ? args.where.runId.in.map((runId) => ({
              runId,
              transcript: JSON.stringify({
                messages: [
                  {
                    role: "assistant",
                    content: [{ type: "text", text: "字".repeat(options.transcriptChars!) }],
                  },
                ],
                steeringMessageIds: [],
              }),
            }))
          : [],
      ),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const deps = {
    prisma,
    jobs: { enqueue: vi.fn(async () => undefined) },
    runtime: {},
    memoryProviders: {},
  };
  return { deps, thread, runCreate, update };
}

beforeEach(() => summarize.mockClear());

describe("compactSessionHistory", () => {
  it("does nothing while the history is short or the person is still around", async () => {
    // 30 messages x 1,000 CJK chars is about 30k tokens: over the idle floor, under the threshold.
    const recent = harness({ messages: 30, charsEach: 1_000, minutesSinceLast: 20 });
    await compactSessionHistory(
      recent.deps as never,
      { threadId: "thread-1", reason: "idle" },
      now,
    );
    const check = harness({ messages: 30, charsEach: 1_000, minutesSinceLast: 90 });
    await compactSessionHistory(check.deps as never, { threadId: "thread-1" }, now);
    expect(recent.runCreate).not.toHaveBeenCalled();
    expect(check.runCreate).not.toHaveBeenCalled();
  });

  it("counts the bot's replayed tool work toward the threshold", async () => {
    // The same 30k tokens of messages, plus about 7k tokens of replayed work per reply.
    const h = harness({
      messages: 30,
      charsEach: 1_000,
      minutesSinceLast: 90,
      transcriptChars: 6_000,
    });
    await compactSessionHistory(h.deps as never, { threadId: "thread-1" }, now);
    expect(h.deps.prisma.turnReplay.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ threadId: "thread-1", botId: "bot-1" }),
      }),
    );
    expect(h.runCreate).toHaveBeenCalled();
  });

  it("queues a silent memory flush first when an idle history passes the floor", async () => {
    const h = harness({ messages: 30, charsEach: 1_000, minutesSinceLast: 90 });
    await compactSessionHistory(h.deps as never, { threadId: "thread-1", reason: "idle" }, now);
    // About 20k tokens stay: the last 20 messages (seq 10-29), which start with the person.
    expect(h.runCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        trigger: "routine",
        clientNonce: memoryFlushNonce("thread-1", 9),
        botId: "bot-1",
      }),
      select: { id: true },
    });
    expect(h.deps.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ runId: "flush-run" }) }),
    );
    expect(summarize).not.toHaveBeenCalled();
  });

  it("waits for a running flush, then folds through its point once it ends", async () => {
    const running = harness({
      messages: 30,
      charsEach: 1_000,
      minutesSinceLast: 90,
      flush: { seq: 9, status: "running" },
    });
    await compactSessionHistory(running.deps as never, { threadId: "thread-1" }, now);
    expect(summarize).not.toHaveBeenCalled();

    const done = harness({
      messages: 30,
      charsEach: 1_000,
      minutesSinceLast: 90,
      flush: { seq: 9, status: "completed" },
    });
    await compactSessionHistory(done.deps as never, { threadId: "thread-1" }, now);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(done.thread).toMatchObject({
      historyCompactedUpToSeq: 9,
      historyCompactionSummary: "## Goals and requests\n- 新摘要",
    });
    expect(done.runCreate).not.toHaveBeenCalled();
  });

  it("folds a large range in several passes and folds even after a stuck flush", async () => {
    // 600 messages x 1,000 chars: each pass holds about 150 of them under 160k characters.
    const h = harness({
      messages: 600,
      charsEach: 1_000,
      minutesSinceLast: 90,
      flush: { seq: 579, status: "queued", minutesAgo: 45 },
    });
    await compactSessionHistory(h.deps as never, { threadId: "thread-1" }, now);
    expect(summarize.mock.calls.length).toBeGreaterThan(1);
    expect(h.thread.historyCompactedUpToSeq).toBe(579);
  });

  it("ignores a flush that the cursor already passed and plans a new one", async () => {
    const h = harness({
      messages: 60,
      charsEach: 1_000,
      minutesSinceLast: 90,
      cursor: 20,
      flush: { seq: 9, status: "completed" },
    });
    await compactSessionHistory(h.deps as never, { threadId: "thread-1", reason: "idle" }, now);
    expect(summarize).not.toHaveBeenCalled();
    expect(h.runCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clientNonce: memoryFlushNonce("thread-1", 39) }),
      }),
    );
  });
});
