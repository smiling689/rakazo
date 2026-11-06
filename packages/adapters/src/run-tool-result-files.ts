import { createHash } from "node:crypto";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import type { ComputerMode } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { resolveBotWorkspacePath } from "./computer-support.js";
import { usesNativeShell } from "./native-shell.js";

/**
 * Bot-relative home of saved tool results. Workspace saves skip .cache folders, so a computer
 * restored from a save comes back without them.
 */
export const TOOL_RESULT_FILE_DIRECTORY = ".cache/tool-results";
/** A longer result is saved cut here; that is already several hundred pages of text. */
export const MAX_TOOL_RESULT_FILE_CHARS = 1_000_000;
/** Results saved while the computer is not running wait in memory, up to this much in all. */
const MAX_WAITING_CHARS = 4_000_000;
/** Saved results older than this are deleted the first time a run saves another. */
export const TOOL_RESULT_FILE_MAX_AGE_MINUTES = 24 * 60;

type SavedFile = { path: string; text: string };

/**
 * Saves tool results too long for the model to see whole into the bot's workspace.
 *
 * Remote computers bill while they run, so saving never starts one. A result saved before the
 * computer runs waits in memory and is written by `flush` when a tool next starts the computer,
 * which reading the file does. Text is redacted with the run's secrets as it is written, so a
 * value revealed after the tool returned is hidden too. Results a run never reaches its computer
 * for are not written at all.
 */
export function createToolResultFiles(input: {
  sandbox: SandboxProvider;
  context: AdapterContext;
  computerMode: ComputerMode;
  botId: string;
  /** Every value the run redacts. Grows during the run. */
  secrets: readonly string[];
  /** The computer if a tool already started it. */
  ready: () => ComputerRef | undefined;
}) {
  const { sandbox, context, computerMode, botId, secrets } = input;
  let waiting: SavedFile[] = [];
  let waitingChars = 0;
  let pruned: Promise<void> | undefined;

  const stored = (path: string) => resolveBotWorkspacePath(computerMode, botId, path);

  async function prune(computer: ComputerRef) {
    let code: number | undefined;
    for await (const event of sandbox.execute(
      computer,
      {
        argv: [
          "find",
          stored(TOOL_RESULT_FILE_DIRECTORY),
          "-type",
          "f",
          "-name",
          "*.txt",
          "-mmin",
          `+${TOOL_RESULT_FILE_MAX_AGE_MINUTES}`,
          "-delete",
        ],
      },
      context,
    )) {
      if (event.type === "exit") code = event.code;
    }
    // A missing folder is the usual reason; the next run tries again.
    if (code !== 0) getLogger().debug("old tool result files were not deleted", { code });
  }

  async function write(computer: ComputerRef, files: readonly SavedFile[]) {
    pruned ??= prune(computer).catch((error: unknown) => {
      getLogger().debug("old tool result files were not deleted", { error });
    });
    await pruned;
    for (const file of files) {
      await sandbox.writeFile(
        computer,
        {
          path: stored(file.path),
          content: new TextEncoder().encode(redactSecrets(file.text, secrets)),
        },
        context,
      );
    }
  }

  return {
    /** The bot-relative path the result is or will be at, or undefined when it cannot be kept. */
    async save(result: { name: string; executionId: string; text: string }) {
      const text =
        result.text.length > MAX_TOOL_RESULT_FILE_CHARS
          ? `${result.text.slice(0, MAX_TOOL_RESULT_FILE_CHARS)}\n[Cut at ${MAX_TOOL_RESULT_FILE_CHARS} characters.]`
          : result.text;
      const file = { path: toolResultFilePath(result.name, result.executionId), text };
      const computer = input.ready();
      if (!computer) {
        if (waitingChars + text.length > MAX_WAITING_CHARS) return undefined;
        waiting.push(file);
        waitingChars += text.length;
        return file.path;
      }
      try {
        await write(computer, [file]);
        return file.path;
      } catch (error) {
        getLogger().warn("tool result file was not written", { error });
        return undefined;
      }
    },
    /** Write results that waited for the computer. Failures are logged, never thrown. */
    async flush(computer: ComputerRef) {
      if (waiting.length === 0) return;
      const files = waiting;
      waiting = [];
      waitingChars = 0;
      try {
        await write(computer, files);
      } catch (error) {
        getLogger().warn("tool result files were not written", { error });
      }
    },
  };
}

/** One file per call: a retried call writes the same file again. */
export function toolResultFilePath(name: string, executionId: string): string {
  const tool = name.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60) || "tool";
  const id = createHash("sha256").update(executionId).digest("hex").slice(0, 12);
  return `${TOOL_RESULT_FILE_DIRECTORY}/${tool}-${id}.txt`;
}

/**
 * Saved results are read back with Unix line tools through the shell, and old ones are deleted
 * with them. A computer that runs its host's own shell may have neither, so its runs keep
 * results shortened only.
 */
export function toolResultFilesAllowed(input: {
  computerKind: string | undefined;
  shellOffered: boolean;
}): boolean {
  return (
    input.shellOffered &&
    input.computerKind !== undefined &&
    input.computerKind !== "none" &&
    !usesNativeShell(input.computerKind)
  );
}
