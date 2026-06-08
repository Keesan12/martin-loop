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
});
