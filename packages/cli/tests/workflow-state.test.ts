import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateCliRunGate, recordCliWorkflowStep } from "../src/workflow-state.js";

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
        receiptScope
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
});
