import { HistoryReadInputSchema, HistorySearchInputSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { withoutBlankFields } from "./run-tools-memory.js";

describe("history tool arguments", () => {
  it("treats blank optional fields as not given", () => {
    expect(
      HistorySearchInputSchema.parse(
        withoutBlankFields({ queries: ["黑五"], botId: "", before: " ", query: null }),
      ),
    ).toEqual({ queries: ["黑五"] });
    expect(
      HistoryReadInputSchema.parse(
        withoutBlankFields({
          messageId: "cmw3l7emsa1sfb5bml8d0doe0",
          linkedRunId: "",
          threadId: "",
        }),
      ),
    ).toEqual({ messageId: "cmw3l7emsa1sfb5bml8d0doe0" });
  });
});
