import { describe, expect, it } from "vitest";

import { validateToolInput } from "../src/server-validation.js";

describe("martin_run authorized fallback validation", () => {
  it("accepts only an explicit ordered unique provider chain", () => {
    expect(
      validateToolInput("martin_run", {
        objective: "fix the failing test",
        engine: "claude",
        fallbackEngines: ["codex", "gemini"],
        verificationPlan: ["npm test"]
      })
    ).toMatchObject({
      objective: "fix the failing test",
      engine: "claude",
      fallbackEngines: ["codex", "gemini"]
    });
  });

  it("rejects duplicate or unknown fallback providers", () => {
    expect(() =>
      validateToolInput("martin_run", {
        objective: "task",
        fallbackEngines: ["codex", "codex"]
      })
    ).toThrow(/duplicate/iu);

    expect(() =>
      validateToolInput("martin_run", {
        objective: "task",
        fallbackEngines: ["unknown-provider"]
      })
    ).toThrow(/fallbackEngines/iu);
  });
});
