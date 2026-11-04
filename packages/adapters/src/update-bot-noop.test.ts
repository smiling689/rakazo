import { describe, expect, it } from "vitest";
import { dropUnchangedOwnBotArgs } from "./update-bot-patch.js";

const current = {
  name: "WeChat",
  description: "Answers on a chat app.",
  instructions: "Be brief.",
  color: "#22C55E",
  notifyOnFinish: false,
  dailyCheckIns: false,
  modelId: null,
  thinkingLevel: "high",
  autoSpeak: false,
  voiceId: null,
};

describe("dropUnchangedOwnBotArgs", () => {
  it("turns a call that repeats every current value into a read", () => {
    expect(
      dropUnchangedOwnBotArgs(
        {
          name: "WeChat",
          description: " Answers on a chat app. ",
          instructions: "Be brief.",
          color: "#22C55E",
          notifyOnFinish: false,
          dailyCheckIns: false,
          thinkingLevel: "high",
          readAloud: false,
          voice: "default",
          use_attached_image: false,
          instructions_offset: 0,
        },
        current,
      ),
    ).toEqual({ instructions_offset: 0 });
  });

  it("keeps real changes", () => {
    expect(
      dropUnchangedOwnBotArgs(
        { thinkingLevel: "max", readAloud: true, use_attached_image: true, model: "gpt-fixture" },
        current,
      ),
    ).toEqual({
      thinkingLevel: "max",
      readAloud: true,
      use_attached_image: true,
      model: "gpt-fixture",
    });
  });
});
