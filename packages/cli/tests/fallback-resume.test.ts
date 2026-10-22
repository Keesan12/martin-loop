import { describe, expect, it } from "vitest";

import { parseCliArguments } from "../src/index.js";

describe("authorized provider fallback parsing", () => {
  it("preserves an explicit ordered fallback chain", () => {
    const parsed = parseCliArguments([
      "run",
      "fix the failing test",
      "--engine",
      "claude",
      "--fallback-engine",
      "codex",
      "--fallback-engine",
      "gemini",
      "--verify",
      "npm test"
    ]);
    expect(parsed).toMatchObject({
      command: "run",
      request: {
        engine: "claude",
        fallbackEngines: ["codex", "gemini"],
        objective: "fix the failing test"
      }
    });
  });

  it("rejects implicit, duplicate, and primary-provider fallbacks", () => {
    expect(() =>
      parseCliArguments(["run", "task", "--fallback-engine", "auto"])
    ).toThrow(/fallback-engine/iu);
    expect(() =>
      parseCliArguments([
        "run",
        "task",
        "--fallback-engine",
        "codex",
        "--fallback-engine",
        "codex"
      ])
    ).toThrow(/duplicate/iu);
    expect(() =>
      parseCliArguments([
        "run",
        "task",
        "--engine",
        "claude",
        "--fallback-engine",
        "claude"
      ])
    ).toThrow(/primary/iu);
  });
});

describe("execution continuation parsing", () => {
  it("adds a separate continue command without changing legacy resume lookup", () => {
    expect(
      parseCliArguments([
        "continue",
        "loop_abc123",
        "--engine",
        "claude",
        "--fallback-engine",
        "codex"
      ])
    ).toEqual({
      command: "continue_run",
      selector: { loopId: "loop_abc123" },
      engine: "claude",
      fallbackEngines: ["codex"]
    });

    expect(parseCliArguments(["resume", "loop_abc123"])).toEqual({
      command: "resume",
      selector: { loopId: "loop_abc123" }
    });

  it("parses requested continuation providers without granting authority by itself", () => {
    expect(
      parseCliArguments([
        "continue",
        "loop_abc123",
        "--engine",
        "codex",
        "--fallback-engine",
        "gemini"
      ])
    ).toMatchObject({
      command: "continue_run",
      engine: "codex",
      fallbackEngines: ["gemini"]
    });
  });
  });
});
