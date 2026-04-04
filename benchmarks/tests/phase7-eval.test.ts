import { describe, expect, it } from "vitest";

import {
  generateGoNoGoReport,
  measureBudgetEstimateVariance,
  renderGoNoGoReportMarkdown,
  runBenchmarkVariantMatrix,
  runFailureReplaySuite,
  runSafetyIncidentDrills
} from "../src/index.js";

describe("Phase 7 evaluation harness", () => {
  it("runs the A/B/C benchmark matrix and shows v4 outperforming the baseline", async () => {
    const matrix = await runBenchmarkVariantMatrix();

    expect(matrix.variantResults.map((result) => result.variantId)).toEqual(["A", "B", "C"]);
    expect(matrix.summary.totalVariants).toBe(3);
    expect(matrix.summary.passedVariants).toBe(3);
    expect(matrix.summary.martinSpendUsd).toBeLessThan(matrix.summary.baselineSpendUsd);
  });

  it("replays the required failure-handling scenarios with expected lifecycles", async () => {
    const replay = await runFailureReplaySuite();

    expect(replay.cases.map((scenario) => scenario.caseId)).toEqual([
      "type-error-replay",
      "oscillation-trap",
      "scope-enforcement"
    ]);
    expect(replay.cases.every((scenario) => scenario.status === "passed")).toBe(true);
    expect(replay.cases.find((scenario) => scenario.caseId === "type-error-replay")?.actualLifecycle).toBe(
      "completed"
    );
    expect(replay.cases.find((scenario) => scenario.caseId === "oscillation-trap")?.actualLifecycle).toBe(
      "diminishing_returns"
    );
    expect(replay.cases.find((scenario) => scenario.caseId === "scope-enforcement")?.actualLifecycle).toBe(
      "human_escalation"
    );
  });

  it("runs the safety drills and blocks both forbidden commands and out-of-scope touches", async () => {
    const drills = await runSafetyIncidentDrills();

    expect(drills.drills.map((scenario) => scenario.caseId)).toEqual([
      "forbidden-command",
      "out-of-scope-touch"
    ]);
    expect(drills.blockedCount).toBe(2);
    expect(drills.drills.every((scenario) => scenario.actualLifecycle === "human_escalation")).toBe(true);
  });

  it("measures budget estimate variance across at least twenty-one runs", async () => {
    const variance = await measureBudgetEstimateVariance({ sampleSize: 21 });

    expect(variance.sampleSize).toBeGreaterThanOrEqual(21);
    expect(variance.runs).toHaveLength(21);
    expect(variance.runs.every((run) => typeof run.varianceUsd === "number")).toBe(true);
    expect(variance.averageAbsVarianceUsd).toBeGreaterThan(0);
    expect(variance.maxAbsVarianceUsd).toBeGreaterThanOrEqual(variance.averageAbsVarianceUsd);
  });

  it("produces a go/no-go report suitable for CTO sign-off", async () => {
    const report = await generateGoNoGoReport();
    const markdown = renderGoNoGoReportMarkdown(report);

    expect(report.verdict).toBe("go");
    expect(markdown).toContain("# Martin Loop v4 Phase 7 Go/No-Go Report");
    expect(markdown).toContain("CTO Sign-Off Recommendation");
    expect(markdown).toContain("GO");
  });
});
