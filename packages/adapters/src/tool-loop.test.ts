import { describe, expect, it } from "vitest";
import { observationToolResult } from "./computer-tools.js";
import type { ToolCallRecord, ToolLoopVerdict } from "./tool-loop.js";
import {
  admitToolCall,
  advanceOverLimitActionCalls,
  isLoopGuardStopText,
  loopGuardStopText,
  MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS,
  overLimitStopText,
  toolResultFingerprint,
} from "./tool-loop.js";

const answer = (text: string) => toolResultFingerprint({ content: [{ type: "text", text }] });
const failure = (text = "missing script") => toolResultFingerprint(undefined, new Error(text));

type Call = { name: string; args: unknown; response?: number };

/**
 * Plays `call(n)` for n = 1..limit through one history, one model response each unless the call
 * names one. A call that runs gets `seen(n)` as its answer; a refused one gets none.
 */
function play(
  call: (n: number) => Call,
  seen: (n: number) => string | undefined,
  limit = 60,
): ToolLoopVerdict[] {
  const history: ToolCallRecord[] = [];
  const verdicts: ToolLoopVerdict[] = [];
  for (let n = 1; n <= limit; n += 1) {
    const { name, args, response = n } = call(n);
    const { verdict, record } = admitToolCall(history, name, args, response);
    verdicts.push(verdict);
    if (verdict.action === "stop") break;
    if (record && verdict.action === "run") record.result = seen(n);
  }
  return verdicts;
}

const actions = (verdicts: ToolLoopVerdict[]) => verdicts.map((verdict) => verdict.action);
const stopsAt = (verdicts: ToolLoopVerdict[]) =>
  verdicts.at(-1)?.action === "stop" ? verdicts.length : undefined;
const catLog = () => ({ name: "shell", args: { command: "cat job.log" } });

describe("admitToolCall", () => {
  it("refuses a call that keeps failing the same way at its third time and stops at its fifth", () => {
    const verdicts = play(catLog, () => failure());

    expect(actions(verdicts)).toEqual(["run", "run", "warn", "warn", "stop"]);
    expect(verdicts[2]).toMatchObject({
      action: "warn",
      text: expect.stringMatching(
        /^Not run: you have called shell with the same input 3 times and it failed the same way/,
      ),
    });
    expect(verdicts[4]).toEqual({ action: "stop", tools: ["shell"], repeats: 5 });
  });

  it("gives a call that keeps answering the same way room to wait before warning", () => {
    const verdicts = play(catLog, () => answer("Still loading"));

    expect(actions(verdicts)).toEqual([...Array(9).fill("run"), "warn", "warn", "stop"]);
    expect(verdicts[9]).toMatchObject({
      text: expect.stringContaining("If you are waiting for something, wait longer"),
    });
  });

  it("catches calls that alternate without a new answer", () => {
    const verdicts = play(
      (n) =>
        n % 2
          ? { name: "read_file", args: { path: "notes/plan.md" } }
          : { name: "list_files", args: { path: "notes" } },
      () => failure(),
    );

    // Each call's third time is warned, its fifth ends the turn.
    expect(actions(verdicts)).toEqual([...Array(4).fill("run"), ...Array(4).fill("warn"), "stop"]);
    expect(verdicts[4]).toMatchObject({
      text: expect.stringContaining("repeated the same 2 calls (list_files, read_file) 3 times"),
    });
    expect(verdicts.at(-1)).toEqual({
      action: "stop",
      tools: ["list_files", "read_file"],
      repeats: 5,
    });
  });

  it("catches a cycle of three calls with unchanged answers", () => {
    const tools = ["browser_snapshot", "browser_act", "web_fetch"];
    const verdicts = play(
      (n) => ({ name: tools[n % 3]!, args: { ref: "e1" } }),
      (n) => answer(`same ${n % 3}`),
    );
    // The twelfth lap's first call ends it.
    expect(stopsAt(verdicts)).toBe(3 * 11 + 1);
  });

  it("lets a status poll go on while its answer changes", () => {
    const poll = () => ({ name: "cloud_agent_status", args: { id: "job-1" } });
    expect(stopsAt(play(poll, (n) => answer(`Downloaded ${n}%`)))).toBeUndefined();
    expect(actions(play(poll, (n) => answer(`Downloaded ${n}%`))).every((a) => a === "run")).toBe(
      true,
    );
    // Waiting on a download: unchanged for a while, then it lands.
    expect(
      actions(play(poll, (n) => answer(n <= 8 ? "[]" : "[report.csv]"), 9)).every(
        (a) => a === "run",
      ),
    ).toBe(true);
  });

  it("lets a sleep-then-check wait loop go on while the check changes", () => {
    const verdicts = play(
      (n) =>
        n % 2
          ? { name: "shell", args: { command: "sleep 30" } }
          : { name: "list_files", args: { path: "downloads" } },
      (n) => answer(n % 2 ? "" : `${n} bytes`),
    );
    expect(actions(verdicts).every((a) => a === "run")).toBe(true);
  });

  it("treats a changing cursor as a different call", () => {
    const verdicts = play(
      (n) => ({ name: "mcp__open-connector__execute_action", args: { cursor: `page-${n}` } }),
      () => answer("[]"),
    );
    expect(actions(verdicts).every((a) => a === "run")).toBe(true);
  });

  it("ignores key order in the arguments", () => {
    const verdicts = play(
      (n) => ({
        name: "web_fetch",
        args: n % 2 ? { url: "u", mode: "text" } : { mode: "text", url: "u" },
      }),
      () => failure(),
    );
    expect(stopsAt(verdicts)).toBe(5);
  });

  it("counts the same call in one model response once", () => {
    expect(
      stopsAt(
        play(
          () => ({ ...catLog(), response: 1 }),
          () => failure(),
          12,
        ),
      ),
    ).toBe(undefined);
    const pairs = play(
      (n) => ({ ...catLog(), response: Math.ceil(n / 2) }),
      () => failure(),
    );
    expect(stopsAt(pairs)).toBe(9);
  });

  it.each([
    ["the same failure", () => failure(), 5],
    ["the same answer", () => answer("Still loading"), 12],
    ["an unknown answer", () => undefined, 12],
    ["a new answer each time", (n: number) => answer(`Downloaded ${n * 10}%`), undefined],
    // The first switch is new and starts the count over; after that both answers are known.
    ["alternating failures", (n: number) => failure(n % 2 ? "a" : "b"), 6],
    ["alternating answers", (n: number) => answer(n % 2 ? "a" : "b"), 13],
    // The first failure, from call 5, starts the run its fifth failing call stops.
    ["a failure after four answers", (n: number) => (n <= 4 ? answer("ok") : failure()), 9],
    ["an answer that changes at call 8", (n: number) => answer(n < 8 ? "a" : "b"), 19],
    // A wait with a transient error: the error starts the count over from call 4.
    ["one error in a wait", (n: number) => (n === 4 ? failure() : answer("pending")), 15],
    // A failing exit code can be a wait too (`sleep 30; test -f done`).
    [
      "a failing shell exit code",
      () => toolResultFingerprint({ stdout: "", stderr: "1 test failed", code: 1 }),
      12,
    ],
  ])("stops an identical repeat that got %s at the expected call", (_, seen, stop) => {
    expect(stopsAt(play(catLog, seen))).toBe(stop);
  });

  it("allows a parallel batch with distinct action inputs", () => {
    const verdicts = play(
      (n) => ({
        name: "mcp__open-connector__execute_action",
        args: { actionId: "records.get", input: { recordId: n } },
        response: 1,
      }),
      () => answer("ok"),
      20,
    );
    expect(actions(verdicts).every((a) => a === "run")).toBe(true);
  });
});

describe("loopGuardStopText", () => {
  it("names the repeated calls and is recognised as a loop-guard stop", () => {
    expect(loopGuardStopText(["List files"], 5)).toMatch(
      /^I got stuck calling List files with the same input 5 times in a row/,
    );
    const cycle = loopGuardStopText(["List files", "Read file", "Shell"], 5);
    expect(cycle).toContain("calling List files, Read file and Shell with the same input");
    expect(isLoopGuardStopText(cycle)).toBe(true);
    expect(isLoopGuardStopText("An ordinary reply")).toBe(false);
    // Stops written before the rewrite still count.
    expect(
      isLoopGuardStopText(
        "I got stuck calling Shell with nearly the same input 25 times in a row without making progress, so I stopped early. Try rephrasing this, or ask me to try a different approach.",
      ),
    ).toBe(true);
  });
});

describe("toolResultFingerprint", () => {
  it("fingerprints what the model saw, not timing details", () => {
    expect(toolResultFingerprint({ content: [{ type: "text", text: "ok" }], details: 1 })).toBe(
      toolResultFingerprint({ content: [{ type: "text", text: "ok" }], details: 2 }),
    );
    expect(failure("boom")).not.toBe(failure("bang"));
    expect(toolResultFingerprint({ error: "boom" })).toMatch(/^failed:/);
    expect(answer("boom")).not.toMatch(/^failed:/);
  });

  it("fingerprints screen results by frame, not capture time", () => {
    const screen = (frameId: string, capturedAt: string, unchangedVisualCount: number) =>
      observationToolResult(
        {
          frameId,
          capturedAt,
          image: new Uint8Array([1]),
          mimeType: "image/png",
          width: 1280,
          height: 800,
        },
        "computer acted",
        frameId,
        { unchangedVisualCount },
      );
    const first = screen("frame-a", "2026-01-01T00:00:00.000Z", 1);
    expect(toolResultFingerprint(first)).toBe(
      toolResultFingerprint(screen("frame-a", "2026-01-01T00:00:05.000Z", 2)),
    );
    expect(toolResultFingerprint(first)).not.toBe(
      toolResultFingerprint(screen("frame-b", "2026-01-01T00:00:05.000Z", 2)),
    );
  });
});

describe("advanceOverLimitActionCalls", () => {
  const over = { actions: Array.from({ length: 25 }, () => ({ kind: "click", x: 1, y: 1 })) };
  const ok = { actions: over.actions.slice(0, 24) };

  it("counts over-limit batches in a row across both action tools, even when they differ", () => {
    let count = 0;
    count = advanceOverLimitActionCalls(count, "computer_act", over);
    count = advanceOverLimitActionCalls(count, "browser_act", {
      actions: [...over.actions, ...over.actions],
    });
    count = advanceOverLimitActionCalls(count, "computer_act", over);
    expect(count).toBe(3);
    expect(count).toBeLessThan(MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS);
    expect(advanceOverLimitActionCalls(count, "computer_act", over)).toBe(
      MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS,
    );
  });

  it("counts expanded computer actions while leaving browser batches unexpanded", () => {
    const actions = Array.from({ length: 13 }, () => ({
      kind: "click",
      x: 1,
      y: 1,
      double: true,
    }));
    expect(advanceOverLimitActionCalls(3, "computer_act", { actions })).toBe(
      MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS,
    );
    expect(advanceOverLimitActionCalls(3, "computer_act", { actions: actions.slice(0, 12) })).toBe(
      0,
    );
    expect(advanceOverLimitActionCalls(3, "browser_act", { actions })).toBe(0);
  });

  it("ignores other tools and resets on a batch within the limit", () => {
    expect(advanceOverLimitActionCalls(2, "computer_observe", {})).toBe(2);
    expect(advanceOverLimitActionCalls(2, "computer_act", ok)).toBe(0);
    expect(advanceOverLimitActionCalls(2, "browser_act", undefined)).toBe(0);
  });
});

describe("overLimitStopText", () => {
  it("names the over-limit batches and is recognised as a loop-guard stop", () => {
    const text = overLimitStopText("Computer act", 4);
    expect(text).toContain("with too many actions 4 times in a row");
    expect(text).not.toContain("same input");
    expect(isLoopGuardStopText(text)).toBe(true);
  });
});
