import { describe, expect, it } from "vitest";
import {
  configuredContextStrategy,
  isMemoryFlushRun,
  memoryFlushNonce,
  memoryFlushSeq,
  planSessionCompaction,
  sessionContextSettings,
} from "./session-context.js";
import { filterStrategicInitiativeTools } from "./strategic-initiative.js";

const settings = {
  thresholdTokens: 1_000,
  keepTokens: 300,
  keepMessages: 4,
  idleMs: 3_600_000,
  idleFloorTokens: 200,
};
const now = new Date("2026-11-06T12:00:00Z");
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);

/** Alternating person/bot messages, oldest first, each `tokens` long. */
function thread(count: number, tokens: number, lastMinutesAgo = 0) {
  return Array.from({ length: count }, (_, index) => ({
    seq: index,
    role: index % 2 === 0 ? "user" : "bot",
    tokens,
    createdAt: at(lastMinutesAgo + (count - 1 - index)),
  }));
}

describe("sessionContextSettings", () => {
  it("defaults to Hermes and OpenClaw numbers and reads overrides", () => {
    expect(sessionContextSettings({})).toEqual({
      thresholdTokens: 131_072,
      keepTokens: 20_000,
      keepMessages: 20,
      idleMs: 3_600_000,
      idleFloorTokens: 26_214,
    });
    expect(
      sessionContextSettings({
        RAKAZO_SESSION_THRESHOLD_TOKENS: "50000",
        RAKAZO_SESSION_IDLE_SECONDS: "1800",
        RAKAZO_SESSION_KEEP_TOKENS: "nope",
      }),
    ).toMatchObject({ thresholdTokens: 50_000, idleMs: 1_800_000, keepTokens: 20_000 });
  });

  it("reads only known strategies", () => {
    expect(configuredContextStrategy({ RAKAZO_CONTEXT_STRATEGY: "session" })).toBe("session");
    expect(configuredContextStrategy({ RAKAZO_CONTEXT_STRATEGY: "everything" })).toBeUndefined();
    expect(configuredContextStrategy({})).toBeUndefined();
  });
});

describe("planSessionCompaction", () => {
  it("leaves a short or recent history alone", () => {
    expect(planSessionCompaction(thread(10, 10, 120), settings, "idle", now)).toBeNull();
    expect(planSessionCompaction(thread(40, 10, 30), settings, "idle", now)).toBeNull();
    expect(planSessionCompaction(thread(40, 10), settings, "check", now)).toBeNull();
  });

  it("folds an idle history past the floor, keeping a tail that starts with the person", () => {
    // 40 messages of 10 tokens: the tail needs 300 tokens, so 30 messages (seq 10-39).
    expect(planSessionCompaction(thread(40, 10, 61), settings, "idle", now)).toBe(9);
    // With 25-token messages the tail is 12 messages, 4 more than keepMessages alone.
    expect(planSessionCompaction(thread(40, 25, 61), settings, "idle", now)).toBe(27);
  });

  it("folds on size once the threshold is passed, even mid-conversation", () => {
    expect(planSessionCompaction(thread(120, 10), settings, "check", now)).toBe(89);
  });

  it("keeps at least keepMessages even when they are huge", () => {
    expect(planSessionCompaction(thread(6, 500), settings, "check", now)).toBe(1);
  });
});

describe("memory flush runs", () => {
  it("carry their fold point in the nonce", () => {
    const nonce = memoryFlushNonce("thread-1", 42);
    expect(memoryFlushSeq(nonce)).toBe(42);
    expect(isMemoryFlushRun({ trigger: "routine", clientNonce: nonce })).toBe(true);
    expect(isMemoryFlushRun({ trigger: "user", clientNonce: nonce })).toBe(false);
    expect(isMemoryFlushRun({ trigger: "routine", clientNonce: "strategic-initiative:x" })).toBe(
      false,
    );
  });

  it("only get the remember tool", () => {
    const tools = ["remember", "message_user", "save_shared_memory", "write_file"].map((name) => ({
      name,
    }));
    expect(
      filterStrategicInitiativeTools(tools, {
        trigger: "routine",
        clientNonce: memoryFlushNonce("thread-1", 3),
      }).map((tool) => tool.name),
    ).toEqual(["remember"]);
    expect(
      filterStrategicInitiativeTools(tools, { trigger: "routine", clientNonce: null }),
    ).toEqual(tools);
  });
});
