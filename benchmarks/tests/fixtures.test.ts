import { describe, expect, it } from "vitest";

import {
  getBuiltInFixturePath,
  listBuiltInSuites,
  loadBenchmarkSuiteFixture
} from "../src/index.js";

describe("loadBenchmarkSuiteFixture", () => {
  it("loads the built-in ralphy smoke suite and normalizes budget defaults", async () => {
    const suite = await loadBenchmarkSuiteFixture("ralphy-smoke");

    expect(suite.suiteId).toBe("ralphy-smoke");
    expect(suite.baselineAdapter).toBe("ralphy");
    expect(suite.cases.length).toBeGreaterThan(0);
    expect(suite.cases[0]?.budget.maxIterations).toBeGreaterThan(0);
    expect(suite.cases[0]?.task.verificationPlan.length).toBeGreaterThan(0);
    expect(getBuiltInFixturePath("ralphy-smoke")).toMatch(/ralphy-smoke\.json$/);
  });
});

describe("listBuiltInSuites", () => {
  it("returns built-in suite manifests for CLI discovery", async () => {
    const suites = await listBuiltInSuites();

    expect(suites.map((suite) => suite.suiteId)).toContain("ralphy-smoke");
    expect(suites.map((suite) => suite.suiteId)).toContain("phase7-variants");
  });
});
