import type { ModelRoleChoice } from "@rakazo/contracts";
import { ModelRoleSettingsSchema, ThinkingLevelSchema } from "@rakazo/contracts";
import { appliedModelRole, updateModelRole } from "@rakazo/db";
import { findConnectedModelCredential, validateBotModelChange } from "./model-selection.js";
import type { RunContext } from "./run-context.js";
import { isRunTainted, refuseOwnerSettingsChange } from "./run-context.js";
import { isSubagentToolExecution } from "./run-effects.js";
import { fleetPrepareDeps } from "./run-model.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

const label = (choice: Pick<ModelRoleChoice, "provider" | "modelId">) =>
  `${choice.provider}/${choice.modelId}`;
const sameModel = (left: ModelRoleChoice, right: ModelRoleChoice) =>
  left.provider === right.provider && left.modelId === right.modelId;

function view(role: { primary: ModelRoleChoice | null; backups: ModelRoleChoice[] }) {
  return {
    defaultModel: role.primary ? label(role.primary) : "deployment default",
    thinkingLevel: role.primary?.thinkingLevel ?? "model default",
    backups: role.backups.map(label),
  };
}

/**
 * A model the user named: one already in their list (by "provider/model" or model id), else a
 * model one of their connections serves. Names are exact ids, as list_fleet and update_bot show.
 */
async function resolveModel(
  ctx: RunContext,
  name: string,
  known: readonly ModelRoleChoice[],
): Promise<ModelRoleChoice | { error: string }> {
  const wanted = name.trim();
  const listed =
    known.find((choice) => label(choice) === wanted) ??
    known.find((choice) => choice.modelId === wanted);
  if (listed)
    return {
      provider: listed.provider,
      modelId: listed.modelId,
      credentialId: listed.credentialId,
    };
  const { deps, run } = ctx;
  const scope = { userId: run.userId, spaceId: run.spaceId };
  const credentials = await deps.prisma.userModelCredential.findMany({
    where: { userId: run.userId },
    select: { provider: true },
    orderBy: { createdAt: "asc" },
  });
  const providers = [...new Set(credentials.map((credential) => credential.provider))];
  const slash = wanted.indexOf("/");
  const attempts =
    slash > 0 && providers.includes(wanted.slice(0, slash))
      ? [[wanted.slice(0, slash), wanted.slice(slash + 1)] as const]
      : providers.map((provider) => [provider, wanted] as const);
  const modelChange = (await fleetPrepareDeps(deps, scope)).modelChange;
  for (const [provider, modelId] of attempts) {
    const valid = await validateBotModelChange(
      { prisma: deps.prisma, ...modelChange },
      { ...scope, provider, model: modelId },
    );
    if (!valid.ok) continue;
    const credential = await findConnectedModelCredential(
      deps.prisma,
      deps.secretStore,
      scope,
      provider,
      modelId,
    );
    return { provider, modelId, ...(credential ? { credentialId: credential.id } : {}) };
  }
  return {
    error: `No connected model is called "${wanted}". Use an exact id from list_fleet or update_bot.`,
  };
}

async function updateDefaultModels(ctx: RunContext, call: ToolCall) {
  const { deps, run, source } = ctx;
  if (!source.ownerStartedRun)
    return call.finish({ error: "The default models change only in a chat the user started." });
  const scope = { userId: run.userId, spaceId: run.spaceId };
  const current = await appliedModelRole(deps.prisma, scope, "main");
  const primaryArg = typeof call.args.primary === "string" ? call.args.primary.trim() : "";
  const levelArg =
    typeof call.args.thinking_level === "string" ? call.args.thinking_level.trim() : "";
  const backupsArg = Array.isArray(call.args.backups)
    ? call.args.backups.map((name) => String(name).trim()).filter(Boolean)
    : undefined;
  const write = Boolean(primaryArg || levelArg || backupsArg);
  if (!write) return call.finish(view(current));
  if (isSubagentToolExecution(call.executionId))
    return call.finish({ error: "Helpers cannot change the default models." });
  // The owner already approved the change itself; its replay runs in a later attempt.
  if (call.nextApprovedTool !== "update_default_models" && (await isRunTainted(ctx)))
    return call.finish(
      refuseOwnerSettingsChange(
        ctx,
        "Default model changes are blocked for the rest of this run because it read outside content.",
      ),
    );

  const known = [...(current.primary ? [current.primary] : []), ...current.backups];
  let primary = current.primary;
  if (primaryArg) {
    const resolved = await resolveModel(ctx, primaryArg, known);
    if ("error" in resolved) return call.finish(resolved);
    primary = { ...resolved, thinkingLevel: null };
  }
  if (levelArg) {
    if (!primary)
      return call.finish({ error: "Choose a default model before its thinking level." });
    const parsedLevel = ThinkingLevelSchema.safeParse(levelArg);
    if (levelArg !== "default" && !parsedLevel.success)
      return call.finish({
        error: `thinking_level must be one of: default, ${ThinkingLevelSchema.options.join(", ")}`,
      });
    const level = parsedLevel.success ? parsedLevel.data : null;
    const valid = await validateBotModelChange(
      { prisma: deps.prisma, ...(await fleetPrepareDeps(deps, scope)).modelChange },
      { ...scope, provider: primary.provider, model: primary.modelId, thinkingLevel: level },
    );
    if (!valid.ok) return call.finish({ error: valid.error });
    primary = { ...primary, thinkingLevel: level };
  } else if (primaryArg && current.primary && sameModel(primary!, current.primary)) {
    primary = { ...primary!, thinkingLevel: current.primary.thinkingLevel ?? null };
  }

  let backups = current.backups;
  if (backupsArg) {
    backups = [];
    for (const name of backupsArg) {
      const resolved = await resolveModel(ctx, name, known);
      if ("error" in resolved) return call.finish(resolved);
      const kept = current.backups.find((choice) => sameModel(choice, resolved));
      backups.push(kept ?? resolved);
    }
  }
  // The default model is never also its own backup.
  backups = backups.filter(
    (choice, index) =>
      !(primary && sameModel(choice, primary)) &&
      backups.findIndex((other) => sameModel(other, choice)) === index,
  );
  const parsed = ModelRoleSettingsSchema.safeParse({ primary, backups });
  if (!parsed.success)
    return call.finish({ error: parsed.error.issues.map((issue) => issue.message).join(" ") });
  const saved = await updateModelRole(deps.prisma, scope, "main", parsed.data);
  return call.finish({ ok: true, ...view(saved) });
}

/** The default model, its thinking level and the backup order of the user who started the run. */
export const defaultModelTools: ToolHandlers = { update_default_models: updateDefaultModels };
