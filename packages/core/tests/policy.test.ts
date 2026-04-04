import { describe, expect, it } from "vitest";

import {
  computeEvidenceVector,
  evaluateBudgetPreflight,
  evaluatePatchDecision,
  selectRecoveryRecipe
} from "../src/index.js";

describe("evaluateBudgetPreflight", () => {
  it("allows attempt when estimated cost is within budget and per-attempt cap", () => {
    const decision = evaluateBudgetPreflight({
      promptCharCount: 2000,
      attemptCount: 0,
      remainingBudgetUsd: 10.0
    });

    expect(decision.allowed).toBe(true);
    expect(decision.estimate.provenance).toBe("estimated");
    expect(decision.estimate.estimatedAttemptCostUsd).toBeGreaterThan(0);
  });

  it("rejects attempt when estimated cost exceeds remaining budget", () => {
    const decision = evaluateBudgetPreflight({
      promptCharCount: 500,
      attemptCount: 0,
      remainingBudgetUsd: 0.001
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("remaining budget");
  });

  it("rejects attempt when estimated cost exceeds explicit per-attempt cap", () => {
    const decision = evaluateBudgetPreflight({
      promptCharCount: 800_000,
      attemptCount: 0,
      remainingBudgetUsd: 100.0,
      perAttemptCapUsd: 0.001
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("per-attempt cap");
  });

  it("estimate always carries provenance: estimated", () => {
    const decision = evaluateBudgetPreflight({
      promptCharCount: 1000,
      attemptCount: 1,
      remainingBudgetUsd: 5.0
    });

    expect(decision.estimate.provenance).toBe("estimated");
  });
});

describe("computeEvidenceVector", () => {
  it("extracts compile errors and type errors from compiler output", () => {
    const evidence = computeEvidenceVector({
      compilerOutput:
        "error TS2345: Argument of type 'string' is not assignable.\nerror TS2554: Expected 2 arguments, but got 1."
    });

    expect(evidence.compileErrors).toBeGreaterThanOrEqual(2);
    expect(evidence.typeErrors).toBeGreaterThanOrEqual(2);
  });

  it("computes low diffNovelty when current and previous diff are nearly identical", () => {
    const diff = `--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;`;

    const evidence = computeEvidenceVector({
      diff,
      previousDiff: diff
    });

    expect(evidence.diffNovelty).toBeLessThan(0.2);
  });

  it("returns full novelty when there is no previous diff", () => {
    const evidence = computeEvidenceVector({
      diff: `--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 99;`
    });

    expect(evidence.diffNovelty).toBe(1.0);
  });

  it("flags forbidden touched files in safetyRiskScore", () => {
    const evidence = computeEvidenceVector({
      forbiddenTouchedFiles: ["apps/dashboard/page.tsx", "apps/billing/route.ts", ".env"]
    });

    expect(evidence.forbiddenTouchedFileCount).toBe(3);
    expect(evidence.safetyRiskScore).toBeGreaterThan(0);
  });
});

describe("selectRecoveryRecipe", () => {
  it("recommends force_repo_anatomy_slices for missing symbols on first retry", () => {
    const evidence = computeEvidenceVector({
      missingSymbols: ["ghost-function", "phantom-module"]
    });

    const decision = selectRecoveryRecipe(evidence);

    expect(decision.recipe).toBe("force_repo_anatomy_slices");
    expect(decision.intervention).toBe("run_verifier");
  });

  it("recommends narrow_prompt_targeted_files for compile errors", () => {
    const evidence = computeEvidenceVector({
      compilerOutput: "error TS2345: type mismatch.\nerror TS2304: Cannot find name 'foo'."
    });

    const decision = selectRecoveryRecipe(evidence);

    expect(decision.recipe).toBe("narrow_prompt_targeted_files");
    expect(decision.intervention).toBe("compress_context");
  });

  it("recommends strategy_swap for very low novelty after multiple retries", () => {
    const diff = `--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;`;

    const evidence = computeEvidenceVector({
      diff,
      previousDiff: diff,
      retryCountForSurface: 3
    });

    const decision = selectRecoveryRecipe(evidence);

    expect(decision.recipe).toBe("strategy_swap");
    expect(decision.intervention).toBe("change_model");
  });

  it("recommends abort_safety_violation when safetyRiskScore is high", () => {
    const evidence = computeEvidenceVector({
      forbiddenTouchedFiles: ["apps/x.ts", "apps/y.ts", "apps/z.ts", ".env", "secrets.json"]
    });

    const decision = selectRecoveryRecipe(evidence);

    expect(decision.recipe).toBe("abort_safety_violation");
    expect(decision.intervention).toBe("escalate_human");
  });
});

describe("evaluatePatchDecision", () => {
  it("challenge 14: discards a verifier-passing patch when the wrong files changed", () => {
    const decision = evaluatePatchDecision({
      verificationPassed: true,
      previousVerifierScore: 0.2,
      verifierScore: 1,
      scopeViolationCount: 1,
      changedFileCount: 2,
      diffNovelty: 0.8,
      diffStats: {
        filesChanged: 2,
        addedLines: 20,
        deletedLines: 5
      },
      costUsd: 0.3
    });

    expect(decision.decision).toBe("DISCARD");
    expect(decision.reasonCodes).toContain("scope_violation");
  });

  it("challenge 15: discards a patch when verifier score regresses", () => {
    const decision = evaluatePatchDecision({
      verificationPassed: false,
      previousVerifierScore: 0.9,
      verifierScore: 0.2,
      changedFileCount: 1,
      diffNovelty: 0.6,
      diffStats: {
        filesChanged: 1,
        addedLines: 8,
        deletedLines: 3
      },
      costUsd: 0.25
    });

    expect(decision.decision).toBe("DISCARD");
    expect(decision.reasonCodes).toContain("verifier_regressed");
  });

  it("challenge 16: discards a verbose attempt that changed no code", () => {
    const decision = evaluatePatchDecision({
      verificationPassed: false,
      previousVerifierScore: 0,
      verifierScore: 0,
      changedFileCount: 0,
      diffNovelty: 0,
      diffStats: {
        filesChanged: 0,
        addedLines: 0,
        deletedLines: 0
      },
      summary:
        "I carefully reviewed the issue, reasoned through the execution path, and documented a detailed plan without making any concrete code changes.",
      costUsd: 0.18
    });

    expect(decision.decision).toBe("DISCARD");
    expect(decision.reasonCodes).toContain("no_code_change");
  });

  it("challenge 17: discards a large diff when verifier score does not improve", () => {
    const decision = evaluatePatchDecision({
      verificationPassed: false,
      previousVerifierScore: 0.4,
      verifierScore: 0.4,
      changedFileCount: 7,
      diffNovelty: 0.7,
      diffStats: {
        filesChanged: 7,
        addedLines: 220,
        deletedLines: 40
      },
      costUsd: 0.62
    });

    expect(decision.decision).toBe("DISCARD");
    expect(decision.reasonCodes).toContain("large_diff_no_improvement");
  });
});
