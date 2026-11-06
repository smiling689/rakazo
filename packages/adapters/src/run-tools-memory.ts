import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import {
  HistoryReadInputSchema,
  HistorySearchInputSchema,
  MEMORY_INDEX_PATH,
} from "@rakazo/contracts";
import { readHistory, searchHistory } from "@rakazo/db";
import type { z } from "zod";
import { MAX_SHARED_MEMORY_CHARS, sharedMemorySaveError } from "./builtin-tools.js";
import { redactConnectorPayload } from "./connector-safety.js";
import { MAX_RECALLED_MEMORIES } from "./history-compaction.js";
import type { MemoryEdit, MemoryLimit } from "./memory-tools.js";
import { BOT_MEMORY_LIMIT, editMemory } from "./memory-tools.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

/** Cross-chat history requires a surviving direct human request in this app thread. */
export function historyMyChatsAllowed(
  run: { trigger: string; threadId: string },
  source: { role: string; threadId: string } | null,
  external: boolean,
): boolean {
  return (
    !external &&
    (run.trigger === "user" || run.trigger === "follow_up" || run.trigger === "messaging") &&
    source?.role === "user" &&
    source.threadId === run.threadId
  );
}

/**
 * GPT fills optional fields it does not use with "" or null (`botId: ""`,
 * `linkedRunId: ""`), and every such call failed validation (fork, 2026-11-06). No history
 * field means anything when blank, so blank fields count as not given.
 */
export function withoutBlankFields(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(
      ([, value]) => value !== null && !(typeof value === "string" && !value.trim()),
    ),
  );
}

async function readHistoryTool(ctx: RunContext, call: ToolCall) {
  const { deps, run } = ctx;
  const { name, args } = call;
  const crossChat =
    name === "search_history"
      ? args.scope === "my_chats"
      : typeof args.threadId === "string" && args.threadId !== run.threadId;
  // Channel or webhook text claimed mid-turn revokes the grant for the rest of the run.
  const allowMyChats =
    crossChat && ctx.source.myChatsAllowed && !(await ctx.trust.receivedOutsideMessage());
  const scope = {
    spaceId: run.spaceId,
    userId: run.userId,
    threadId: run.threadId,
    botId: run.botId,
    channelId: ctx.source.channelId,
    searchBeforeSeq: ctx.source.historySearchBeforeSeq,
    allowMyChats,
    searchAt: run.createdAt,
  };
  // A short field-by-field error instead of Zod's JSON dump (with regex patterns), so the
  // model can fix the one field instead of guessing (fork).
  const invalid = (error: z.ZodError) =>
    call.finish({
      error: `Invalid ${name} arguments: ${error.issues
        .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
        .join("; ")}. Received fields: ${Object.keys(args).join(", ") || "none"}.`,
    });
  let response: Awaited<ReturnType<typeof searchHistory | typeof readHistory>>;
  const given = withoutBlankFields(args);
  if (name === "search_history") {
    const parsed = HistorySearchInputSchema.safeParse(given);
    if (!parsed.success) return invalid(parsed.error);
    response = await searchHistory(deps.prisma, scope, parsed.data);
  } else {
    const parsed = HistoryReadInputSchema.safeParse(given);
    if (!parsed.success) return invalid(parsed.error);
    response = await readHistory(deps.prisma, scope, parsed.data);
  }
  const redacted = redactConnectorPayload(response, ctx.secrets);
  // Redaction can expand short synthetic credentials; never let Pi clip the JSON.
  if (Buffer.byteLength(JSON.stringify(redacted), "utf8") > 11_000) {
    return call.finish({
      untrusted: true,
      error:
        "Redacted history exceeds the response budget. Retry with limit 1 or a narrower linked run.",
    });
  }
  return call.finish(redacted);
}

/**
 * Applies one entry edit (see editMemory) to the latest copy of a memory document. The
 * model's copy may be old: the prompt pins memory per conversation and only notes later
 * changes. So a concurrent save is never overwritten; the edit is applied again on top of it.
 */
async function editMemoryDocument(
  ctx: RunContext,
  args: Record<string, unknown>,
  target: { scope: "bot"; botId: string; path: string } | { scope: "user"; path: string },
  limit: MemoryLimit,
): Promise<Extract<MemoryEdit, { error: string }> | { path: string; revision: number }> {
  const { deps, runId, thread, context } = ctx;
  for (let attempt = 1; ; attempt += 1) {
    const snapshot = await deps.memory.read(target, context);
    const existing = snapshot.documents[0];
    const edit = editMemory(
      existing?.content ?? "",
      String(args.content ?? ""),
      String(args.old_text ?? ""),
      limit,
    );
    if ("error" in edit) return edit;
    if (edit.content === (existing?.content ?? ""))
      return { path: target.path, revision: existing?.revision ?? 0 };
    try {
      const saved = await deps.memory.commit(
        {
          ...target,
          content: edit.content,
          expectedRevision: existing?.revision ?? 0,
          sourceRunId: runId,
          sourceThreadId: thread.id,
        },
        context,
      );
      return { path: saved.path, revision: saved.revision };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message !== MEMORY_REVISION_CONFLICT_ERROR || attempt >= 3) throw error;
    }
  }
}

/** Memory documents, semantic memory and thread history. */
export const memoryTools: ToolHandlers = {
  async remember(ctx, call) {
    // One document per bot keeps the size cap meaningful.
    const target = { scope: "bot" as const, botId: ctx.bot.id, path: MEMORY_INDEX_PATH };
    const result = await editMemoryDocument(ctx, call.args, target, BOT_MEMORY_LIMIT);
    return call.finish("error" in result ? result : { ok: true });
  },
  async save_shared_memory(ctx, call) {
    const invalid = sharedMemorySaveError(call.args);
    if (invalid) return call.finish({ error: invalid });
    const target = { scope: "user" as const, path: String(call.args.path ?? "").trim() };
    const result = await editMemoryDocument(ctx, call.args, target, {
      max: MAX_SHARED_MEMORY_CHARS,
      unit: "characters",
    });
    return call.finish("error" in result ? result : { ok: true, ...result });
  },
  async recall_memory(ctx, call) {
    const { bot, thread, context } = ctx;
    const { args } = call;
    return ctx.memory.semantic!.recall(
      {
        query: String(args.query ?? ""),
        scope: ctx.memory.scope!,
        botId: bot.id,
        ...(thread.historyCompactedUpToSeq == null
          ? {}
          : { historyGeneration: thread.historyCompactionGeneration }),
        limit: MAX_RECALLED_MEMORIES,
      },
      context,
    );
  },
  search_history: readHistoryTool,
  read_history: readHistoryTool,
  async save_memory(ctx, call) {
    const { bot, context } = ctx;
    const { args } = call;
    return call.finish(
      await ctx.memory.semantic!.save(
        {
          content: String(args.content ?? ""),
          scope: ctx.memory.scope!,
          botId: bot.id,
          source: { kind: "durable" },
        },
        context,
      ),
    );
  },
  async forget_memory(ctx, call) {
    const { bot, context } = ctx;
    const { args } = call;
    if (!ctx.memory.semantic?.forget) {
      return call.finish({
        error: "This memory provider does not support forgetting individual facts.",
      });
    }
    return call.finish(
      await ctx.memory.semantic.forget(
        {
          id: String(args.id ?? ""),
          scope: ctx.memory.scope!,
          botId: bot.id,
          ...(typeof args.entity === "string" && args.entity.trim()
            ? { entity: args.entity.trim() }
            : {}),
          ...(typeof args.reason === "string" && args.reason.trim()
            ? { reason: args.reason.trim() }
            : {}),
        },
        context,
      ),
    );
  },
};
