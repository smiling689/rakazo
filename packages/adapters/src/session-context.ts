import type { AgentContextStrategy } from "@rakazo/adapter-kit";

/**
 * Session context: one never-ending conversation per bot, as long-lived assistants keep it
 * (Hermes Agent, OpenClaw). The model sees a rolling summary plus every message since the last
 * compaction. History is compacted when the bot has been idle (its prompt cache is cold by then,
 * so the rewrite costs nothing extra) or when it grows past a size threshold, and the bot first
 * gets a silent turn to save durable facts to its memory (OpenClaw's memory flush).
 */
export const SESSION_CONTEXT_STRATEGY = "session" satisfies AgentContextStrategy;

/** How many recent messages a session run loads; the size threshold compacts long before this. */
export const SESSION_HISTORY_LOAD_LIMIT = 1_000;

export interface SessionContextSettings {
  /** Compact when the uncompacted history passes this (Hermes: 50% of the window). */
  thresholdTokens: number;
  /** Verbatim tail kept after compaction (OpenClaw keepRecentTokens 20,000). */
  keepTokens: number;
  /** ...and at least this many messages (Hermes protect_last_n 20). */
  keepMessages: number;
  /** Idle time before the history is compacted (Hermes idle_compact_after_seconds). */
  idleMs: number;
  /** Idle compaction skips histories at or under this (Hermes: threshold x target_ratio 0.2). */
  idleFloorTokens: number;
}

/** 262,144 is the context window Rakazo assumes for a compatible model that declares none. */
const DEFAULT_THRESHOLD_TOKENS = Math.floor(262_144 * 0.5);

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function sessionContextSettings(
  env: Record<string, string | undefined> = process.env,
): SessionContextSettings {
  const thresholdTokens = positiveInteger(
    env.RAKAZO_SESSION_THRESHOLD_TOKENS,
    DEFAULT_THRESHOLD_TOKENS,
  );
  return {
    thresholdTokens,
    keepTokens: positiveInteger(env.RAKAZO_SESSION_KEEP_TOKENS, 20_000),
    keepMessages: positiveInteger(env.RAKAZO_SESSION_KEEP_MESSAGES, 20),
    idleMs: positiveInteger(env.RAKAZO_SESSION_IDLE_SECONDS, 3_600) * 1_000,
    idleFloorTokens: Math.floor(thresholdTokens * 0.2),
  };
}

/** The deployment's context strategy, when it picks one (`RAKAZO_CONTEXT_STRATEGY`). */
export function configuredContextStrategy(
  env: Record<string, string | undefined> = process.env,
): AgentContextStrategy | undefined {
  const value = env.RAKAZO_CONTEXT_STRATEGY?.trim();
  return value === "session" ||
    value === "current" ||
    value === "retrieval" ||
    value === "snapshots" ||
    value === "cache-aware"
    ? value
    : undefined;
}

export interface SessionHistoryMessage {
  seq: number;
  role: string;
  tokens: number;
  createdAt: Date;
}

export type CompactionReason = "check" | "idle";

/**
 * The last message to fold into the summary, or null when the history should stay as it is.
 * `messages` are the uncompacted ones, oldest first. The tail keeps at least `keepMessages`
 * messages and `keepTokens` tokens, and starts at a message from the person when it can.
 */
export function planSessionCompaction(
  messages: readonly SessionHistoryMessage[],
  settings: SessionContextSettings,
  reason: CompactionReason,
  now: Date,
): number | null {
  const last = messages.at(-1);
  if (!last) return null;
  const total = messages.reduce((sum, message) => sum + message.tokens, 0);
  if (reason === "idle") {
    if (now.getTime() - last.createdAt.getTime() < settings.idleMs) return null;
    if (total <= settings.idleFloorTokens) return null;
  } else if (total <= settings.thresholdTokens) {
    return null;
  }
  let start = messages.length;
  let kept = 0;
  while (
    start > 0 &&
    (messages.length - start < settings.keepMessages || kept < settings.keepTokens)
  ) {
    start -= 1;
    kept += messages[start]!.tokens;
  }
  while (start > 0 && messages[start]!.role !== "user") start -= 1;
  return start > 0 ? messages[start - 1]!.seq : null;
}

const MEMORY_FLUSH_NONCE_PREFIX = "memory-flush";

/** One flush per thread and fold point, so a retried job never queues a second one. */
export function memoryFlushNonce(threadId: string, foldThroughSeq: number): string {
  return `${MEMORY_FLUSH_NONCE_PREFIX}:${threadId}:${foldThroughSeq}`;
}

export function memoryFlushNoncePrefix(threadId: string): string {
  return `${MEMORY_FLUSH_NONCE_PREFIX}:${threadId}:`;
}

/** The fold point a flush run was queued for. */
export function memoryFlushSeq(clientNonce: string | null | undefined): number | null {
  const match = /^memory-flush:[^:]+:(\d+)$/.exec(clientNonce?.trim() ?? "");
  return match ? Number(match[1]) : null;
}

export function isMemoryFlushRun(run: { trigger: string; clientNonce?: string | null }): boolean {
  return run.trigger === "routine" && memoryFlushSeq(run.clientNonce) !== null;
}

/** A flush only edits the bot's own memory: no messages, computers or shared documents. */
export const MEMORY_FLUSH_TOOL_NAMES: ReadonlySet<string> = new Set(["remember"]);

export const MEMORY_FLUSH_PROMPT = [
  "Memory check before older conversation is summarized.",
  "The older part of this conversation is about to be replaced by a short summary, so exact details in it will leave your context.",
  "Save with remember only what you will need later and is not in your memory yet: the person's corrections, preferences, decisions, standing requests, and facts about them or their work. One short fact per call. Skip small talk, finished one-off tasks and anything already saved.",
  "Do not message anyone. When you are done, or if nothing needs saving, the entire final reply must be exactly NO_RESPONSE.",
].join("\n");
