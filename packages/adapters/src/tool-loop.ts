import { createHash } from "node:crypto";
import { toolResultError } from "./tool-result-error.js";

const LOOP_GUARD_STOP_PREFIX = "I got stuck calling ";
// Stops before the repeat guard was rewritten could also say "nearly the same input".
const LOOP_GUARD_STOP_COUNT_PATTERN = " with (?:(?:nearly )?the same input|too many actions) ";
const LOOP_GUARD_STOP_SUFFIX =
  " times in a row without making progress, so I stopped early. Try rephrasing this, or ask me to try a different approach.";
const LOOP_GUARD_STOP_PATTERN = new RegExp(
  `^${LOOP_GUARD_STOP_PREFIX}.+${LOOP_GUARD_STOP_COUNT_PATTERN}\\d+${LOOP_GUARD_STOP_SUFFIX.replaceAll(".", "\\.")}$`,
);

/** `tools` are the readable names of the repeated call, or of each call in a repeated cycle. */
export function loopGuardStopText(tools: readonly string[], repeats: number): string {
  const names =
    tools.length > 1 ? `${tools.slice(0, -1).join(", ")} and ${tools.at(-1)}` : (tools[0] ?? "");
  return `${LOOP_GUARD_STOP_PREFIX}${names} with the same input ${repeats}${LOOP_GUARD_STOP_SUFFIX}`;
}

export function overLimitStopText(toolName: string, count: number): string {
  return `${LOOP_GUARD_STOP_PREFIX}${toolName} with too many actions ${count}${LOOP_GUARD_STOP_SUFFIX}`;
}

export function isLoopGuardStopText(text: string): boolean {
  return LOOP_GUARD_STOP_PATTERN.test(text);
}

const FAILED_RESULT = "failed:";

// A batch over the action limit is refused unrun. Sending another one is a loop the model rarely
// leaves on its own, so it is told on the repeat and the run ends on this one.
export const MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS = 4;
/** The most actions one `computer_act` or `browser_act` call may carry. */
export const MAX_ACTIONS_PER_CALL = 24;

/** A double click expands to two computer actions; every other action stays as one. */
export function computerActionCount(action: unknown): number {
  if (!action || typeof action !== "object") return 1;
  const { kind, double } = action as { kind?: unknown; double?: unknown };
  return kind === "click" && double === true ? 2 : 1;
}

/** Counts consecutive over-limit `computer_act`/`browser_act` batches; other calls leave it alone. */
export function advanceOverLimitActionCalls(count: number, name: string, args: unknown): number {
  if (name !== "computer_act" && name !== "browser_act") return count;
  const actions = (args as { actions?: unknown } | null)?.actions;
  if (!Array.isArray(actions)) return 0;
  const actionCount =
    name === "computer_act"
      ? actions.reduce((total, action) => total + computerActionCount(action), 0)
      : actions.length;
  return actionCount > MAX_ACTIONS_PER_CALL ? count + 1 : 0;
}

/**
 * What the model saw: content rather than details, which can carry timings. Failures are marked
 * so a repeat of one stops sooner.
 */
export function toolResultFingerprint(result: unknown, error?: unknown): string {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  // Screen results compare by frame: their text carries the capture time.
  const frameId = (record.details as { frameId?: unknown } | undefined)?.frameId;
  const seen =
    error !== undefined
      ? error instanceof Error
        ? error.message
        : String(error)
      : typeof frameId === "string"
        ? frameId
        : "content" in record
          ? record.content
          : result;
  const failed = error !== undefined || toolResultError(result) !== undefined;
  return `${failed ? FAILED_RESULT : ""}${createHash("sha256")
    .update(JSON.stringify(seen) ?? "")
    .digest("hex")}`;
}

/**
 * A call is the same as another when its tool and arguments match, key order aside. A repeat
 * counts against the guard only while its answers bring nothing new: one answer the run has not
 * seen before (a status that moved, a page that loaded) starts the count over from that call.
 * The model already has an unchanged answer, so the guard refuses the call and returns a warning
 * in its place; if the model keeps repeating it, the turn ends.
 *
 * A call that keeps failing the same way is refused at its third time and ends the turn at its
 * fifth. A call that keeps succeeding with the same answer may be waiting on something, such as
 * a download, so it gets ten and twelve. A cycle (A, B, A, B) counts its laps the same way.
 */
const FAILING_REPEATS = { warn: 3, stop: 5 };
const UNCHANGED_REPEATS = { warn: 10, stop: 12 };
/** The longest cycle of calls the guard recognises. */
const MAX_CYCLE_PERIOD = 4;
const HISTORY_LENGTH = MAX_CYCLE_PERIOD * UNCHANGED_REPEATS.stop;

export type ToolLoopVerdict =
  | { action: "run" }
  | { action: "warn"; text: string }
  | { action: "stop"; tools: string[]; repeats: number };

/** One call in a context's history; `result` is the fingerprint of its answer once it has one. */
export type ToolCallRecord = {
  name: string;
  key: string;
  response?: number;
  result?: string;
  verdict: ToolLoopVerdict;
};

const RUN: ToolLoopVerdict = { action: "run" };

/**
 * Decides whether a call runs, given the history of the context (the main agent or one helper)
 * that makes it. `response` numbers the model response: the same call twice in one response is
 * one step. Returns the record to give the call's answer to, unless it repeats a sibling.
 */
export function admitToolCall(
  history: ToolCallRecord[],
  name: string,
  args: unknown,
  response?: number,
): { verdict: ToolLoopVerdict; record?: ToolCallRecord } {
  const key = `${name}:${canonicalJson(args)}`;
  const sibling =
    response === undefined
      ? undefined
      : history.find((call) => call.response === response && call.key === key);
  if (sibling) return { verdict: sibling.verdict };
  const record: ToolCallRecord = { name, key, response, verdict: RUN };
  history.push(record);
  if (history.length > HISTORY_LENGTH) history.splice(0, history.length - HISTORY_LENGTH);
  record.verdict = loopVerdict(history);
  return { verdict: record.verdict, record };
}

function loopVerdict(history: readonly ToolCallRecord[]): ToolLoopVerdict {
  const last = history.length - 1;
  let longest = { repeats: 1, period: 1, from: last };
  for (let period = 1; period <= MAX_CYCLE_PERIOD && period <= last; period += 1) {
    // Walk back while each call matches the one a period after it.
    let start = last - period + 1;
    while (start > 0 && history[start - 1]!.key === history[start - 1 + period]!.key) start -= 1;
    // A new answer starts the run over from the call that gave it.
    let from = start;
    const seen = new Map<string, Set<string>>();
    for (let index = start; index < last; index += 1) {
      const { key, result } = history[index]!;
      if (result === undefined) continue;
      const answers = seen.get(key) ?? new Set<string>();
      if (answers.size > 0 && !answers.has(result)) from = index;
      seen.set(key, answers.add(result));
    }
    const repeats = Math.floor((last - from) / period) + 1;
    if (repeats > longest.repeats) longest = { repeats, period, from };
  }
  const { repeats, period, from } = longest;
  if (repeats < FAILING_REPEATS.warn) return RUN;
  const answers = history
    .slice(from, last)
    .map((call) => call.result)
    .filter((result) => result !== undefined);
  const failing = answers.length > 0 && answers.every((result) => result.startsWith(FAILED_RESULT));
  const limits = failing ? FAILING_REPEATS : UNCHANGED_REPEATS;
  const tools = [...new Set(history.slice(last - period + 1).map((call) => call.name))];
  if (repeats >= limits.stop) return { action: "stop", tools, repeats };
  if (repeats < limits.warn) return RUN;
  const what =
    period === 1
      ? `called ${tools[0]} with the same input`
      : `repeated the same ${period} calls (${tools.join(", ")})`;
  const outcome = failing
    ? "it failed the same way every time. Read the error, then change the input or the approach, or tell the user what is blocking you."
    : "the answer has not changed, so you already have it. If you are waiting for something, wait longer before checking again; otherwise use the answer or try something else.";
  return {
    action: "warn",
    text: `Not run: you have ${what} ${repeats} times and ${outcome} If you keep repeating it, your turn will end.`,
  };
}

/** JSON with object keys sorted, so key order never makes two calls differ. */
function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_, item: unknown) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : item,
    ) ?? ""
  );
}
