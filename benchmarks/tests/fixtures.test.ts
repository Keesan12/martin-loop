import { describe, expect, it } from "vitest";

import { loadBenchmarkSuiteFixture } from "../src/index.js";

describe("benchmark fixtures", () => {
  it("loads public benchmark suites by safe id", async () => {
    await expect(loadBenchmarkSuiteFixture("under-3-challenge")).resolves.toMatchObject({
      suiteId: "under-3-challenge"
    });
  });

  it("rejects suite ids that could escape the fixtures directory", async () => {
    await expect(loadBenchmarkSuiteFixture("../secrets")).rejects.toThrow("Invalid suite ID");
    await expect(loadBenchmarkSuiteFixture("..\\secrets")).rejects.toThrow("Invalid suite ID");
  });
});
