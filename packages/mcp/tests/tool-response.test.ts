import { describe, expect, it } from "vitest";

import { createToolSuccessResult } from "../src/tools/tool-response.js";

describe("MCP success response presentation", () => {
  it("puts the human artifact first while preserving structured and compatibility JSON", () => {
    const output = { loopId: "loop_123", status: "completed" };
    const result = createToolSuccessResult(output, "Run loop_123 completed.");

    expect(result.content[0]?.text).toBe("Run loop_123 completed.");
    expect(JSON.parse(result.content[1]?.text ?? "")).toEqual(output);
    expect(result.structuredContent).toEqual(output);
  });

  it("uses a rendered dossier as the IDE-visible Markdown artifact", () => {
    const output = {
      loopId: "loop_123",
      rendered: "# MartinLoop Verified Handoff\n\n**Outcome:** VERIFIED"
    };
    const result = createToolSuccessResult(output, "Dossier ready.");

    expect(result.content[0]?.text).toBe(output.rendered);
    expect(JSON.parse(result.content[1]?.text ?? "")).toEqual(output);
    expect(result.structuredContent).toEqual(output);
  });
});
