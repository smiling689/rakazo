import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type {
  AgentRunRequest,
  AgentSteeringMessage,
  AgentTurnTranscript,
} from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const providerState = vi.hoisted(() => ({
  models: new Map<string, Record<string, unknown>>(),
  stream: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) => providerState.models.get(`${provider}/${id}`),
    streamSimple: (...args: unknown[]) => providerState.stream(...args),
  }),
}));
vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";
import { releaseToolCallBudget } from "./pi-runtime-tools.js";
import { recordedTranscript, replayTranscripts, turnTranscript } from "./pi-runtime-transcript.js";

const primary: Model<"openai-completions"> = {
  provider: "provider-a",
  id: "primary",
  name: "primary",
  api: "openai-completions",
  baseUrl: "https://models.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4_096,
};

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: primary.api,
    provider: primary.provider,
    model: primary.id,
    usage: {
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 1,
  };
}

function stream(response: AssistantMessage) {
  const result = new AssistantMessageEventStream();
  result.push({ type: "start", partial: { ...response, content: [], stopReason: "stop" } });
  response.content.forEach((part, index) => {
    if (part.type === "text")
      result.push({ type: "text_delta", contentIndex: index, delta: part.text, partial: response });
    if (part.type === "toolCall") {
      result.push({ type: "toolcall_start", contentIndex: index, partial: response });
      result.push({ type: "toolcall_end", contentIndex: index, toolCall: part, partial: response });
    }
  });
  const reason = response.stopReason === "toolUse" ? "toolUse" : "stop";
  result.push({ type: "done", reason, message: response });
  result.end(response);
  return result;
}

const tools: AgentRunRequest["tools"] = [
  {
    name: "list_files",
    description: "List files in this bot's home",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    readOnly: true,
  },
];

async function run(overrides: Partial<AgentRunRequest>) {
  const request = {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    prompt: "What files do I have?",
    instructions: "Use tools when useful.",
    history: [],
    tools,
    model: { provider: primary.provider, id: primary.id, apiKey: "fake-key" },
    executeTool: async () => ({ files: ["notes.md", "plan.md"] }),
    ...overrides,
  } as AgentRunRequest;
  for await (const _event of new PiAgentRuntime().run(request, {
    operationId: "operation",
    traceId: "trace",
    spaceId: "space",
    userId: "user",
    signal: new AbortController().signal,
  })) {
    // exhaust the run
  }
  releaseToolCallBudget(request.runId, false);
}

/** The messages the provider received on each call. */
const sentMessages = () =>
  providerState.stream.mock.calls.map((call) => (call[1] as { messages: Message[] }).messages);

const shape = (messages: readonly Message[]) =>
  messages
    .filter((message) => (message.role as string) !== "system")
    .map((message) =>
      message.role === "toolResult"
        ? `toolResult:${message.toolName}`
        : message.role === "assistant"
          ? `assistant:${message.content.map((part) => (part.type === "toolCall" ? `call ${part.name}` : part.type === "text" ? part.text : part.type)).join("+")}`
          : `user:${typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : part.type)).join("+")}`,
    );

beforeEach(() => {
  providerState.models.clear();
  providerState.models.set(`${primary.provider}/${primary.id}`, primary as never);
  providerState.stream.mockReset();
});

describe("turn transcripts", () => {
  it("records a finished turn's tool work and replays it in the next turn in order", async () => {
    providerState.stream
      .mockImplementationOnce(() =>
        stream(
          assistant(
            [
              { type: "thinking", thinking: "Look first.", thinkingSignature: "sig" },
              { type: "text", text: "Checking." },
              { type: "toolCall", id: "call-1", name: "list_files", arguments: { path: "" } },
            ],
            "toolUse",
          ),
        ),
      )
      .mockImplementationOnce(() =>
        stream(assistant([{ type: "text", text: "You have notes.md and plan.md." }], "stop")),
      );
    let claims = 0;
    const claimSteering = vi.fn(async (): Promise<AgentSteeringMessage[]> => {
      claims += 1;
      // The person writes while the tool runs.
      return claims === 2
        ? [{ id: "steer-1", messageId: "m-steer", text: "Only markdown.", origin: "user" }]
        : [];
    });
    let transcript: AgentTurnTranscript | undefined;
    await run({
      claimSteering,
      onTranscript: (value) => {
        transcript = value;
      },
    });

    expect(transcript?.steeringMessageIds).toEqual(["m-steer"]);
    const recorded = transcript!.messages as Message[];
    expect(recorded.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "user",
      "assistant",
    ]);
    // Reasoning is not replayed, and the reply is stamped as another model's text.
    expect(JSON.stringify(recorded)).not.toContain("Look first.");
    expect(recorded[0]).toMatchObject({ provider: "rakazo-history", stopReason: "toolUse" });
    expect(JSON.stringify(recorded[2])).toContain("Only markdown.");

    // The next turn replays it in place of the reply's text, the steering only once.
    providerState.stream.mockReset();
    providerState.stream.mockImplementation(() =>
      stream(assistant([{ type: "text", text: "Done." }], "stop")),
    );
    const history: AgentRunRequest["history"] = [
      { id: "m-1", role: "user", content: "What files do I have?" },
      {
        id: "m-2",
        role: "assistant",
        content: "You have notes.md and plan.md.",
        sentReply: transcript!.messages,
      },
    ];
    await run({ runId: "run-2", prompt: "Open the plan.", history });
    await run({ runId: "run-3", prompt: "Open the plan.", history });
    const [first, second] = sentMessages();
    expect(shape(first!)).toEqual([
      "user:What files do I have?",
      "assistant:Checking.+call list_files",
      "toolResult:list_files",
      expect.stringMatching(/^user:.*Only markdown\./s),
      "assistant:You have notes.md and plan.md.",
      "user:Open the plan.",
    ]);
    expect(JSON.stringify(first).split("Only markdown.")).toHaveLength(2);
    expect(JSON.stringify(first)).toContain("notes.md");
    // Same bytes on every turn.
    expect(JSON.stringify(second!.slice(0, -1))).toBe(JSON.stringify(first!.slice(0, -1)));
  });

  it("replays replies written since replayWindowBefore whole", async () => {
    providerState.stream.mockImplementation(() =>
      stream(assistant([{ type: "text", text: "Done." }], "stop")),
    );
    // Ten earlier turns that each read about 5k tokens: together past the 32k window.
    const history: AgentRunRequest["history"] = Array.from({ length: 10 }, (_, index) => [
      { id: `u-${index}`, role: "user" as const, content: `Read ${index}.` },
      {
        id: `a-${index}`,
        role: "assistant" as const,
        content: `Answer ${index}.`,
        createdAt: new Date(Date.UTC(2026, 0, 2, 9, index)).toISOString(),
        sentReply: [
          assistant(
            [{ type: "toolCall", id: `call-${index}`, name: "read_file", arguments: { index } }],
            "toolUse",
          ),
          {
            role: "toolResult",
            toolCallId: `call-${index}`,
            toolName: "read_file",
            content: [{ type: "text", text: "字".repeat(4_000) }],
            isError: false,
            timestamp: index,
          },
          assistant([{ type: "text", text: `Answer ${index}.` }], "stop"),
        ],
      },
    ]).flat();
    await run({ runId: "run-cold", prompt: "Next.", history });
    // Pinned before the fifth reply: the four before it fit the window, the rest replay whole.
    await run({
      runId: "run-warm",
      prompt: "Next.",
      history,
      replayWindowBefore: new Date(Date.UTC(2026, 0, 2, 9, 4)).toISOString(),
    });
    const [cold, warm] = sentMessages();
    expect(JSON.stringify(cold)).toContain("[tool result omitted");
    expect(JSON.stringify(warm)).not.toContain("[tool result omitted");
  });

  it("does not record a turn resumed from a checkpoint", async () => {
    const onTranscript = vi.fn();
    providerState.stream.mockImplementation(() =>
      stream(assistant([{ type: "text", text: "Done." }], "stop")),
    );
    await run({
      onTranscript,
      turnCheckpoint: JSON.stringify({
        version: 1,
        provider: primary.provider,
        model: primary.id,
        systemPrompt: "Use tools when useful.",
        pendingToolCallId: "call-1",
        messages: [
          { role: "user", content: "What files do I have?", timestamp: 1 },
          assistant(
            [{ type: "toolCall", id: "call-1", name: "list_files", arguments: { path: "" } }],
            "toolUse",
          ),
        ],
      }),
    });
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("keeps only replayable messages: no reasoning, failures, orphan results or images", () => {
    const messages = turnTranscript([
      assistant([{ type: "text", text: "Lost." }], "error"),
      { role: "toolResult", toolCallId: "nobody", toolName: "x", content: [], isError: false },
      assistant(
        [
          { type: "thinking", thinking: "hm", thinkingSignature: "s" },
          {
            type: "toolCall",
            id: "c",
            name: "computer_observe",
            arguments: {},
            thoughtSignature: "t",
          },
        ],
        "toolUse",
      ),
      {
        role: "toolResult",
        toolCallId: "c",
        toolName: "computer_observe",
        content: [
          { type: "text", text: "Screen." },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
        isError: false,
        timestamp: 2,
      },
      { role: "toolResult", toolCallId: "c", toolName: "computer_observe", content: [] },
    ]);
    expect(messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "toolCall", id: "c", name: "computer_observe", arguments: {} }],
      }),
      {
        role: "toolResult",
        toolCallId: "c",
        toolName: "computer_observe",
        content: [
          { type: "text", text: "Screen." },
          { type: "text", text: "[image omitted]" },
        ],
        isError: false,
        timestamp: 2,
      },
    ]);
  });
});

describe("replayTranscripts", () => {
  /** One turn that read one result of about 5,000 tokens. */
  const turn = (index: number): Message[] => [
    assistant(
      [{ type: "toolCall", id: `call-${index}`, name: "read_file", arguments: { index } }],
      "toolUse",
    ),
    {
      role: "toolResult",
      toolCallId: `call-${index}`,
      toolName: "read_file",
      content: [{ type: "text", text: "字".repeat(4_000) }],
      isError: false,
      timestamp: index,
    },
    assistant([{ type: "text", text: `Answer ${index}.` }], "stop"),
  ];
  const stubbed = (turns: Message[][]) =>
    turns.flatMap((messages, index) =>
      messages.some(
        (message) =>
          message.role === "toolResult" &&
          message.content.some(
            (part) => part.type === "text" && part.text.startsWith("[tool result omitted"),
          ),
      )
        ? [index]
        : [],
    );

  it("stubs older results past the frontier and keeps recent ones whole", () => {
    const replayed = replayTranscripts(Array.from({ length: 7 }, (_, index) => turn(index)));
    expect(stubbed(replayed)).toEqual([0, 1, 2, 3]);
    expect(replayed[0]![1]).toMatchObject({
      role: "toolResult",
      content: [{ type: "text", text: "[tool result omitted: read_file, 4000 chars]" }],
    });
    // Calls and answers stay, so the bot still knows what it did and said.
    expect(replayed[0]![0]).toMatchObject({ content: [{ type: "toolCall", name: "read_file" }] });
    expect(replayed[0]![2]).toMatchObject({ content: [{ type: "text", text: "Answer 0." }] });
  });

  it("stores as stubs only the results no replay could show whole", () => {
    const calls = Array.from({ length: 8 }, (_, index) => turn(index).slice(0, 2)).flat();
    const results = recordedTranscript(calls).filter((message) => message.role === "toolResult");
    // Eight results of about 5k tokens: the newest six fit the 32k window, the two oldest never can.
    expect(
      results.map((message) => JSON.stringify(message).includes("[tool result omitted")),
    ).toEqual([true, true, false, false, false, false, false, false]);
  });

  it("replays turns from wholeFrom on whole, leaving the window of earlier turns as it was", () => {
    const turns = Array.from({ length: 12 }, (_, index) => turn(index));
    // A pin after turn 3: every later turn replays the first four as that pin did.
    const pinned = replayTranscripts(turns.slice(0, 4));
    for (let count = 5; count <= turns.length; count += 1) {
      const replay = replayTranscripts(turns.slice(0, count), 4);
      expect(JSON.stringify(replay.slice(0, 4))).toBe(JSON.stringify(pinned));
      expect(stubbed(replay.slice(4))).toEqual([]);
    }
    // The next pin moves the window over all of them.
    expect(stubbed(replayTranscripts(turns))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps earlier turns byte-identical until the frontier jumps", () => {
    const turns = Array.from({ length: 12 }, (_, index) => turn(index));
    const replays = turns.map((_, count) => replayTranscripts(turns.slice(0, count + 1)));
    const rewrites = replays.flatMap((replay, count) => {
      const previous = replays[count - 1];
      if (!previous) return [];
      return JSON.stringify(replay.slice(0, count)) === JSON.stringify(previous) ? [] : [count];
    });
    // About 32k tokens of results stay whole; past that the start jumps to about half.
    expect(rewrites).toEqual([6, 10]);
  });
});
