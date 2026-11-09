import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import type { BatchedWindowLimits } from "./batched-window.js";
import { batchedWindowStart } from "./batched-window.js";
import { pruneStalePageStateContext } from "./context-pruning.js";
import {
  estimateContextTokens,
  estimateTextTokens,
  providerContextPrefix,
} from "./context-selection.js";

/**
 * Provider, api and model stamped on replayed own replies. None matches a real model, so Pi
 * replays them as plain text from another model: no signatures or reasoning, same on every provider.
 */
export const HISTORY_ASSISTANT = {
  api: "rakazo-history",
  provider: "rakazo-history",
  model: "history",
};
export const NO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const IMAGE_OMITTED = "[image omitted]";

/**
 * Earlier turns replay their tool results whole inside this window, and as a one-line stub
 * before it. Its start moves in batches (see batchedWindowStart), so the replayed history stays
 * byte-identical for several turns at a time. Sizes are estimated tokens of the result text;
 * a single result is already capped at 12k-32k characters by the run that read it.
 */
export const REPLAYED_RESULTS_WINDOW: BatchedWindowLimits = {
  turns: 8,
  items: Number.POSITIVE_INFINITY,
  size: 32_000,
};

type Part = { type: string; text?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textParts(content: unknown): Array<{ type: "text"; text: string }> {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part: Part) => {
    if (part?.type === "image") return [{ type: "text" as const, text: IMAGE_OMITTED }];
    return part?.type === "text" && typeof part.text === "string" && part.text
      ? [{ type: "text" as const, text: part.text }]
      : [];
  });
}

function timestampOf(message: Record<string, unknown>): number {
  return typeof message.timestamp === "number" ? message.timestamp : 0;
}

/**
 * The messages a turn added after its opening user turn, as later turns replay them: replies,
 * tool calls and results, and the messages that arrived mid-turn. Reasoning is dropped, since a
 * signed block only replays on the model that wrote it and a model switch would change the
 * bytes; failed and aborted replies, results without their call, images and older page
 * snapshots are dropped too. Runs both when a turn is stored and when it is replayed, so the
 * replay never depends on what an older release stored.
 */
export function turnTranscript(messages: readonly unknown[]): Message[] {
  const pruned = pruneStalePageStateContext(
    messages.filter((message): message is Message => isRecord(message)),
    0,
  );
  const result: Message[] = [];
  let pending = new Set<string>();
  for (const message of pruned as unknown as Array<Record<string, unknown>>) {
    if (message.role === "assistant") {
      pending = new Set();
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      const content: AssistantMessage["content"] = [];
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (!isRecord(part)) continue;
        if (part.type === "text" && typeof part.text === "string" && part.text.trim())
          content.push({ type: "text", text: part.text });
        if (
          part.type === "toolCall" &&
          typeof part.id === "string" &&
          typeof part.name === "string" &&
          isRecord(part.arguments) &&
          !pending.has(part.id)
        ) {
          content.push({
            type: "toolCall",
            id: part.id,
            name: part.name,
            arguments: part.arguments as ToolCall["arguments"],
          });
          pending.add(part.id);
        }
      }
      if (content.length === 0) continue;
      result.push({
        role: "assistant",
        content,
        ...HISTORY_ASSISTANT,
        usage: NO_USAGE,
        stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
        timestamp: timestampOf(message),
      });
    } else if (message.role === "toolResult") {
      const id = message.toolCallId;
      if (typeof id !== "string" || !pending.delete(id)) continue;
      result.push({
        role: "toolResult",
        toolCallId: id,
        toolName: typeof message.toolName === "string" ? message.toolName : "tool",
        content: textParts(message.content),
        isError: message.isError === true,
        timestamp: timestampOf(message),
      });
    } else if (message.role === "user") {
      pending = new Set();
      const content = textParts(message.content);
      if (content.length === 0) continue;
      result.push({
        role: "user",
        content: typeof message.content === "string" ? message.content : content,
        timestamp: timestampOf(message),
      });
    }
  }
  return result;
}

type ToolResult = Extract<Message, { role: "toolResult" }>;

function resultText(message: ToolResult): string {
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function stubbed(message: ToolResult): ToolResult {
  const text = resultText(message);
  const stub = `[tool result omitted: ${message.toolName}, ${text.length} chars]`;
  return stub.length < text.length
    ? { ...message, content: [{ type: "text", text: stub }] }
    : message;
}

/**
 * The transcript a finished turn stores. A result followed in its own turn by more than the
 * replay window's size can never be replayed whole (the window ends at the newest result), so
 * it is stored as its stub already.
 */
export function recordedTranscript(messages: readonly unknown[]): Message[] {
  const result = turnTranscript(messages);
  let size = 0;
  let newest = true;
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const message = result[index]!;
    if (message.role !== "toolResult") continue;
    size += estimateTextTokens(resultText(message));
    if (!newest && size > REPLAYED_RESULTS_WINDOW.size) result[index] = stubbed(message);
    newest = false;
  }
  return result;
}

/**
 * Earlier turns' transcripts, oldest first, as they are replayed: tool results before the
 * window's start become a stub that names the tool and the size left out.
 *
 * Only the transcripts before `wholeFrom` count toward the window; later ones replay whole. A
 * stub rewrites the history in the middle, and the provider then reuses its cache only up to the
 * system prompt, so a caller passes the turns written since the cache was last lost: the window
 * moves only when the cache is cold anyway (see replayWindowBefore in turn-replay.ts).
 */
export function replayTranscripts(
  transcripts: readonly (readonly unknown[])[],
  wholeFrom = transcripts.length,
): Message[][] {
  const turns = transcripts.map(turnTranscript);
  const slots = turns
    .slice(0, wholeFrom)
    .flatMap((messages, turn) =>
      messages.flatMap((message, index) =>
        message.role === "toolResult"
          ? [{ turn, index, size: estimateTextTokens(resultText(message)) }]
          : [],
      ),
    );
  for (const slot of slots.slice(0, batchedWindowStart(slots, REPLAYED_RESULTS_WINDOW))) {
    const message = turns[slot.turn]![slot.index]!;
    if (message.role === "toolResult") turns[slot.turn]![slot.index] = stubbed(message);
  }
  return turns;
}

/** Estimated tokens each transcript adds to the history when replayed, for compaction. */
export function replayedTranscriptTokens(
  transcripts: readonly (readonly unknown[])[],
  wholeFrom = transcripts.length,
): number[] {
  return replayTranscripts(transcripts, wholeFrom).map((messages) =>
    estimateContextTokens(providerContextPrefix("", [], messages).messages),
  );
}
