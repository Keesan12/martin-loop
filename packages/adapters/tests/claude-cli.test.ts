import { describe, expect, it } from "vitest";

import type { MartinAdapterRequest } from "@martin/core";

import {
  createAgentCliAdapter,
  createClaudeCliAdapter,
  createCodexCliAdapter
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<MartinAdapterRequest> = {}): MartinAdapterRequest {
  return {
    loopId: "loop_test",
    attemptId: "att_test_1",
    context: {
      taskTitle: "Fix the off-by-one error",
      objective: "Correct the index calculation in counter.ts so the result is 10 not 9.",
      verificationPlan: ["pnpm test -- counter"],
      focus: "Fix only the index calculation. Do not touch other code.",
      remainingBudgetUsd: 8,
      remainingIterations: 3,
      remainingTokens: 10_000
    },
    previousAttempts: [],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Generic adapter factory
// ---------------------------------------------------------------------------

describe("createAgentCliAdapter", () => {
  it("returns correct adapterId, kind, and metadata", () => {
    const adapter = createAgentCliAdapter({
      command: "mytool",
      argsBuilder: (prompt) => ["--run", prompt],
      model: "mytool-v1",
      label: "My tool"
    });

    expect(adapter.adapterId).toBe("agent-cli:mytool");
    expect(adapter.kind).toBe("agent-cli");
    expect(adapter.label).toBe("My tool");
    expect(adapter.metadata.providerId).toBe("mytool");
    expect(adapter.metadata.model).toBe("mytool-v1");
    expect(adapter.metadata.transport).toBe("cli");
    expect(adapter.metadata.capabilities.usageSettlement).toBe(false);
  });

  it("uses adapterIdSuffix when provided", () => {
    const adapter = createAgentCliAdapter({
      command: "claude",
      adapterIdSuffix: "claude-sonnet",
      argsBuilder: (p) => [p]
    });

    expect(adapter.adapterId).toBe("agent-cli:claude-sonnet");
  });

  it("returns failed with stalled message when subprocess times out", async () => {
    const adapter = createAgentCliAdapter({
      command: process.execPath,
      argsBuilder: () => ["-e", "setTimeout(() => {}, 10_000)"],
      timeoutMs: 50
    });

    const result = await adapter.execute(makeRequest());

    expect(result.status).toBe("failed");
    expect(result.verification.passed).toBe(false);
    expect(result.failure?.message).toContain("stalled");
  });

  it("normalizes sync ENOENT spawn failures into failed adapter results", async () => {
    const adapter = createAgentCliAdapter({
      command: "definitely-not-a-real-binary-xyzabc",
      argsBuilder: (p) => [p],
      spawnImpl() {
        const error = new Error("spawn ENOENT");
        Object.assign(error, { code: "ENOENT" });
        throw error;
      }
    });

    const result = await adapter.execute(makeRequest());

    expect(result.status).toBe("failed");
    expect(result.failure?.message).toContain("environment_mismatch");
  });

  it("normalizes sync EPERM spawn failures into failed adapter results", async () => {
    const adapter = createAgentCliAdapter({
      command: "codex",
      argsBuilder: () => ["--full-auto", "test"],
      spawnImpl() {
        const error = new Error("spawn EPERM");
        Object.assign(error, { code: "EPERM" });
        throw error;
      }
    });

    const result = await adapter.execute(makeRequest());

    expect(result.status).toBe("failed");
    expect(result.verification.passed).toBe(false);
    expect(result.failure?.message).toContain("environment_mismatch");
  });

  it("runs verification and returns completed when all commands pass", async () => {
    const adapter = createAgentCliAdapter({
      command: process.platform === "win32" ? "cmd" : "echo",
      argsBuilder: () =>
        process.platform === "win32" ? ["/c", "echo", "done"] : ["done"]
    });

    const request = makeRequest({
      context: {
        taskTitle: "test",
        objective: "test",
        verificationPlan: process.platform === "win32" ? ["cmd /c exit 0"] : ["true"],
        focus: "test",
        remainingBudgetUsd: 8,
        remainingIterations: 3,
        remainingTokens: 10_000
      }
    });

    const result = await adapter.execute(request);

    expect(result.status).toBe("completed");
    expect(result.verification.passed).toBe(true);
  });

  it("returns failed when verification command exits non-zero", async () => {
    const adapter = createAgentCliAdapter({
      command: process.platform === "win32" ? "cmd" : "echo",
      argsBuilder: () =>
        process.platform === "win32" ? ["/c", "echo", "done"] : ["done"]
    });

    const request = makeRequest({
      context: {
        taskTitle: "test",
        objective: "test",
        verificationPlan: process.platform === "win32" ? ["cmd /c exit 1"] : ["false"],
        focus: "test",
        remainingBudgetUsd: 8,
        remainingIterations: 3,
        remainingTokens: 10_000
      }
    });

    const result = await adapter.execute(request);

    expect(result.status).toBe("failed");
    expect(result.verification.passed).toBe(false);
    expect(result.failure).toBeDefined();
  });

  it("includes prior attempt context in the prompt (via argsBuilder inspection)", () => {
    const capturedArgs: string[] = [];

    const adapter = createAgentCliAdapter({
      command: process.platform === "win32" ? "cmd" : "echo",
      argsBuilder: (prompt) => {
        capturedArgs.push(prompt);
        return process.platform === "win32" ? ["/c", "echo", "ok"] : ["ok"];
      }
    });

    const request = makeRequest({
      previousAttempts: [
        {
          attemptId: "att_1",
          index: 1,
          adapterId: "agent-cli:claude",
          model: "claude",
          startedAt: "2025-01-01T00:00:00Z",
          summary: "Changed wrong line.",
          failureClass: "logic_error",
          intervention: "change_model"
        }
      ]
    });

    void adapter.execute(request);

    expect(capturedArgs[0]).toContain("PRIOR FAILED ATTEMPTS");
    expect(capturedArgs[0]).toContain("logic_error");
    expect(capturedArgs[0]).toContain("change_model");
  });

  it("passes empty verification with no commands", async () => {
    const adapter = createAgentCliAdapter({
      command: process.platform === "win32" ? "cmd" : "echo",
      argsBuilder: () =>
        process.platform === "win32" ? ["/c", "echo", "done"] : ["done"]
    });

    const request = makeRequest({
      context: {
        taskTitle: "test",
        objective: "test",
        verificationPlan: [],
        focus: "test",
        remainingBudgetUsd: 8,
        remainingIterations: 3,
        remainingTokens: 10_000
      }
    });

    const result = await adapter.execute(request);

    expect(result.status).toBe("completed");
    expect(result.verification.summary).toContain("No verification commands");
  });

  it("returns estimated cost provenance when the CLI does not emit settled usage", async () => {
    const adapter = createAgentCliAdapter({
      command: process.execPath,
      argsBuilder: () => ["-e", "console.log('done')"],
      supportsJsonOutput: false
    });

    const result = await adapter.execute(
      makeRequest({
        context: {
          taskTitle: "test",
          objective: "test",
          verificationPlan: [],
          focus: "test",
          remainingBudgetUsd: 8,
          remainingIterations: 3,
          remainingTokens: 10_000
        }
      })
    );

    expect(result.status).toBe("completed");
    expect(result.usage.provenance).toBe("estimated");
    expect(result.usage.estimatedUsd).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Claude-specific factory
// ---------------------------------------------------------------------------

describe("createClaudeCliAdapter", () => {
  it("returns correct adapterId and kind", () => {
    const adapter = createClaudeCliAdapter();

    expect(adapter.adapterId).toBe("agent-cli:claude");
    expect(adapter.kind).toBe("agent-cli");
    expect(adapter.metadata.providerId).toBe("claude");
    expect(adapter.metadata.transport).toBe("cli");
  });

  it("surfaces model in metadata when provided", () => {
    const adapter = createClaudeCliAdapter({ model: "claude-opus-4-6" });

    expect(adapter.metadata.model).toBe("claude-opus-4-6");
  });

  it("returns failed gracefully when claude is not installed", async () => {
    // When claude IS installed and runs successfully, status may be "completed"
    const adapter = createClaudeCliAdapter({ timeoutMs: 2_000 });
    const result = await adapter.execute(makeRequest());

    expect(["failed", "completed"]).toContain(result.status);
  });
});

// ---------------------------------------------------------------------------
// Codex-specific factory
// ---------------------------------------------------------------------------

describe("createCodexCliAdapter", () => {
  it("returns correct adapterId and kind", () => {
    const adapter = createCodexCliAdapter();

    expect(adapter.adapterId).toBe("agent-cli:codex");
    expect(adapter.kind).toBe("agent-cli");
    expect(adapter.metadata.providerId).toBe("codex");
    expect(adapter.metadata.transport).toBe("cli");
  });

  it("surfaces model in metadata when provided", () => {
    const adapter = createCodexCliAdapter({ model: "o3" });

    expect(adapter.metadata.model).toBe("o3");
  });

  it("returns failed gracefully when codex is not installed", async () => {
    const adapter = createCodexCliAdapter({ timeoutMs: 2_000 });
    const result = await adapter.execute(makeRequest());

    expect(["failed", "completed"]).toContain(result.status);
  });
});
