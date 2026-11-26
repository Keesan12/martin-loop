import { describe, expect, it } from "vitest";
import { parseCliArguments } from "../src/index.js";

describe("authorized provider fallback parsing", () => {
  it("preserves an explicit ordered engine and model profile chain", () => {
    expect(parseCliArguments([
      "run", "fix the failing test", "--engine", "claude", "--model", "claude-opus-4-1",
      "--fallback-profile", "codex=gpt-6.1-sol", "--fallback-profile", "gemini=gemini-3-pro-preview",
      "--verify", "npm test"
    ])).toMatchObject({ command: "run", request: {
      engine: "claude", model: "claude-opus-4-1",
      fallbackProfiles: [
        { engine: "codex", model: "gpt-6.1-sol" },
        { engine: "gemini", model: "gemini-3-pro-preview" }
      ], objective: "fix the failing test"
    }});
  });

  it("rejects legacy, malformed, duplicate, primary-provider, and sentinel fallbacks", () => {
    expect(() => parseCliArguments(["run", "task", "--fallback-engine", "codex"]))
      .toThrow(/fallback-profile.*engine=model/iu);
    expect(() => parseCliArguments(["run", "task", "--fallback-profile", "codex=gpt-6.1-sol", "--fallback-profile", "codex=other"]))
      .toThrow(/duplicate/iu);
    expect(() => parseCliArguments(["run", "task", "--engine", "claude", "--fallback-profile", "claude=claude-opus-4-1"]))
      .toThrow(/primary/iu);
    expect(() => parseCliArguments(["run", "task", "--fallback-profile", "codex=auto"]))
      .toThrow(/model/iu);
    expect(() => parseCliArguments(["run", "task", "--fallback-profile", "codex"]))
      .toThrow(/engine=model/iu);
  });
});

describe("execution continuation parsing", () => {
  it("adds a separate continue command without changing legacy resume lookup", () => {
    expect(parseCliArguments(["continue", "loop_abc123", "--engine", "claude", "--model", "claude-opus-4-1", "--fallback-profile", "codex=gpt-6.1-sol"]))
      .toEqual({ command: "continue_run", selector: { loopId: "loop_abc123" }, engine: "claude", model: "claude-opus-4-1", fallbackProfiles: [{ engine: "codex", model: "gpt-6.1-sol" }] });
    expect(parseCliArguments(["resume", "loop_abc123"]))
      .toEqual({ command: "resume", selector: { loopId: "loop_abc123" } });
  });
  it("rejects legacy engine-only continuation authority", () => {
    expect(() => parseCliArguments(["continue", "loop_abc123", "--fallback-engine", "gemini"]))
      .toThrow(/fallback-profile.*engine=model/iu);
  });
});
