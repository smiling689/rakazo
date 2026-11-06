import { describe, expect, it } from "vitest";
import {
  contextChangeNote,
  planPinnedContext,
  replayPrefixKey,
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
});
