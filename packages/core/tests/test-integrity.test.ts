/**
 * Test Integrity Validator — real tests.
 *
 * Validates that the circular test detection system correctly identifies:
 * - Trivial assertions (expect(true).toBe(true))
 * - Tests that don't import pre-existing code
 * - Empty test files
 * - Real tests that exercise pre-existing functions
 */

import { describe, expect, it } from "vitest";

import {
  isTestFile,
  extractImports,
  hasTrivialAssertionsOnly,
  importsPreExistingCode,
  validateTestIntegrity,
  snapshotTestFiles,
  identifyNewTests
} from "../src/test-integrity.js";

describe("isTestFile", () => {
  it("matches .test.ts files", () => {
    expect(isTestFile("auth.test.ts")).toBe(true);
    expect(isTestFile("auth.test.tsx")).toBe(true);
    expect(isTestFile("auth.test.js")).toBe(true);
  });

  it("matches .spec.ts files", () => {
    expect(isTestFile("auth.spec.ts")).toBe(true);
  });

  it("matches files in __tests__ directories", () => {
    expect(isTestFile("Auth.tsx", "src/__tests__/Auth.tsx")).toBe(true);
  });

  it("rejects non-test files", () => {
    expect(isTestFile("auth.ts")).toBe(false);
    expect(isTestFile("utils.js")).toBe(false);
    expect(isTestFile("index.tsx")).toBe(false);
  });
});

describe("extractImports", () => {
  it("extracts ES module imports", () => {
    const code = `
      import { foo } from "../src/foo.js";
      import bar from "bar";
    `;
    const imports = extractImports(code);
    expect(imports).toContain("../src/foo.js");
    expect(imports).toContain("bar");
  });

  it("extracts require calls", () => {
    const code = `const x = require("../utils");`;
    const imports = extractImports(code);
    expect(imports).toContain("../utils");
  });

  it("returns empty array for files with no imports", () => {
    const code = `const x = 1;\nconsole.log(x);`;
    expect(extractImports(code)).toEqual([]);
  });
});

describe("hasTrivialAssertionsOnly", () => {
  it("detects expect(true).toBe(true) as trivial", () => {
    const code = `
      test("passes", () => {
        expect(true).toBe(true);
      });
    `;
    expect(hasTrivialAssertionsOnly(code)).toBe(true);
  });

  it("detects expect(1).toBe(1) as trivial", () => {
    const code = `test("math", () => { expect(1).toBe(1); });`;
    expect(hasTrivialAssertionsOnly(code)).toBe(true);
  });

  it("does not flag real assertions as trivial", () => {
    const code = `
      test("calculates total", () => {
        const result = calculateTotal([10, 20, 30]);
        expect(result).toBe(60);
      });
    `;
    expect(hasTrivialAssertionsOnly(code)).toBe(false);
  });

  it("flags files with no assertions at all", () => {
    const code = `test("empty", () => {});`;
    expect(hasTrivialAssertionsOnly(code)).toBe(true);
  });
});

describe("importsPreExistingCode", () => {
  it("returns true when test imports a pre-existing source file", () => {
    const content = `import { classify } from "../src/routing.js";`;
    const preExisting = new Set(["src/routing.ts"]);
    expect(importsPreExistingCode(content, preExisting)).toBe(true);
  });

  it("returns true when test imports an npm package", () => {
    const content = `import { describe } from "vitest";`;
    const preExisting = new Set<string>();
    expect(importsPreExistingCode(content, preExisting)).toBe(true);
  });

  it("returns false when test only has relative imports to non-existing files", () => {
    const content = `import { helper } from "./my-new-helper.js";`;
    const preExisting = new Set(["src/routing.ts", "src/policy.ts"]);
    expect(importsPreExistingCode(content, preExisting)).toBe(false);
  });
});

describe("validateTestIntegrity", () => {
  it("returns pass verdict when snapshot matches current state", () => {
    // Snapshot current test files, then validate — no new tests should appear
    const cwd = process.cwd();
    const preSnapshot = snapshotTestFiles(cwd);
    const preSource = new Set(["src/index.ts"]);
    const report = validateTestIntegrity(cwd, preSnapshot, preSource);
    expect(report.verdict).toBe("pass");
    expect(report.totalNewTests).toBe(0);
  });
});
