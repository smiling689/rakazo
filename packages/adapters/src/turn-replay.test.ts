import { describe, expect, it } from "vitest";
import {
  contextChangeNote,
  planPinnedContext,
  recordTurnReplay,
  recordTurnTranscript,
  replayPrefixKey,
  replayWindowBefore,
  withSentTurns,
} from "./turn-replay.js";

const now = new Date("2026-01-02T10:00:00Z");
const recently = new Date("2026-01-02T09:50:00Z");

describe("planPinnedContext", () => {
  it("pins the context on a conversation's first replayed turn", () => {
    const plan = planPinnedContext("memory A", {}, "k", now);
    expect(plan).toEqual({
      pinned: "memory A",
      note: undefined,
      record: { context: "memory A", pinned: true, noteBytes: 0, prefixKey: "k" },
    });
  });

  it("keeps the pinned context while nothing changed", () => {
    const plan = planPinnedContext(
      "memory A",
      { last: { prefixKey: "k", noteBytes: 0, createdAt: recently }, pinned: "memory A" },
      "k",
      now,
    );
    expect(plan.pinned).toBe("memory A");
    expect(plan.note).toBeUndefined();
    expect(plan.record).toMatchObject({ context: null, pinned: false });
  });

  it("sends a change as a note and keeps the system prompt", () => {
    const plan = planPinnedContext(
      "line 1\nline 3",
      { last: { prefixKey: "k", noteBytes: 10, createdAt: recently }, pinned: "line 1\nline 2" },
      "k",
      now,
    );
    expect(plan.pinned).toBe("line 1\nline 2");
    expect(plan.note).toContain("- line 2");
    expect(plan.note).toContain("+ line 3");
    expect(plan.record).toMatchObject({ context: "line 1\nline 3", pinned: false });
    expect(plan.record.noteBytes).toBeGreaterThan(10);
  });

  it("diffs against what the last note already told the model", () => {
    const plan = planPinnedContext(
      "a\nb\nc",
      {
        last: { prefixKey: "k", noteBytes: 40, createdAt: recently },
        pinned: "a",
        seen: "a\nb",
      },
      "k",
      now,
    );
    expect(plan.note).toContain("+ c");
    expect(plan.note).not.toContain("+ b");
  });

  it("pins again once the cache is lost anyway or the notes grow large", () => {
    const state = {
      last: { prefixKey: "k", noteBytes: 0, createdAt: recently },
      pinned: "old",
    };
    expect(planPinnedContext("new", state, "other", now).record.pinned).toBe(true);
    expect(
      planPinnedContext(
        "new",
        { ...state, last: { ...state.last, createdAt: new Date("2026-01-02T08:00:00Z") } },
        "k",
        now,
      ).record.pinned,
    ).toBe(true);
    expect(
      planPinnedContext("new", { ...state, last: { ...state.last, noteBytes: 4096 } }, "k", now)
        .record.pinned,
    ).toBe(true);
    expect(planPinnedContext("new", state, "k", now).record.pinned).toBe(false);
  });
});

describe("replayWindowBefore", () => {
  it("keeps the stub window of the last pin while warm, and moves it on a new pin", () => {
    const pinnedAt = new Date("2026-01-02T09:00:00Z");
    const state = {
      last: { prefixKey: "k", noteBytes: 0, createdAt: recently },
      pinned: "memory A",
      pinnedAt,
    };
    expect(replayWindowBefore(planPinnedContext("memory A", state, "k", now), state)).toBe(
      pinnedAt,
    );
    expect(replayWindowBefore(planPinnedContext("memory A", state, "other", now), state)).toBe(
      undefined,
    );
  });
});

describe("contextChangeNote", () => {
  it("counts repeated lines", () => {
    const note = contextChangeNote("x\nx\ny", "x\ny\ny");
    expect(note).toContain("Removed:\n- x");
    expect(note).toContain("Added:\n+ y");
  });
});

describe("replayPrefixKey", () => {
  it("changes with the instructions or the first history item only", () => {
    const history = [
      { id: "1", role: "user" as const, content: "hi" },
      { id: "2", role: "assistant" as const, content: "hello" },
    ];
    const key = replayPrefixKey("sys", history);
    expect(replayPrefixKey("sys", [...history, { role: "user", content: "more" }])).toBe(key);
    expect(replayPrefixKey("sys2", history)).not.toBe(key);
    expect(replayPrefixKey("sys", history.slice(1))).not.toBe(key);
  });
});

describe("withSentTurns", () => {
  it("replays the latest send of each message by this bot", async () => {
    const queries: unknown[] = [];
    const db = {
      turnReplay: {
        findMany: async (query: unknown) => {
          queries.push(query);
          return [
            { messageId: "u1", text: "first send" },
            { messageId: "u1", text: "retried send" },
            { messageId: "b1", text: "peer send" },
          ];
        },
      },
    };
    const result = await withSentTurns(db as never, "t", "bot", [
      { id: "u1", role: "user", content: "hi" },
      { id: "a1", role: "assistant", content: "hello" },
      { id: "b1", role: "assistant", speaker: "Anya", content: "hey" },
      { id: "u2", role: "user", content: "again" },
    ]);
    expect(result.history.map((message) => message.sentText)).toEqual([
      "retried send",
      undefined,
      "peer send",
      undefined,
    ]);
    expect(result).toMatchObject({ replayed: 2, missing: 1 });
    expect(queries[0]).toMatchObject({
      where: { threadId: "t", botId: "bot", messageId: { in: ["u1", "b1", "u2"] } },
    });
  });

  it("replays a run's transcript once, at its first reply, without the steering it carries", async () => {
    const transcript = {
      messages: [{ role: "assistant", content: [] }],
      steeringMessageIds: ["u2"],
    };
    const db = {
      turnReplay: {
        findMany: async (query: { where: { runId?: unknown } }) =>
          query.where.runId
            ? [{ runId: "r1", transcript: JSON.stringify(transcript) }]
            : [{ messageId: "u1", text: "sent u1" }],
      },
    };
    const result = await withSentTurns(
      db as never,
      "t",
      "bot",
      [
        { id: "u1", role: "user", content: "check the files" },
        { id: "a1", role: "assistant", content: "On it." },
        { id: "u2", role: "user", content: "only markdown" },
        { id: "a2", role: "assistant", content: "Two files." },
        { id: "u3", role: "user", content: "thanks" },
        { id: "a3", role: "assistant", content: "Welcome." },
      ],
      new Map([
        ["a1", "r1"],
        ["a2", "r1"],
        ["a3", "r2"],
      ]),
    );
    expect(result.history.map((message) => [message.id, message.sentReply])).toEqual([
      ["u1", undefined],
      ["a1", transcript.messages],
      ["u3", undefined],
      ["a3", undefined],
    ]);
    expect(result.history[0]?.sentText).toBe("sent u1");
    expect(result.transcripts).toBe(1);
  });
});

describe("turn transcripts", () => {
  it("stores a transcript on the run's row, and a new send of the run clears it", async () => {
    const updates: unknown[] = [];
    const db = {
      turnReplay: {
        findUnique: async () => ({ id: "row-1" }),
        update: async (args: unknown) => {
          updates.push(args);
          return { id: "row-1" };
        },
      },
    };
    await recordTurnTranscript(db as never, "run-1", {
      messages: [{ role: "assistant" }],
      steeringMessageIds: [],
    });
    await recordTurnReplay(db as never, {
      spaceId: "s",
      threadId: "t",
      botId: "bot",
      runId: "run-1",
      messageId: "u1",
      text: "again",
      context: null,
      pinned: false,
      noteBytes: 0,
      prefixKey: "k",
    });
    expect(updates).toEqual([
      {
        where: { id: "row-1" },
        data: { transcript: '{"messages":[{"role":"assistant"}],"steeringMessageIds":[]}' },
        select: { id: true },
      },
      expect.objectContaining({ data: expect.objectContaining({ transcript: null }) }),
    ]);
  });
});
