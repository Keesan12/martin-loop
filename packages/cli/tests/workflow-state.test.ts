// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateCliRunGate, recordCliWorkflowStep } from "../src/workflow-state.js";

// Mirror the internal deriveWorkspaceKey + normalizeWorkingDirectory logic so tests
// can assert on filesystem paths without importing private symbols.
function testWorkspaceKey(workingDirectory: string): string {
  const normalized = resolve(workingDirectory);
  const input = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

describe("workflow state gate", () => {
  it("allows run when doctor/session/preflight receipts exist without explicit path flags", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-workflow-state-"));
    const workingDirectory = join(runsRoot, "workspace");
    const objective = "Summarize the demo workspace and prove tests still pass";
    const verificationPlan = ["npm test"];
    const receiptScope = {
      invocationRoot: workingDirectory,
      workingDirectory,
      repoRoot: workingDirectory,
      runsRoot
    };
    const budget = {
      maxUsd: 1,
      softLimitUsd: 1,
      maxIterations: 1,
      maxTokens: 1000
    };

    try {
      await recordCliWorkflowStep({
        runsRoot,
        step: "doctor",
        workingDirectory,
        receiptScope
      });
      await recordCliWorkflowStep({
        runsRoot,
        step: "session-start",
        workingDirectory,
        receiptScope
      });
      // Estimate is now required before any governed run — proves cost was seen first.
      await recordCliWorkflowStep({
        runsRoot,
        step: "estimate",
        workingDirectory,
        objective,
        receiptScope,
        budget
      });
      await recordCliWorkflowStep({
        runsRoot,
        step: "preflight",
        workingDirectory,
        objective,
        engine: "claude",
        verificationPlan,
        receiptScope,
        budget
      });

      const gate = await evaluateCliRunGate({
        runsRoot,
        workingDirectory,
        objective,
        engine: "claude",
        verificationPlan,
        receiptScope,
        budget
      });

      expect(gate.allowed).toBe(true);
      expect(gate.missingSteps).toEqual([]);
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it("invalidates an estimate when the objective or dollar budget changes", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-estimate-scope-"));
    const workingDirectory = join(runsRoot, "workspace");
    const receiptScope = { invocationRoot: workingDirectory, workingDirectory, repoRoot: workingDirectory, runsRoot };
    const verificationPlan = ["npm test"];
    const budget = { maxUsd: 2, softLimitUsd: 1.5, maxIterations: 2 };

    try {
      await recordCliWorkflowStep({ runsRoot, step: "doctor", workingDirectory, receiptScope });
      await recordCliWorkflowStep({ runsRoot, step: "estimate", workingDirectory, objective: "Fix alpha", receiptScope, budget });
      await recordCliWorkflowStep({ runsRoot, step: "preflight", workingDirectory, objective: "Fix alpha", verificationPlan, receiptScope });

      const changedObjective = await evaluateCliRunGate({
        runsRoot, workingDirectory, objective: "Fix beta", verificationPlan, receiptScope, budget
      });
      expect(changedObjective.missingSteps).toContain("estimate");

      const changedBudget = await evaluateCliRunGate({
        runsRoot,
        workingDirectory,
        objective: "Fix alpha",
        verificationPlan,
        receiptScope,
        budget: { ...budget, maxUsd: 3 }
      });
      expect(changedBudget.missingSteps).toContain("estimate");
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it("keeps doctor and session receipts valid when invocation root changes inside the same repo", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-workflow-state-initcwd-"));
    const workingDirectory = join(runsRoot, "workspace");
    const shiftedInvocationRoot = join(workingDirectory, "tools");
    const objective = "Verify governed receipt continuity";
    const verificationPlan = ["npm test"];
    const initialReceiptScope = {
      invocationRoot: workingDirectory,
      workingDirectory,
      repoRoot: workingDirectory,
      runsRoot
    };
    const shiftedReceiptScope = {
      invocationRoot: shiftedInvocationRoot,
      workingDirectory,
      repoRoot: workingDirectory,
      runsRoot
    };

    try {
      await recordCliWorkflowStep({
        runsRoot,
        step: "doctor",
        workingDirectory,
        receiptScope: initialReceiptScope
      });
      await recordCliWorkflowStep({
        runsRoot,
        step: "session-start",
        workingDirectory,
        receiptScope: initialReceiptScope
      });
      await recordCliWorkflowStep({
        runsRoot,
        step: "estimate",
        workingDirectory,
        objective,
        receiptScope: initialReceiptScope
      });
      await recordCliWorkflowStep({
        runsRoot,
        step: "preflight",
        workingDirectory,
        objective,
        engine: "codex",
        verificationPlan,
        receiptScope: initialReceiptScope
      });

      const gate = await evaluateCliRunGate({
        runsRoot,
        workingDirectory,
        objective,
        engine: "codex",
        verificationPlan,
        receiptScope: shiftedReceiptScope
      });

      expect(gate.allowed).toBe(true);
      expect(gate.missingSteps).toEqual([]);
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when the canonical repo identity changes even if the invocation root shape still looks similar", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-workflow-state-repo-shift-"));
    const workingDirectory = join(runsRoot, "workspace");
    const objective = "Verify governed receipt continuity";
    const verificationPlan = ["npm test"];
    const initialReceiptScope = {
      invocationRoot: workingDirectory,
      workingDirectory,
      repoRoot: workingDirectory,
      runsRoot
    };
    const shiftedReceiptScope = {
      invocationRoot: join(workingDirectory, "tools"),
      workingDirectory,
      repoRoot: join(runsRoot, "different-workspace"),
      runsRoot
    };

    try {
      await recordCliWorkflowStep({
        runsRoot,
        step: "doctor",
        workingDirectory,
        receiptScope: initialReceiptScope
      });
      await recordCliWorkflowStep({
        runsRoot,
        step: "estimate",
        workingDirectory,
        objective,
        receiptScope: initialReceiptScope
      });
      await recordCliWorkflowStep({
        runsRoot,
        step: "preflight",
        workingDirectory,
        objective,
        engine: "codex",
        verificationPlan,
        receiptScope: initialReceiptScope
      });

      const gate = await evaluateCliRunGate({
        runsRoot,
        workingDirectory,
        objective,
        engine: "codex",
        verificationPlan,
        receiptScope: shiftedReceiptScope
      });

      expect(gate.allowed).toBe(false);
      expect(gate.missingSteps).toContain("doctor");
      expect(gate.nextCommand).toBe("martin-loop doctor");
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it("blocks run when path scope differs from the preflight receipt", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-workflow-state-path-scope-"));
    const workingDirectory = join(runsRoot, "workspace");
    const objective = "Verify scoped changes";
    const verificationPlan = ["npm test"];
    const receiptScope = {
      invocationRoot: workingDirectory,
      workingDirectory,
      repoRoot: workingDirectory,
      runsRoot
    };
    const budget = {
      maxUsd: 1,
      softLimitUsd: 1,
      maxIterations: 1,
      maxTokens: 1000
    };

    try {
      await recordCliWorkflowStep({
        runsRoot,
        step: "doctor",
        workingDirectory,
        receiptScope
      });
      await recordCliWorkflowStep({
        runsRoot,
        step: "estimate",
        workingDirectory,
        objective,
        receiptScope,
        budget
      });
      await recordCliWorkflowStep({
        runsRoot,
        step: "preflight",
        workingDirectory,
        objective,
        engine: "codex",
        verificationPlan,
        receiptScope,
        allowedPaths: ["docs/**"],
        budget
      });

      const gate = await evaluateCliRunGate({
        runsRoot,
        workingDirectory,
        objective,
        engine: "codex",
        verificationPlan,
        receiptScope,
        allowedPaths: ["packages/**"],
        budget
      });

      expect(gate.allowed).toBe(false);
      expect(gate.missingSteps).toContain("preflight");
      expect(gate.nextCommand).toContain("martin-loop preflight");
      expect(gate.message).toContain("verifier or path scope changed");
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it("blocks run when verifier bounds differ from the preflight receipt", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-workflow-state-verifier-"));
    const workingDirectory = join(runsRoot, "workspace");
    const objective = "Verify scoped changes";
    const receiptScope = {
      invocationRoot: workingDirectory,
      workingDirectory,
      repoRoot: workingDirectory,
      runsRoot
    };
    const budget = {
      maxUsd: 1,
      softLimitUsd: 1,
      maxIterations: 1,
      maxTokens: 1000
    };

    try {
      await recordCliWorkflowStep({
        runsRoot,
        step: "doctor",
        workingDirectory,
        receiptScope
      });
      await recordCliWorkflowStep({
        runsRoot,
        step: "estimate",
        workingDirectory,
        objective,
        receiptScope,
        budget
      });
      await recordCliWorkflowStep({
        runsRoot,
        step: "preflight",
        workingDirectory,
        objective,
        engine: "codex",
        verificationPlan: ["npm test"],
        receiptScope,
        allowedPaths: ["packages/**"],
        budget
      });

      const gate = await evaluateCliRunGate({
        runsRoot,
        workingDirectory,
        objective,
        engine: "codex",
        verificationPlan: ["npm run test:ci"],
        receiptScope,
        allowedPaths: ["packages/**"],
        budget
      });

      expect(gate.allowed).toBe(false);
      expect(gate.missingSteps).toContain("preflight");
      expect(gate.nextCommand).toContain("martin-loop preflight");
      expect(gate.message).toContain("verifier or path scope changed");
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });
});

describe("workspace isolation", () => {
  it("two workspaces under the same runsRoot produce different state paths", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-ws-paths-"));
    const workspaceA = join(runsRoot, "repo-a");
    const workspaceB = join(runsRoot, "repo-b");

    try {
      const keyA = testWorkspaceKey(workspaceA);
      const keyB = testWorkspaceKey(workspaceB);
      expect(keyA).not.toBe(keyB);

      const pathA = join(runsRoot, "_martin", "workspaces", keyA, "workflow-state.json");
      const pathB = join(runsRoot, "_martin", "workspaces", keyB, "workflow-state.json");
      expect(pathA).not.toBe(pathB);
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it("receipts from workspace A cannot unlock workspace B", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-ws-cross-"));
    const workspaceA = join(runsRoot, "repo-a");
    const workspaceB = join(runsRoot, "repo-b");
    const objective = "Cross-workspace isolation check";
    const verificationPlan = ["npm test"];
    const receiptScopeA = {
      invocationRoot: workspaceA,
      workingDirectory: workspaceA,
      repoRoot: workspaceA,
      runsRoot
    };

    try {
      // Record all receipts under workspace A
      await recordCliWorkflowStep({ runsRoot, step: "doctor", workingDirectory: workspaceA, receiptScope: receiptScopeA });
      await recordCliWorkflowStep({ runsRoot, step: "estimate", workingDirectory: workspaceA, objective, receiptScope: receiptScopeA });
      await recordCliWorkflowStep({ runsRoot, step: "preflight", workingDirectory: workspaceA, objective, engine: "claude", verificationPlan, receiptScope: receiptScopeA });

      // Gate evaluated for workspace B — must block even though A is fully provisioned
      const gate = await evaluateCliRunGate({
        runsRoot,
        workingDirectory: workspaceB,
        objective,
        engine: "claude",
        verificationPlan
      });

      expect(gate.allowed).toBe(false);
      expect(gate.missingSteps).toContain("doctor");
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it("normalized equivalent paths resolve to the same workspace key", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-ws-normalize-"));
    const base = join(runsRoot, "project");
    const sep = process.platform === "win32" ? "\\" : "/";
    const withTrailingSlash = base + sep;

    try {
      // resolve() strips trailing slashes so both should produce the same key
      expect(testWorkspaceKey(base)).toBe(testWorkspaceKey(withTrailingSlash));
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it("missing workspace state does not fall back to another workspace's state", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-ws-fallback-"));
    const workspaceA = join(runsRoot, "repo-a");
    const workspaceB = join(runsRoot, "repo-b");
    const objective = "Fallback isolation check";
    const verificationPlan = ["npm test"];
    const receiptScopeA = {
      invocationRoot: workspaceA,
      workingDirectory: workspaceA,
      repoRoot: workspaceA,
      runsRoot
    };

    try {
      // Fully populate workspace A
      await recordCliWorkflowStep({ runsRoot, step: "doctor", workingDirectory: workspaceA, receiptScope: receiptScopeA });
      await recordCliWorkflowStep({ runsRoot, step: "estimate", workingDirectory: workspaceA, objective, receiptScope: receiptScopeA });
      await recordCliWorkflowStep({ runsRoot, step: "preflight", workingDirectory: workspaceA, objective, engine: "claude", verificationPlan, receiptScope: receiptScopeA });

      // Workspace B has no state — gate must block, not borrow from A
      const gate = await evaluateCliRunGate({
        runsRoot,
        workingDirectory: workspaceB,
        objective,
        engine: "claude",
        verificationPlan
      });

      expect(gate.allowed).toBe(false);
      expect(gate.missingSteps).toContain("doctor");
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it("atomic write leaves no leftover .tmp file in the workspace directory", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-ws-atomic-"));
    const workingDirectory = join(runsRoot, "project");
    const receiptScope = {
      invocationRoot: workingDirectory,
      workingDirectory,
      repoRoot: workingDirectory,
      runsRoot
    };

    try {
      await recordCliWorkflowStep({ runsRoot, step: "doctor", workingDirectory, receiptScope });

      const workspaceKey = testWorkspaceKey(workingDirectory);
      const wsDir = join(runsRoot, "_martin", "workspaces", workspaceKey);
      const files = await readdir(wsDir);
      const tmpFiles = files.filter((f) => f.endsWith(".tmp"));

      expect(tmpFiles).toHaveLength(0);
      expect(files).toContain("workflow-state.json");
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it("legacy global state does not satisfy the per-workspace gate", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-ws-legacy-"));
    const workingDirectory = join(runsRoot, "project");
    const objective = "Legacy global state test";
    const verificationPlan = ["npm test"];

    try {
      // Simulate legacy global state: write valid-looking receipts to the unscoped
      // global path that pre-fix versions used.  The workspace gate must ignore it.
      const martinDir = join(runsRoot, "_martin");
      await mkdir(martinDir, { recursive: true });
      const legacyStatePath = join(martinDir, "workflow-state.json");
      const now = new Date().toISOString();
      const normalized = process.platform === "win32"
        ? resolve(workingDirectory).toLowerCase()
        : resolve(workingDirectory);
      const legacyState = {
        version: 1,
        cli: {
          doctor: { step: "doctor", recordedAt: now, workingDirectory: normalized },
          estimate: { step: "estimate", recordedAt: now, workingDirectory: normalized },
          preflight: {
            step: "preflight",
            recordedAt: now,
            workingDirectory: normalized,
            verificationPlanKey: "placeholder",
            pathScopeKey: "placeholder"
          }
        }
      };
      await writeFile(legacyStatePath, JSON.stringify(legacyState, null, 2), "utf8");

      // Gate for the workspace — must block, legacy global state is not read by the workspace gate
      const gate = await evaluateCliRunGate({
        runsRoot,
        workingDirectory,
        objective,
        engine: "claude",
        verificationPlan
      });

      expect(gate.allowed).toBe(false);
      expect(gate.missingSteps).toContain("doctor");
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });
});

describe("preflight scope — execution params excluded", () => {
  it("engine change does not invalidate an existing preflight receipt", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-scope-engine-"));
    const workingDirectory = join(runsRoot, "project");
    const objective = "Engine param exclusion check";
    const verificationPlan = ["npm test"];
    const receiptScope = {
      invocationRoot: workingDirectory,
      workingDirectory,
      repoRoot: workingDirectory,
      runsRoot
    };

    try {
      await recordCliWorkflowStep({ runsRoot, step: "doctor", workingDirectory, receiptScope });
      await recordCliWorkflowStep({ runsRoot, step: "estimate", workingDirectory, objective, receiptScope });
      // Record preflight with engine "claude"
      await recordCliWorkflowStep({
        runsRoot,
        step: "preflight",
        workingDirectory,
        objective,
        engine: "claude",
        verificationPlan,
        receiptScope
      });

      // Evaluate gate with a different engine — preflight must still be valid
      const gate = await evaluateCliRunGate({
        runsRoot,
        workingDirectory,
        objective,
        engine: "codex",
        verificationPlan,
        receiptScope
      });

      expect(gate.allowed).toBe(true);
      expect(gate.missingSteps).toEqual([]);
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it("budget change does not invalidate an existing preflight receipt", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-scope-budget-"));
    const workingDirectory = join(runsRoot, "project");
    const objective = "Budget param exclusion check";
    const verificationPlan = ["npm test"];
    const receiptScope = {
      invocationRoot: workingDirectory,
      workingDirectory,
      repoRoot: workingDirectory,
      runsRoot
    };
    const preflightBudget = { maxUsd: 2, softLimitUsd: 2, maxIterations: 5, maxTokens: 10_000 };
    const runBudget = { maxUsd: 2, softLimitUsd: 1.5, maxIterations: 20, maxTokens: 50_000 };

    try {
      await recordCliWorkflowStep({ runsRoot, step: "doctor", workingDirectory, receiptScope });
      await recordCliWorkflowStep({
        runsRoot,
        step: "estimate",
        workingDirectory,
        objective,
        receiptScope,
        budget: runBudget
      });
      // Record preflight with one budget
      await recordCliWorkflowStep({
        runsRoot,
        step: "preflight",
        workingDirectory,
        objective,
        engine: "claude",
        verificationPlan,
        receiptScope,
        budget: preflightBudget
      });

      // Evaluate gate with a different budget — preflight must still be valid
      const gate = await evaluateCliRunGate({
        runsRoot,
        workingDirectory,
        objective,
        engine: "claude",
        verificationPlan,
        receiptScope,
        budget: runBudget
      });

      expect(gate.allowed).toBe(true);
      expect(gate.missingSteps).toEqual([]);
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it("verifier command change requires a fresh preflight", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-scope-verifier-"));
    const workingDirectory = join(runsRoot, "project");
    const objective = "Verifier scope enforcement check";
    const receiptScope = {
      invocationRoot: workingDirectory,
      workingDirectory,
      repoRoot: workingDirectory,
      runsRoot
    };

    try {
      await recordCliWorkflowStep({ runsRoot, step: "doctor", workingDirectory, receiptScope });
      await recordCliWorkflowStep({ runsRoot, step: "estimate", workingDirectory, objective, receiptScope });
      await recordCliWorkflowStep({
        runsRoot,
        step: "preflight",
        workingDirectory,
        objective,
        engine: "claude",
        verificationPlan: ["npm test"],
        receiptScope
      });

      const gate = await evaluateCliRunGate({
        runsRoot,
        workingDirectory,
        objective,
        engine: "claude",
        verificationPlan: ["bun test"],
        receiptScope
      });

      expect(gate.allowed).toBe(false);
      expect(gate.missingSteps).toContain("preflight");
      expect(gate.message).toContain("verifier or path scope changed");
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it("path scope change requires a fresh preflight", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-scope-path-"));
    const workingDirectory = join(runsRoot, "project");
    const objective = "Path scope enforcement check";
    const verificationPlan = ["npm test"];
    const receiptScope = {
      invocationRoot: workingDirectory,
      workingDirectory,
      repoRoot: workingDirectory,
      runsRoot
    };

    try {
      await recordCliWorkflowStep({ runsRoot, step: "doctor", workingDirectory, receiptScope });
      await recordCliWorkflowStep({ runsRoot, step: "estimate", workingDirectory, objective, receiptScope });
      await recordCliWorkflowStep({
        runsRoot,
        step: "preflight",
        workingDirectory,
        objective,
        engine: "claude",
        verificationPlan,
        receiptScope,
        allowedPaths: ["src/**"]
      });

      const gate = await evaluateCliRunGate({
        runsRoot,
        workingDirectory,
        objective,
        engine: "claude",
        verificationPlan,
        receiptScope,
        allowedPaths: ["tests/**"]
      });

      expect(gate.allowed).toBe(false);
      expect(gate.missingSteps).toContain("preflight");
      expect(gate.message).toContain("verifier or path scope changed");
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });
});
