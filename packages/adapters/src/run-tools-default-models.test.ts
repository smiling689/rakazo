import type { ModelRoleSettings } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const role = vi.hoisted(() => ({ current: null as unknown as ModelRoleSettings }));
const updateModelRole = vi.hoisted(() =>
  vi.fn(
    async (_prisma: unknown, _scope: unknown, _role: string, patch: Partial<ModelRoleSettings>) => {
      role.current = { ...role.current, ...patch };
      return role.current;
    },
  ),
);
const validateBotModelChange = vi.hoisted(() =>
  vi.fn(
    async (
      _deps: unknown,
      input: { provider: string; model: string; thinkingLevel?: string | null },
    ) => {
      if (input.thinkingLevel === "max") return { ok: false, error: "Unsupported thinking level" };
      const served =
        (input.provider === "openai-compatible" &&
          ["gpt-a", "gpt-b", "new-model"].includes(input.model)) ||
        (input.provider === "hosted" && input.model === "funded-model");
      if (!served) return { ok: false, error: "Unknown model" };
      return { ok: true, thinkingLevel: input.thinkingLevel ?? null };
    },
  ),
);

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  appliedModelRole: async () => role.current,
  updateModelRole,
}));
vi.mock("./model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  validateBotModelChange,
  findConnectedModelCredential: async (
    _prisma: unknown,
    _secrets: unknown,
    _scope: unknown,
    provider: string,
  ) => (provider === "hosted" ? null : { id: "cred-new" }),
}));
vi.mock("./run-model.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fleetPrepareDeps: async () => ({ modelChange: { hostedProvider: "hosted" } }),
}));

const { defaultModelTools } = await import("./run-tools-default-models.js");

const choice = (modelId: string, credentialId = "cred-1") => ({
  provider: "openai-compatible",
  modelId,
  credentialId,
});

function call(args: Record<string, unknown>, options: { owner?: boolean; tainted?: boolean } = {}) {
  const ctx = {
    deps: {
      prisma: {
        userModelCredential: {
          findMany: async () => [{ provider: "openai-compatible" }, { provider: "anthropic" }],
        },
      },
    },
    run: { userId: "user-1", spaceId: "space-1" },
    source: { ownerStartedRun: options.owner ?? true },
    runId: "run-1",
    state: { tainted: options.tainted ?? false, earlierAttempt: Promise.resolve(false) },
    trust: { receivedOutsideMessage: async () => false },
  };
  return defaultModelTools.update_default_models!(
    ctx as never,
    {
      name: "update_default_models",
      args,
      executionId: "call-1",
      finish: async (result: unknown) => result,
    } as never,
  );
}

beforeEach(() => {
  updateModelRole.mockClear();
  role.current = {
    primary: { ...choice("gpt-a"), thinkingLevel: "high" },
    backups: [choice("gpt-b"), choice("claude-c", "cred-2")],
  };
});

describe("update_default_models", () => {
  it("reads the default model, its thinking level and the backups", async () => {
    await expect(call({})).resolves.toEqual({
      defaultModel: "openai-compatible/gpt-a",
      thinkingLevel: "high",
      backups: ["openai-compatible/gpt-b", "openai-compatible/claude-c"],
    });
    expect(updateModelRole).not.toHaveBeenCalled();
  });

  it("works only in a chat the owner started and refuses a tainted run", async () => {
    await expect(call({ primary: "gpt-b" }, { owner: false })).resolves.toHaveProperty("error");
    await expect(call({ primary: "gpt-b" }, { tainted: true })).resolves.toHaveProperty("error");
    expect(updateModelRole).not.toHaveBeenCalled();
  });

  it("promotes a backup to default and drops it from the backups", async () => {
    await expect(call({ primary: "gpt-b" })).resolves.toMatchObject({
      ok: true,
      defaultModel: "openai-compatible/gpt-b",
      backups: ["openai-compatible/claude-c"],
    });
    // No level is sent, so the save keeps the one gpt-b already had.
    expect(role.current.primary).toEqual(choice("gpt-b"));
  });

  it("finds a model the deployment funds", async () => {
    await expect(call({ primary: "funded-model" })).resolves.toMatchObject({
      defaultModel: "hosted/funded-model",
    });
    expect(role.current.primary).toEqual({ provider: "hosted", modelId: "funded-model" });
  });

  it("reads when fields come blank, and clears the backups only when asked", async () => {
    await expect(
      call({ primary: "", thinking_level: null, backups: [], clear_backups: false }),
    ).resolves.not.toHaveProperty("ok");
    expect(updateModelRole).not.toHaveBeenCalled();
    await expect(call({ clear_backups: true })).resolves.toMatchObject({ ok: true, backups: [] });
    expect(role.current.primary).toMatchObject({ modelId: "gpt-a", thinkingLevel: "high" });
  });

  it("changes only the thinking level, checked against the model", async () => {
    await expect(call({ thinking_level: "low" })).resolves.toMatchObject({ thinkingLevel: "low" });
    expect(role.current.backups).toHaveLength(2);
    await expect(call({ thinking_level: "max" })).resolves.toEqual({
      error: "Unsupported thinking level",
    });
    await expect(call({ thinking_level: "loud" })).resolves.toHaveProperty("error");
    await expect(call({ thinking_level: "default" })).resolves.toMatchObject({
      thinkingLevel: "model default",
    });
  });

  it("replaces the backup order, keeping each model's connection, and finds new models", async () => {
    await expect(call({ backups: ["claude-c", "new-model", "gpt-a"] })).resolves.toMatchObject({
      backups: ["openai-compatible/claude-c", "openai-compatible/new-model"],
    });
    expect(role.current.backups).toEqual([
      choice("claude-c", "cred-2"),
      choice("new-model", "cred-new"),
    ]);
    await expect(call({ backups: ["nope"] })).resolves.toHaveProperty("error");
  });
});
