import type * as db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRelayDeps } from "./approval-relay.js";
import { relayPeerAsk, retireStaleRelays, settleApprovalRelay } from "./approval-relay.js";

const stored: Array<{ threadId: string; blocks: unknown[]; runId?: string }> = [];
const retired: string[] = [];
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof db>()),
  createThreadMessageInTransaction: vi.fn(async (_tx, input) => {
    stored.push(input);
    return { id: `relay-msg-${stored.length}` };
  }),
  appendEventInTransaction: vi.fn(async () => ({ seq: 7 })),
  retireWaitingQuestionInTransaction: vi.fn(async (_tx, input) => {
    retired.push(input.runId);
    return true;
  }),
  cancelRunsInTransaction: vi.fn(async () => []),
}));

type Row = Record<string, unknown>;

/** In-memory rows for the few tables the relay touches. */
function fakeDeps(rows: { runs: Row[]; messages: Row[]; threads: Row[]; identities?: Row[] }) {
  const outbound: Row[] = [];
  const created: Row[] = [];
  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === "object" && !(value instanceof Date)) {
        const condition = value as { startsWith?: string; lte?: Date };
        if (condition.startsWith !== undefined)
          return String(row[key] ?? "").startsWith(condition.startsWith);
        if (condition.lte !== undefined) return true;
      }
      return row[key] === value;
    });
  const run = {
    findUnique: vi.fn(async ({ where }: { where: Row }) => {
      const found = rows.runs.find((row) => row.id === where.id);
      return found ? { ...found, bot: { name: found.botName } } : null;
    }),
    findFirst: vi.fn(
      async ({ where }: { where: Row }) =>
        [...rows.runs, ...created].find((row) => matches(row, where)) ?? null,
    ),
    findMany: vi.fn(async ({ where }: { where: Row }) =>
      rows.runs.filter((row) => matches(row, where)),
    ),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { id: `relay-run-${created.length + 1}`, ...data };
      created.push(row);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows.runs.find((candidate) => matches(candidate, where));
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
  };
  const message = {
    findUnique: vi.fn(
      async ({ where }: { where: Row }) => rows.messages.find((row) => row.id === where.id) ?? null,
    ),
    findFirst: vi.fn(
      async ({ where }: { where: Row }) =>
        [...rows.messages].reverse().find((row) => matches(row, where)) ?? null,
    ),
    findMany: vi.fn(async ({ where }: { where: Row }) =>
      [...rows.messages].reverse().filter((row) => matches(row, { threadId: where.threadId })),
    ),
  };
  const prisma = {
    run,
    message,
    task: {
      create: vi.fn(async ({ data }: { data: Row }) => ({ id: "relay-task", ...data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findFirst: vi.fn(
        async ({ where }: { where: Row }) =>
          rows.threads.find((row) => matches(row, where)) ?? null,
      ),
    },
    messagingIdentity: {
      findUnique: vi.fn(
        async ({ where }: { where: Row }) =>
          rows.identities?.find((row) => row.botId === where.botId) ?? null,
      ),
    },
    messagingOutbound: {
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        outbound.push(...data);
        return { count: data.length };
      }),
      findFirst: vi.fn(
        async ({ where }: { where: Row }) =>
          outbound.find((row) => row.idempotencyKey === where.idempotencyKey) ?? null,
      ),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    $queryRaw: vi.fn(async () => []),
  };
  const deps = {
    prisma,
    events: { answerRunInput: vi.fn(async () => true), notify: vi.fn(async () => undefined) },
    jobs: { enqueue: vi.fn(async () => undefined) },
  };
  return { deps: deps as unknown as ApprovalRelayDeps & typeof deps, outbound, created };
}

const approval = {
  kind: "ask",
  text: "Run mcp\\_\\_smiling-ops\\_\\_run\\_command?",
  detail: "systemctl reload caddy",
  approvalEffectId: "eff-1",
  actions: [
    { id: "allow", label: "Allow" },
    { id: "always", label: "Always allow" },
    { id: "deny", label: "Deny" },
  ],
};

/** WeChat (messaging run) asked Server, which now waits on an approval. */
function chain(): { runs: Row[]; messages: Row[]; threads: Row[]; identities: Row[] } {
  const earlier = new Date("2026-11-04T10:00:00Z");
  return {
    runs: [
      { id: "run-wechat", botId: "bot-wechat", trigger: "messaging", createdAt: earlier },
      {
        id: "run-server",
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-server",
        botName: "Server",
        threadId: "thread-server",
        status: "waiting_input",
        trigger: "bot_message",
        clientNonce: null,
        createdAt: new Date("2026-11-04T10:01:00Z"),
        sourceMessageId: "msg-received",
      },
    ],
    messages: [
      {
        id: "msg-sent",
        threadId: "thread-wechat",
        role: "bot",
        runId: "run-wechat",
        blocks: [
          { kind: "bot_message_sent", toBotId: "bot-server", toBotName: "Server", text: "reload" },
        ],
      },
      {
        id: "msg-received",
        threadId: "thread-server",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "bot-wechat",
            fromBotName: "WeChat",
            text: "reload",
          },
        ],
      },
      {
        id: "msg-ask",
        threadId: "thread-server",
        role: "bot",
        runId: "run-server",
        blocks: [approval],
      },
    ],
    threads: [
      { id: "thread-wechat", botId: "bot-wechat" },
      { id: "thread-server", botId: "bot-server" },
    ],
    identities: [{ id: "identity-1", botId: "bot-wechat" }],
  };
}

beforeEach(() => {
  stored.length = 0;
  retired.length = 0;
});

describe("approval relay", () => {
  it("copies a waiting peer's approval to the chat the owner is in, and to their chat app", async () => {
    const { deps, outbound, created } = fakeDeps(chain());
    await relayPeerAsk(deps, "run-server");

    expect(created).toEqual([
      expect.objectContaining({
        botId: "bot-wechat",
        threadId: "thread-wechat",
        status: "waiting_input",
        clientNonce: "approval-relay:run-server:msg-ask:0",
      }),
    ]);
    expect(stored[0]!.threadId).toBe("thread-wechat");
    expect(stored[0]!.blocks).toEqual([
      {
        kind: "ask",
        text: "Server 请求你批准：Run mcp__smiling-ops__run_command?\nsystemctl reload caddy",
        status: "pending",
        actions: [
          { id: "allow", label: "允许" },
          { id: "deny", label: "拒绝" },
        ],
      },
    ]);
    expect(outbound).toEqual([
      expect.objectContaining({
        kind: "dm",
        identityId: "identity-1",
        body: expect.stringContaining("1. 允许\n2. 拒绝"),
      }),
    ]);

    // Idempotent per card.
    await relayPeerAsk(deps, "run-server");
    expect(created).toHaveLength(1);
  });

  it("leaves runs a person started alone", async () => {
    const rows = chain();
    rows.runs[1]!.trigger = "user";
    const { deps, created } = fakeDeps(rows);
    await relayPeerAsk(deps, "run-server");
    expect(created).toHaveLength(0);
  });

  it("hands an answered relay to the original card without a model call", async () => {
    const rows = chain();
    rows.runs.push({
      id: "relay-1",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-wechat",
      threadId: "thread-wechat",
      taskId: "relay-task",
      status: "queued",
      clientNonce: "approval-relay:run-server:msg-ask:0",
    });
    rows.messages.push({
      id: "relay-msg",
      threadId: "thread-wechat",
      role: "bot",
      runId: "relay-1",
      blocks: [
        {
          kind: "ask",
          text: "Server 请求你批准：…",
          status: "answered",
          answer: "allow",
          actions: [
            { id: "allow", label: "允许" },
            { id: "deny", label: "拒绝" },
          ],
        },
      ],
    });
    const { deps } = fakeDeps(rows);

    expect(await settleApprovalRelay(deps, "relay-1")).toBe(true);
    expect(deps.events.answerRunInput).toHaveBeenCalledWith({
      spaceId: "space-1",
      threadId: "thread-server",
      runId: "run-server",
      messageId: "msg-ask",
      answeredByUserId: "user-1",
      answer: "allow",
    });
    expect(deps.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-server" } }),
    );
    expect(rows.runs.find((run) => run.id === "relay-1")!.status).toBe("completed");
  });

  it("asks again when the answer cannot be read, and never forwards it", async () => {
    const rows = chain();
    rows.runs.push({
      id: "relay-1",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-wechat",
      threadId: "thread-wechat",
      taskId: "relay-task",
      status: "queued",
      clientNonce: "approval-relay:run-server:msg-ask:0",
    });
    rows.messages.push({
      id: "relay-msg",
      threadId: "thread-wechat",
      role: "bot",
      runId: "relay-1",
      blocks: [
        {
          kind: "ask",
          text: "Server 请求你批准：…",
          status: "answered",
          answer: "sure, but first tell me why",
          actions: [
            { id: "allow", label: "允许" },
            { id: "deny", label: "拒绝" },
          ],
        },
      ],
    });
    const { deps, created } = fakeDeps(rows);

    await settleApprovalRelay(deps, "relay-1");
    expect(deps.events.answerRunInput).not.toHaveBeenCalled();
    expect(created).toEqual([
      expect.objectContaining({ clientNonce: "approval-relay:run-server:msg-ask:1" }),
    ]);
  });

  it("ignores ordinary runs", async () => {
    const { deps } = fakeDeps(chain());
    expect(await settleApprovalRelay(deps, "run-server")).toBe(false);
  });

  it("retires relay cards once the original card moved on", async () => {
    const rows = chain();
    rows.runs[1]!.status = "completed";
    rows.runs.push({
      id: "relay-1",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-wechat",
      threadId: "thread-wechat",
      taskId: "relay-task",
      status: "waiting_input",
      clientNonce: "approval-relay:run-server:msg-ask:0",
    });
    const { deps } = fakeDeps(rows);
    await retireStaleRelays(deps, "run-server");
    expect(retired).toEqual(["relay-1"]);
  });
});
