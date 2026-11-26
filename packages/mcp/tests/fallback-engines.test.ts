import { describe, expect, it } from "vitest";
import { validateToolInput } from "../src/server-validation.js";

describe("martin_run authorized fallback validation", () => {
  it("accepts only an explicit ordered unique engine and model profile chain", () => {
    expect(validateToolInput("martin_run", {
      objective: "fix the failing test", engine: "claude", model: "claude-opus-4-1",
      fallbackProfiles: [
        { engine: "codex", model: "gpt-6.1-sol" },
        { engine: "gemini", model: "gemini-3-pro-preview" }
      ], verificationPlan: ["npm test"]
    })).toMatchObject({
      objective: "fix the failing test", engine: "claude", model: "claude-opus-4-1",
      fallbackProfiles: [
        { engine: "codex", model: "gpt-6.1-sol" },
        { engine: "gemini", model: "gemini-3-pro-preview" }
      ]
    });
  });
  it("rejects legacy, duplicate, primary, unknown, and invalid-model fallbacks", () => {
    expect(() => validateToolInput("martin_run", { objective: "task", fallbackEngines: ["codex"] })).toThrow(/fallbackEngines.*fallbackProfiles/iu);
    expect(() => validateToolInput("martin_run", { objective: "task", fallbackProfiles: [{ engine: "codex", model: "gpt-6.1-sol" }, { engine: "codex", model: "other" }] })).toThrow(/duplicate/iu);
    expect(() => validateToolInput("martin_run", { objective: "task", fallbackProfiles: [{ engine: "unknown-provider", model: "x" }] })).toThrow(/fallbackProfiles/iu);
    expect(() => validateToolInput("martin_run", { objective: "task", engine: "codex", model: "gpt-6.1-sol", fallbackProfiles: [{ engine: "codex", model: "gpt-6.1-sol" }] })).toThrow(/primary/iu);
    expect(() => validateToolInput("martin_run", { objective: "task", fallbackProfiles: [{ engine: "gemini", model: "auto" }] })).toThrow(/model/iu);
  });
});
