import { describe, expect, it } from "vitest";
import {
  chatAppAskChoice,
  chatAppAskText,
  chatAppTakeoverText,
  isChoiceAskBlock,
} from "./chat-app-asks.js";

const choice = {
  kind: "ask",
  text: "Which model should I use?",
  status: "pending",
  actions: [
    { id: "choice-1", label: "gpt-5.5" },
    { id: "choice-2", label: "Keep the current one" },
  ],
};
const approval = {
  kind: "ask",
  text: "Run a command on the server?",
  approvalEffectId: "eff-1",
  actions: [
    { id: "allow", label: "Allow" },
    { id: "deny", label: "Deny" },
  ],
};

describe("chat app asks", () => {
  it("lists a pending choice by number", () => {
    expect(chatAppAskText(choice)).toBe(
      "Which model should I use?\n1. gpt-5.5\n2. Keep the current one\nReply with a number to choose.",
    );
    expect(chatAppAskText({ ...choice, text: "想切换到哪个?" })).toContain("回复编号即可选择。");
  });

  it("only points to the app for approvals and secret requests", () => {
    expect(isChoiceAskBlock(approval)).toBe(false);
    expect(chatAppAskText(approval)).toBe(
      "Run a command on the server?\n(This waits for you in the app.)",
    );
    expect(chatAppAskText({ kind: "ask", text: "需要密码", input: "secret" })).toBe(
      "需要密码\n(需要你在 App 里处理)",
    );
  });

  it("says nothing once a question is answered", () => {
    expect(chatAppAskText({ ...choice, status: "answered" })).toBeUndefined();
    expect(chatAppAskChoice({ ...choice, status: "answered" }, "1")).toBeUndefined();
  });

  it("picks an option by number or exact label, and nothing else", () => {
    expect(chatAppAskChoice(choice, "2")?.label).toBe("Keep the current one");
    expect(chatAppAskChoice(choice, " 1. ")?.label).toBe("gpt-5.5");
    expect(chatAppAskChoice(choice, "GPT-5.5")?.label).toBe("gpt-5.5");
    expect(chatAppAskChoice(choice, "3")).toBeUndefined();
    expect(chatAppAskChoice(choice, "the first one please")).toBeUndefined();
    expect(chatAppAskChoice(approval, "1")).toBeUndefined();
    expect(chatAppAskChoice(approval, "Allow")).toBeUndefined();
  });
});

describe("chatAppTakeoverText", () => {
  it("says a takeover waits on the screen in the app", () => {
    expect(
      chatAppTakeoverText({
        kind: "computer",
        state: "Needs you",
        text: "Linux DO 出现 Cloudflare 验证",
      }),
    ).toBe(
      "Linux DO 出现 Cloudflare 验证\n(需要你接管电脑屏幕：在 App 里打开这个 bot 的聊天，接管屏幕，完成后交还)",
    );
    expect(
      chatAppTakeoverText({ kind: "computer", state: "Needs you", text: "Solve the check" }),
    ).toContain("take over");
  });

  it("ignores other computer states and blocks", () => {
    expect(chatAppTakeoverText({ kind: "computer", state: "Done", text: "x" })).toBeUndefined();
    expect(chatAppTakeoverText({ kind: "text", text: "x" })).toBeUndefined();
  });
});
