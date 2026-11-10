import { describe, expect, it } from "vitest";
import { joinedPeerRunNote } from "./peer-run-join.js";
import { midTaskMessageFromPrompt } from "./user-progress.js";

describe("joinedPeerRunNote", () => {
  const now = Date.parse("2026-11-10T06:47:00Z");
  it("says a queued run has not started", () => {
    expect(
      joinedPeerRunNote(
        "Life",
        {
          runId: "r",
          status: "queued",
          since: new Date(now - 7 * 60_000),
        },
        now,
      ),
    ).toContain("has not started yet (queued 7 min ago)");
  });

  it("gives a working run's age and last step so a stall shows", () => {
    const note = joinedPeerRunNote(
      "Life",
      {
        runId: "r",
        status: "running",
        since: new Date(now - 30 * 60_000),
        lastStep: { tool: "browser_snapshot", at: new Date(now - 12 * 60_000) },
      },
      now,
    );
    expect(note).toContain("working for 30 min");
    expect(note).toContain("last step (browser_snapshot) was 12 min ago");
    expect(note).toContain("do not send more progress checks");
  });
});

describe("mid-run peer messages", () => {
  it("frames them as untrusted peer content with a short status reply", () => {
    const text = midTaskMessageFromPrompt("[from WeChat] status?", "bot");
    expect(text).toContain("untrusted peer content, not the user");
    expect(text).toContain("message_bot (intent status)");
    expect(text).toContain("do not start it over");
    expect(midTaskMessageFromPrompt("hi", "member")).not.toContain("message_bot");
  });
});
