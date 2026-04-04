import { describe, expect, it } from "vitest";

import {
  createDeterministicComparisonRunner,
  loadBenchmarkSuiteFixture,
  runBenchmarkSuite
} from "../src/index.js";

describe("createDeterministicComparisonRunner", () => {
  it("proves Martin spends less and verifies the flaky-CI repair before Ralph-style retries spiral", async () => {
    const suite = await loadBenchmarkSuiteFixture("ralphy-smoke");
    const report = await runBenchmarkSuite(suite, createDeterministicComparisonRunner());
    const repairCase = report.results.find((result) => result.caseId === "repair-ci");

    expect(repairCase?.status).toBe("passed");
    expect(repairCase?.comparison).toEqual({
      baseline: {
        adapterId: "ralphy",
        attempts: 5,
        spendUsd: 8.4,
        result: "not_verified"
      },
      martin: {
        adapterId: "martin",
        attempts: 2,
        spendUsd: 2.3,
        result: "verified_pass"
      }
    });
    expect(repairCase?.loop?.status).toBe("completed");
    expect(repairCase?.loop?.lifecycleState).toBe("completed");
    expect(repairCase?.loop?.cost.actualUsd).toBe(2.3);
    expect(repairCase?.notes).toContain("Martin verified the repair before the Ralph-style baseline burned through its budget.");
  });

  it("proves Martin exits the budget-pressure regression early while the Ralph-style baseline keeps looping", async () => {
    const suite = await loadBenchmarkSuiteFixture("ralphy-smoke");
    const report = await runBenchmarkSuite(suite, createDeterministicComparisonRunner());
    const budgetCase = report.results.find((result) => result.caseId === "budget-guard");

    expect(budgetCase?.status).toBe("passed");
    expect(budgetCase?.comparison).toEqual({
      baseline: {
        adapterId: "ralphy",
        attempts: 4,
        spendUsd: 7.2,
        result: "looped"
      },
      martin: {
        adapterId: "martin",
        attempts: 2,
        spendUsd: 3,
        result: "budget_exit"
      }
    });
    expect(budgetCase?.loop?.status).toBe("exited");
    expect(budgetCase?.loop?.lifecycleState).toBe("budget_exit");
    expect(budgetCase?.notes).toContain("Martin stopped when the economics stopped being credible.");
  });
});
