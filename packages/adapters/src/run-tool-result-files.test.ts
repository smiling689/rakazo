import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  createToolResultFiles,
  MAX_TOOL_RESULT_FILE_CHARS,
  TOOL_RESULT_FILE_DIRECTORY,
  toolResultFilePath,
  toolResultFilesAllowed,
} from "./run-tool-result-files.js";

const computer = { id: "c", botId: "b", kind: "docker", providerRef: "c" } as ComputerRef;
const context: AdapterContext = {
  operationId: "op",
  traceId: "trace",
  spaceId: "s",
  userId: "u",
  signal: new AbortController().signal,
};

function fakeSandbox() {
  const written: Array<{ path: string; text: string }> = [];
  const commands: CommandRequest[] = [];
  const sandbox = {
    async *execute(_computer: ComputerRef, request: CommandRequest): AsyncIterable<ProcessEvent> {
      commands.push(request);
      yield { type: "exit", code: 0 } as ProcessEvent;
    },
    async writeFile(_computer: ComputerRef, file: PortableFile) {
      written.push({ path: file.path, text: new TextDecoder().decode(file.content) });
    },
  } as unknown as SandboxProvider;
  return { sandbox, written, commands };
}

describe("createToolResultFiles", () => {
  it("writes a redacted copy into the bot's folder when the computer is running", async () => {
    const { sandbox, written, commands } = fakeSandbox();
    const files = createToolResultFiles({
      sandbox,
      context,
      computerMode: "team",
      botId: "bot1",
      secrets: ["hunter2-token"],
      ready: () => computer,
    });

    const path = await files.save({
      name: "mcp__mail__read",
      executionId: "call-1",
      text: "From: a\nPassword reset code hunter2-token\nBye",
    });

    expect(path).toBe(toolResultFilePath("mcp__mail__read", "call-1"));
    expect(path?.startsWith(`${TOOL_RESULT_FILE_DIRECTORY}/mcp__mail__read-`)).toBe(true);
    expect(written).toEqual([
      { path: `bots/bot1/${path}`, text: "From: a\nPassword reset code [redacted]\nBye" },
    ]);
    // Old files are deleted once per run, before the first write.
    expect(commands).toHaveLength(1);
    expect(commands[0]!.argv).toEqual([
      "find",
      `bots/bot1/${TOOL_RESULT_FILE_DIRECTORY}`,
      "-type",
      "f",
      "-name",
      "*.txt",
      "-mmin",
      "+1440",
      "-delete",
    ]);
    await files.save({ name: "list_rows", executionId: "call-2", text: "rows" });
    expect(commands).toHaveLength(1);
  });

  it("waits for the computer to start without starting it, then redacts what it writes", async () => {
    const { sandbox, written } = fakeSandbox();
    const secrets: string[] = [];
    const files = createToolResultFiles({
      sandbox,
      context,
      computerMode: "dedicated",
      botId: "bot1",
      secrets,
      ready: () => undefined,
    });

    const path = await files.save({
      name: "docs_read",
      executionId: "call-1",
      text: "doc with later-secret inside",
    });
    expect(path).toBeDefined();
    expect(written).toEqual([]);

    // A value revealed after the tool returned is hidden too.
    secrets.push("later-secret");
    await files.flush(computer);
    expect(written).toEqual([{ path: path!, text: "doc with [redacted] inside" }]);
    await files.flush(computer);
    expect(written).toHaveLength(1);
  });

  it("cuts very long results and stops keeping results that wait past the memory bound", async () => {
    const { sandbox, written } = fakeSandbox();
    const waiting = createToolResultFiles({
      sandbox,
      context,
      computerMode: "dedicated",
      botId: "bot1",
      secrets: [],
      ready: () => undefined,
    });
    const huge = "x".repeat(MAX_TOOL_RESULT_FILE_CHARS + 1_000);
    const kept: Array<string | undefined> = [];
    for (let call = 0; call < 5; call++) {
      kept.push(await waiting.save({ name: "dump", executionId: `call-${call}`, text: huge }));
    }
    expect(kept.slice(0, 3).every(Boolean)).toBe(true);
    expect(kept[4]).toBeUndefined();

    await waiting.flush(computer);
    expect(written[0]!.text.startsWith("x".repeat(MAX_TOOL_RESULT_FILE_CHARS))).toBe(true);
    expect(written[0]!.text.length).toBeLessThan(huge.length);
    expect(written[0]!.text.endsWith(`[Cut at ${MAX_TOOL_RESULT_FILE_CHARS} characters.]`)).toBe(
      true,
    );
  });

  it("returns undefined when the file cannot be written", async () => {
    const sandbox = {
      async *execute(): AsyncIterable<ProcessEvent> {
        yield { type: "exit", code: 1 } as ProcessEvent;
      },
      async writeFile() {
        throw new Error("disk full");
      },
    } as unknown as SandboxProvider;
    const files = createToolResultFiles({
      sandbox,
      context,
      computerMode: "dedicated",
      botId: "bot1",
      secrets: [],
      ready: () => computer,
    });
    await expect(
      files.save({ name: "dump", executionId: "call-1", text: "long" }),
    ).resolves.toBeUndefined();
  });
});

describe("toolResultFilesAllowed", () => {
  it("needs the shell and a computer with Unix tools", () => {
    expect(toolResultFilesAllowed({ computerKind: "docker", shellOffered: true })).toBe(true);
    expect(toolResultFilesAllowed({ computerKind: "docker", shellOffered: false })).toBe(false);
    expect(toolResultFilesAllowed({ computerKind: "desktop", shellOffered: true })).toBe(false);
    expect(toolResultFilesAllowed({ computerKind: "wuying", shellOffered: true })).toBe(false);
    expect(toolResultFilesAllowed({ computerKind: "none", shellOffered: true })).toBe(false);
    expect(toolResultFilesAllowed({ computerKind: undefined, shellOffered: true })).toBe(false);
  });
});
