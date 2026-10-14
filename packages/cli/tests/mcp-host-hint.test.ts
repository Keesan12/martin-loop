import { describe, expect, it } from "vitest";

import { executeCli } from "../src/index.js";

// `mcp print-config` requires --host; the suggestion must name every accepted host.
describe("mcp missing --host guidance", () => {
  it("lists every accepted host in both the message and the suggestion", async () => {
    const result = await executeCli(["mcp", "print-config", "--json"]);
    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout) as { category: string; message: string; suggestion: string };
    expect(payload.category).toBe("invalid_input");
    for (const host of ["codex", "claude", "gemini", "cursor", "vscode", "copilot", "continue", "generic"]) {
      expect(payload.message).toContain(host);
      expect(payload.suggestion).toContain(`--host ${host}`);
    }
  });
});
