import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  sanitizeToolErrorMessage,
  validateToolInput
} from "../src/server-validation.js";

async function withValidationRunsRoot<T>(fn: (runsRoot: string) => Promise<T>): Promise<T> {
  const previousRunsRoot = process.env.MARTIN_RUNS_DIR;
  const runsRoot = await mkdtemp(join(tmpdir(), "martin-mcp-validation-runs-"));
  process.env.MARTIN_RUNS_DIR = runsRoot;

  try {
    return await fn(runsRoot);
  } finally {
    if (previousRunsRoot === undefined) {
      delete process.env.MARTIN_RUNS_DIR;
    } else {
      process.env.MARTIN_RUNS_DIR = previousRunsRoot;
    }

    await rm(runsRoot, { recursive: true, force: true }).catch(() => {});
  }
}

describe("server validation", () => {
  it("rejects hidden martin_run fields that are not part of the public schema", () => {
    expect(() =>
      validateToolInput("martin_run", {
        objective: "Fix the bug",
        parentRunId: "../escape"
      })
    ).toThrow("Unknown arguments");
  });

  it("rejects absolute and parent-traversing path patterns", () => {
    expect(() =>
      validateToolInput("martin_run", {
        objective: "Fix the bug",
        allowedPaths: ["../outside/**"]
      })
    ).toThrow("Invalid allowedPaths.");

    expect(() =>
      validateToolInput("martin_run", {
        objective: "Fix the bug",
        deniedPaths: ["C:/secret/**"]
      })
    ).toThrow("Invalid deniedPaths.");
  });

  it("rejects inspect paths that escape the Martin run store", () => {
    return withValidationRunsRoot(async () => {
      expect(() =>
        validateToolInput("martin_inspect", {
          file: "..\\..\\outside.jsonl"
        })
      ).toThrow("Invalid file.");
    });
  });

  it("allows inspect paths under the configured Martin run store", async () => {
    await withValidationRunsRoot(async (runsRoot) => {
      await mkdir(join(runsRoot, "loop_001"), { recursive: true });
      await writeFile(join(runsRoot, "loop_001", "loop-record.json"), "{}", "utf8");

      const result = validateToolInput("martin_inspect", {
        file: "loop_001/loop-record.json"
      });

      expect(result).toEqual({
        file: join(runsRoot, "loop_001", "loop-record.json")
      });
    });
  });

  it("allows inspect to target the run-store root explicitly", () => {
    return withValidationRunsRoot(async (runsRoot) => {
      const result = validateToolInput("martin_inspect", {
        runsDir: "."
      });

      expect(result).toEqual({
        runsDir: runsRoot
      });
    });
  });

  it("rejects ambiguous martin_status selectors", () => {
    expect(() =>
      validateToolInput("martin_status", {
        loopJson: "{}",
        latest: true
      })
    ).toThrow("Provide exactly one");
  });

  it("requires integer values for maxIterations and maxTokens", () => {
    expect(() =>
      validateToolInput("martin_run", {
        objective: "Fix the bug",
        maxIterations: 1.5
      })
    ).toThrow("Invalid maxIterations.");

    expect(() =>
      validateToolInput("martin_run", {
        objective: "Fix the bug",
        maxTokens: 1000.25
      })
    ).toThrow("Invalid maxTokens.");
  });

  it("accepts loopId and latest selectors for martin_status", () => {
    expect(
      validateToolInput("martin_status", {
        loopId: "loop_123"
      })
    ).toEqual({
      loopId: "loop_123"
    });

    expect(
      validateToolInput("martin_status", {
        latest: true
      })
    ).toEqual({
      latest: true
    });
  });

  it("scrubs filesystem paths from reflected tool errors", () => {
    expect(
      sanitizeToolErrorMessage(
        new Error("Failed to load C:\\secret\\repo\\.martin\\policy.rego")
      )
    ).toBe("Tool execution failed.");
  });

  it("keeps MCP public tool schemas aligned with validation constraints", async () => {
    const testsDir = dirname(fileURLToPath(import.meta.url));
    const serverSource = await readFile(join(testsDir, "../src/server.ts"), "utf8");
    const normalizedServerSource = serverSource.replace(/\r\n/g, "\n");

    expect(normalizedServerSource).toContain('import { createRequire } from "node:module"');
    expect(normalizedServerSource).toContain("const require = createRequire(import.meta.url);");
    expect(normalizedServerSource).toContain('const packageJson = require("../package.json") as { version: string };');
    expect(normalizedServerSource).toContain('{ name: "martin-loop", version: packageJson.version }');
    expect(normalizedServerSource).toContain("additionalProperties: false");
    expect(normalizedServerSource).toMatch(/maxIterations:\s*\{\s*type: "integer"/);
    expect(normalizedServerSource).toMatch(/maxTokens:\s*\{\s*type: "integer"/);
    expect(normalizedServerSource).toMatch(/latest:\s*\{\s*const: true/);
    expect(normalizedServerSource).toContain("oneOf: [");
    expect(normalizedServerSource).toContain('{ required: ["loopJson"] }');
    expect(normalizedServerSource).toContain('{ required: ["file"] }');
    expect(normalizedServerSource).toContain('{ required: ["loopId"] }');
    expect(normalizedServerSource).toContain('{ required: ["latest"] }');
  });
});
