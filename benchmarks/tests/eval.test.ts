import { describe, expect, it } from "vitest";

import { readSuiteId } from "../src/eval.js";

describe("benchmark eval CLI", () => {
  it("defaults to the public under-3 suite when no explicit selector is provided", () => {
    expect(readSuiteId([])).toBe("under-3-challenge");
  });

  it("reads an explicit suite id", () => {
    expect(readSuiteId(["--suite", "ralphy-engineering-50"])).toBe("ralphy-engineering-50");
    expect(readSuiteId(["--suite=ralphy-engineering-50"])).toBe("ralphy-engineering-50");
  });

  it("fails closed when --suite is missing its value", () => {
    expect(() => readSuiteId(["--suite"])).toThrow("Missing value for --suite.");
    expect(() => readSuiteId(["--suite", "--other-flag"])).toThrow("Missing value for --suite.");
    expect(() => readSuiteId(["--suite="])).toThrow("Missing value for --suite.");
  });
});
