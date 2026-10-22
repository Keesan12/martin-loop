/**
 * Recovery context pipeline tests — Stage B.
 *
 * Proves that structured failure evidence (command, exit, excerpt, attemptId)
 * is correctly carried into the next adapter request when a verifier fails.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileRunStore, runMartin, type MartinAdapter, type MartinAdapterRequest } from "../src/index.js";

function makeAdapter(
  attempts: Array<() => MartinAdapterRequest["context"]["lastVerifierFailure"] extends infer _ ? ReturnType<MartinAdapter["execute"]> extends Promise<infer R> ? R : never : never>,
  captured: { requests: MartinAdapterRequest[] }
): MartinAdapter {
  let idx = 0;
  return {
    adapterId: "agent-cli:claude",
    kind: "direct-provider",
    label: "test",
    metadata: { providerId: "claude", model: "test", capabilities: { workspaceMutations: false } },
    async execute(request) {
      captured.requests.push(request);
      const result = attempts[idx]?.() ?? { status: "completed" as const, summary: "pass", usage: { actualUsd: 0.01, tokensIn: 10, tokensOut: 5, provenance: "actual" as const }, verification: { passed: true, summary: "pass", binding: { runId: request.loopId, attemptId: request.attemptId, workspaceId: request.workspaceId, cwd: "/tmp", commands: ["npm test"] }, steps: [{ command: "npm test", launched: true, completed: true, crashed: false, exitCode: 0, timedOut: false }] } };
      idx++;
      return result;
    }
  };
}

const BASE_TASK = { title: "t", objective: "o", verificationPlan: ["npm test"], mutationMode: "read_only" as const, agentExecutionIntent: "governed-autonomous" as const };
const BASE_BUDGET = { maxUsd: 0.5, softLimitUsd: 0.4, maxIterations: 3 };

describe("Stage B — recovery context pipeline", () => {
  it("feeds exact failing verifier command, exit code and excerpt to attempt 2", async () => {
    const dir = await mkdtemp(join(tmpdir(), "martin-recov-"));
    try {
      const store = createFileRunStore({ runsRoot: join(dir, "runs") });
      const captured: { requests: MartinAdapterRequest[] } = { requests: [] };

      const failResult = (request: MartinAdapterRequest) => ({
        status: "completed" as const, summary: "wrong",
        usage: { actualUsd: 0.01, tokensIn: 10, tokensOut: 5, provenance: "actual" as const },
        verification: { passed: false, summary: "1 test failed",
          binding: { runId: request.loopId, attemptId: request.attemptId, workspaceId: request.workspaceId, cwd: dir, commands: ["npm test"] },
          steps: [{ command: "npm test", launched: true, completed: true, crashed: false, exitCode: 1, timedOut: false, detail: "AssertionError: expected foo got bar\n  at normalizePath (config.js:12)" }] }
      });
      const passResult = (request: MartinAdapterRequest) => ({
        status: "completed" as const, summary: "fixed",
        usage: { actualUsd: 0.01, tokensIn: 10, tokensOut: 5, provenance: "actual" as const },
        verification: { passed: true, summary: "pass",
          binding: { runId: request.loopId, attemptId: request.attemptId, workspaceId: request.workspaceId, cwd: dir, commands: ["npm test"] },
          steps: [{ command: "npm test", launched: true, completed: true, crashed: false, exitCode: 0, timedOut: false }] }
      });

      let call = 0;
      const adapter: MartinAdapter = {
        adapterId: "agent-cli:claude", kind: "direct-provider", label: "test",
        metadata: { providerId: "claude", model: "test", capabilities: { workspaceMutations: false } },
        async execute(request) {
          captured.requests.push(request);
          return (call++ === 0) ? failResult(request) : passResult(request);
        }
      };

      await runMartin({ workspaceId: "ws1", projectId: "p1", task: BASE_TASK, budget: BASE_BUDGET, adapter, store });

      expect(captured.requests).toHaveLength(2);
      const failure = captured.requests[1]?.context.lastVerifierFailure;
      expect(failure).toBeDefined();
      expect(failure?.command).toBe("npm test");
      expect(failure?.exitCode).toBe(1);
      expect(failure?.failureExcerpt).toContain("AssertionError");
      expect(failure?.failureExcerpt).toContain("normalizePath");
      expect(failure?.attemptId).toBeDefined();
      expect(failure?.attemptIndex).toBe(1);
      expect(failure?.crashed).toBeFalsy();
      expect(failure?.timedOut).toBeFalsy();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("falls back to verification summary when step detail is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "martin-recov-empty-"));
    try {
      const store = createFileRunStore({ runsRoot: join(dir, "runs") });
      const captured: { requests: MartinAdapterRequest[] } = { requests: [] };
      let call = 0;
      const adapter: MartinAdapter = {
        adapterId: "agent-cli:claude", kind: "direct-provider", label: "test",
        metadata: { providerId: "claude", model: "test", capabilities: { workspaceMutations: false } },
        async execute(request) {
          captured.requests.push(request);
          if (call++ === 0) {
            return { status: "completed" as const, summary: "wrong",
              usage: { actualUsd: 0.01, tokensIn: 10, tokensOut: 5, provenance: "actual" as const },
              verification: { passed: false, summary: "Verifier exited with code 1 — no output captured",
                warnings: ["verifier produced no stdout"],
                binding: { runId: request.loopId, attemptId: request.attemptId, workspaceId: request.workspaceId, cwd: dir, commands: ["npm test"] },
                steps: [{ command: "npm test", launched: true, completed: true, crashed: false, exitCode: 1, timedOut: false, detail: "" }] } };
          }
          return { status: "completed" as const, summary: "pass",
            usage: { actualUsd: 0.01, tokensIn: 10, tokensOut: 5, provenance: "actual" as const },
            verification: { passed: true, summary: "pass",
              binding: { runId: request.loopId, attemptId: request.attemptId, workspaceId: request.workspaceId, cwd: dir, commands: ["npm test"] },
              steps: [{ command: "npm test", launched: true, completed: true, crashed: false, exitCode: 0, timedOut: false }] } };
        }
      };

      await runMartin({ workspaceId: "ws2", projectId: "p2", task: BASE_TASK, budget: BASE_BUDGET, adapter, store });

      const failure = captured.requests[1]?.context.lastVerifierFailure;
      expect(failure).toBeDefined();
      // Must not send empty excerpt — must fall back to summary/warnings
      expect(failure?.failureExcerpt.length).toBeGreaterThan(0);
      expect(failure?.failureExcerpt).toContain("Verifier exited");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("represents timeout failure with timedOut=true and no exitCode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "martin-recov-timeout-"));
    try {
      const store = createFileRunStore({ runsRoot: join(dir, "runs") });
      const captured: { requests: MartinAdapterRequest[] } = { requests: [] };
      let call = 0;
      const adapter: MartinAdapter = {
        adapterId: "agent-cli:claude", kind: "direct-provider", label: "test",
        metadata: { providerId: "claude", model: "test", capabilities: { workspaceMutations: false } },
        async execute(request) {
          captured.requests.push(request);
          if (call++ === 0) {
            return { status: "completed" as const, summary: "timed out",
              usage: { actualUsd: 0.01, tokensIn: 10, tokensOut: 5, provenance: "actual" as const },
              verification: { passed: false, summary: "Verifier timed out after 60s",
                binding: { runId: request.loopId, attemptId: request.attemptId, workspaceId: request.workspaceId, cwd: dir, commands: ["npm test"] },
                steps: [{ command: "npm test", launched: true, completed: false, crashed: false, exitCode: -1, timedOut: true, detail: "killed after 60000ms" }] } };
          }
          return { status: "completed" as const, summary: "pass",
            usage: { actualUsd: 0.01, tokensIn: 10, tokensOut: 5, provenance: "actual" as const },
            verification: { passed: true, summary: "pass",
              binding: { runId: request.loopId, attemptId: request.attemptId, workspaceId: request.workspaceId, cwd: dir, commands: ["npm test"] },
              steps: [{ command: "npm test", launched: true, completed: true, crashed: false, exitCode: 0, timedOut: false }] } };
        }
      };

      await runMartin({ workspaceId: "ws3", projectId: "p3", task: BASE_TASK, budget: BASE_BUDGET, adapter, store });

      const failure = captured.requests[1]?.context.lastVerifierFailure;
      expect(failure).toBeDefined();
      expect(failure?.timedOut).toBe(true);
      expect(failure?.exitCode).toBeUndefined();
      expect(failure?.failureExcerpt).toContain("killed after");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("first attempt (no previousAttempts) has no lastVerifierFailure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "martin-recov-first-"));
    try {
      const store = createFileRunStore({ runsRoot: join(dir, "runs") });
      const captured: { requests: MartinAdapterRequest[] } = { requests: [] };
      const adapter: MartinAdapter = {
        adapterId: "agent-cli:claude", kind: "direct-provider", label: "test",
        metadata: { providerId: "claude", model: "test", capabilities: { workspaceMutations: false } },
        async execute(request) {
          captured.requests.push(request);
          return { status: "completed" as const, summary: "pass",
            usage: { actualUsd: 0.01, tokensIn: 10, tokensOut: 5, provenance: "actual" as const },
            verification: { passed: true, summary: "pass",
              binding: { runId: request.loopId, attemptId: request.attemptId, workspaceId: request.workspaceId, cwd: dir, commands: ["npm test"] },
              steps: [{ command: "npm test", launched: true, completed: true, crashed: false, exitCode: 0, timedOut: false }] } };
        }
      };

      await runMartin({ workspaceId: "ws4", projectId: "p4", task: BASE_TASK, budget: BASE_BUDGET, adapter, store });
      expect(captured.requests[0]?.context.lastVerifierFailure).toBeUndefined();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
