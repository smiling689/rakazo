import { describe, expect, it } from "vitest";
import { userTurnInstructions } from "./run-instructions.js";

function instructions(disabled: string[] = []): string {
  return userTurnInstructions({
    botInstructions: "",
    groupContext: undefined,
    messagingContext: undefined,
    redactedMemoryContext: undefined,
    redactedScratchpadContext: undefined,
    hasHistoricalContext: false,
    computerInstruction: "",
    pageBrowserAllowed: false,
    workspaceInstruction: "",
    agentEnvironmentInstruction: undefined,
    botDirectory: undefined,
    pluginLine: undefined,
    agentSkillsLine: undefined,
    taughtSkillsLine: undefined,
    replyGuidance: "",
    disabledBuiltinTools: new Set(disabled),
  })
    .filter(Boolean)
    .join("\n");
}

describe("memory routing guidance", () => {
  it("sends facts about the user to shared memory and working notes to the bot's own", () => {
    expect(instructions()).toContain(
      "Use save_shared_memory for facts about the user that every bot should know (preferences, personal details, standing requests) and remember for your own working notes; save each fact once.",
    );
  });

  it("names only the memory tools the bot is offered", () => {
    const ownOnly = instructions(["save_shared_memory"]);
    expect(ownOnly).toContain("Use remember for durable facts.");
    expect(ownOnly).not.toContain("save_shared_memory");
    const sharedOnly = instructions(["remember"]);
    expect(sharedOnly).toContain("Use save_shared_memory for durable facts about the user.");
    expect(sharedOnly).not.toContain("remember");
    expect(instructions(["remember", "save_shared_memory"])).not.toMatch(
      /remember|save_shared_memory/,
    );
  });
});
