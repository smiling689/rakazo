import type { ConnectorTool } from "@rakazo/adapter-kit";
import { FLEET_TOOL_NAMES } from "@rakazo/contracts";
import { deferredToolGuidance } from "./deferred-tool-guidance.js";
import type { CatalogEntry } from "./lazy-tool-catalog.js";
import {
  catalogEntries,
  formatNameIndexText,
  groupedNames,
  rankCatalogEntries,
} from "./lazy-tool-catalog.js";
import { BUILTIN_AGENT_TOOL_NAMES } from "./run-tool-selection.js";

export const FIND_TOOL = "find_tool";
export const USE_TOOL = "use_tool";
const FIND_TOOL_LIMIT = 3;

/**
 * Built-in tools the model always sees with full schemas: everyday work, and every tool the
 * runtime answers itself. Other built-ins offered to a run are reached through find_tool and
 * use_tool, so the listed tools stay small and never change mid-run.
 */
export const CORE_BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "shell",
  "user_computer_shell",
  "read_file",
  "write_file",
  "list_files",
  "attach_file",
  "web_search",
  "web_fetch",
  // The runtime itself drives these (computer mode, nested helpers, resumed own-settings writes).
  "computer_observe",
  "computer_act",
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "run_subagent",
  "update_bot",
  "skill_read",
  "ask_user",
  "message_user",
  "request_takeover",
  "request_secret",
  "connect_app",
  "remember",
  "save_memory",
  "recall_memory",
  "search_history",
  "read_history",
  "end_call",
]);

// Fork (lean tools, 2026-11-06): schedule_create/schedule_list (4.4k characters) and update_preferences
// left the core list: measured over 451 runs they ran in under 3 % of runs. They sit behind
// find_tool, as do the usage notes of every deferred tool (deferred-tool-guidance.ts). Page, desktop,
// subagent, update_bot and skill_read stay: computer mode, helpers, checkpoints and the verbatim skill
// result handle them by name.

/** Composio's meta tools (search, schemas, multi-execute): ~11.7k characters, used in 16 % of runs. */
const DEFERRED_CONNECTOR_TOOL = /^COMPOSIO_[A-Z_]+$/;

const FLEET_NAMES: ReadonlySet<string> = new Set(FLEET_TOOL_NAMES);

const AREAS: Array<[area: string, matches: (name: string) => boolean]> = [
  [
    "connected apps (Gmail, Drive, Calendar, Notion, GitHub ...)",
    (name) => DEFERRED_CONNECTOR_TOOL.test(name),
  ],
  ["browser", (name) => name.startsWith("browser_")],
  [
    "desktop",
    (name) => ["computer_observe", "computer_act", "open_path", "launch_app"].includes(name),
  ],
  ["secrets", (name) => name.includes("secret")],
  ["bots", (name) => FLEET_NAMES.has(name) || name.endsWith("_bot")],
  [
    "tasks",
    (name) =>
      /^(scratchpad_|ticket_)/.test(name) || ["board_tickets", "task_catalog"].includes(name),
  ],
  ["skills", (name) => name.startsWith("skill_")],
  ["schedules", (name) => name.startsWith("schedule_")],
  ["memory", (name) => name.includes("memory")],
  [
    "media",
    (name) => name.startsWith("generate_") || name === "render_plot" || name === "save_page",
  ],
  ["cloud agents", (name) => name.startsWith("cloud_agent_")],
  ["purchases", (name) => name.includes("purchase") || name === "paid_request"],
];

export function isDeferredTool(name: string): boolean {
  if (DEFERRED_CONNECTOR_TOOL.test(name)) return true;
  return BUILTIN_AGENT_TOOL_NAMES.has(name) && !CORE_BUILTIN_TOOL_NAMES.has(name);
}

/**
 * Splits a run's offered tools into the ones listed to the model and the deferred built-ins.
 * `advertised` names deferred tools this run may not use but the thread's other turns can: they
 * join find_tool's name index so the tool list, part of the cached prompt prefix, stays the same.
 */
export function partitionTools(
  tools: readonly ConnectorTool[],
  advertised: readonly string[] = [],
): {
  listed: ConnectorTool[];
  deferred: ConnectorTool[];
} {
  const deferred = tools.filter((tool) => isDeferredTool(tool.name));
  const listed = tools.filter((tool) => !isDeferredTool(tool.name));
  const indexed = [
    ...deferred,
    ...advertised
      .filter((name) => isDeferredTool(name) && !deferred.some((tool) => tool.name === name))
      .map((name): ConnectorTool => ({ name, description: "", inputSchema: { type: "object" } })),
  ];
  return { listed: indexed.length ? [...listed, ...bridgeTools(indexed)] : listed, deferred };
}

function searchEntries(deferred: readonly ConnectorTool[]): CatalogEntry[] {
  return catalogEntries(
    deferred.map((tool) => ({
      ...tool,
      // Parameter names rank like description words.
      description: `${tool.description} ${Object.keys(
        (tool.inputSchema.properties as Record<string, unknown> | undefined) ?? {},
      ).join(" ")}`,
      route: {
        connectorId: "builtin",
        toolName: tool.name,
        catalogGroup: AREAS.find(([, matches]) => matches(tool.name))?.[0] ?? "other",
      },
    })),
  );
}

function bridgeTools(deferred: readonly ConnectorTool[]): ConnectorTool[] {
  return [
    {
      name: FIND_TOOL,
      description: `Get the parameters of tools not in your tool list (built-ins and connected apps), including ones your instructions name. Call this before use_tool. Pass names for exact tools or query to search.\n${formatNameIndexText(groupedNames(searchEntries(deferred)))}`,
      inputSchema: {
        type: "object",
        properties: {
          names: { type: "array", items: { type: "string" }, maxItems: 5 },
          query: { type: "string", maxLength: 200, description: "Words describing the task" },
        },
      },
      readOnly: true,
    },
    {
      name: USE_TOOL,
      description: "Run a tool whose parameters find_tool returned in this turn.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          arguments: { type: "object", description: "Arguments matching its parameters" },
        },
        required: ["name", "arguments"],
      },
    },
  ];
}

/** Full definitions of the deferred tools named, or the best matches for a query. */
export function findTools(deferred: readonly ConnectorTool[], args: Record<string, unknown>) {
  const names = Array.isArray(args.names) ? args.names.map(String) : [];
  const query = String(args.query ?? "")
    .trim()
    .toLowerCase();
  const found = names.length
    ? deferred.filter((tool) => names.includes(tool.name))
    : query
      ? rankCatalogEntries(searchEntries(deferred), query, FIND_TOOL_LIMIT).hits.map(
          (entry) => deferred.find((tool) => tool.name === entry.id)!,
        )
      : [];
  const unknown = names.filter((name) => !found.some((tool) => tool.name === name));
  return {
    tools: found.map(({ name, description, inputSchema }) => {
      const note = deferredToolGuidance(name);
      return { name, description: note ? `${description}\n\n${note}` : description, inputSchema };
    }),
    ...(unknown.length ? { unknown } : {}),
    ...(found.length ? {} : { hint: "Pass names from this tool's list or other words." }),
  };
}
