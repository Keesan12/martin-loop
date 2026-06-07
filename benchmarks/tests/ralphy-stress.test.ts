import { describe, expect, it } from "vitest";

import {
  generateRalphyEngineeringStressReport,
  loadBenchmarkSuiteFixture,
  renderRalphyEngineeringStressMarkdown
} from "../src/index.js";

describe("generateRalphyEngineeringStressReport", () => {
  it("loads a first-class 50-case Ralph-style engineering loop suite", async () => {
    const suite = await loadBenchmarkSuiteFixture("ralphy-engineering-50");

    expect(suite.suiteId).toBe("ralphy-engineering-50");
    expect(suite.baselineAdapter).toBe("ralphy");
    expect(suite.cases).toHaveLength(50);
    expect(new Set(suite.cases.map((benchmarkCase) => benchmarkCase.caseId)).size).toBe(50);
    expect(
      suite.cases.every((benchmarkCase) => benchmarkCase.task.verificationPlan.length > 0)
    ).toBe(true);
  });

  it("produces a deterministic stress report with no stub cases and an explicit pass/fail distribution", async () => {
    const report = await generateRalphyEngineeringStressReport();

    expect(report.suite.suiteId).toBe("ralphy-engineering-50");
    expect(report.suite.summary.totalCases).toBe(50);
    expect(report.suite.summary.stubCases).toBe(0);
    expect(report.suite.summary.passedCases).toBe(50);
    expect(report.suite.summary.failedCases).toBe(0);
    expect(report.suite.summary.passRate).toBe(100);
    expect(report.focusAreas.length).toBeGreaterThanOrEqual(10);
    expect(report.weakSpots).toHaveLength(0);
    expect(report.summary.some((line) => line.includes("50 of 50"))).toBe(true);
  });

  it("renders markdown that surfaces overall performance and weakest scenarios", async () => {
    const report = await generateRalphyEngineeringStressReport();
    const markdown = renderRalphyEngineeringStressMarkdown(report);

    expect(markdown).toContain("# Ralph Loop Stress Report");
    expect(markdown).toContain("50 passed");
    expect(markdown).toContain("0 failed");
    expect(markdown).toContain("Weak spots");
  });

  it("reuses a single generated timestamp across the suite report and top-level metadata", async () => {
    let tick = 0;
    const report = await generateRalphyEngineeringStressReport({
      now: () => `2026-06-07T00:00:0${tick += 1}.000Z`
    });

    expect(report.generatedAt).toBe("2026-06-07T00:00:01.000Z");
    expect(report.suite.generatedAt).toBe(report.generatedAt);
  });
});
