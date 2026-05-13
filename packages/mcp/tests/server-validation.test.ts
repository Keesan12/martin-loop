import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  sanitizeToolErrorMessage,
  validateToolInput
} from "../src/server-validation.js";

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
    const previousRunsRoot = process.env.MARTIN_RUNS_DIR;
    process.env.MARTIN_RUNS_DIR = join(tmpdir(), `martin-mcp-validation-runs-${Date.now()}`);
    try {
      expect(() =>
        validateToolInput("martin_inspect", {
          file: "..\\..\\outside.jsonl"
        })
      ).toThrow("Invalid file.");
    } finally {
      if (previousRunsRoot === undefined) {
        delete process.env.MARTIN_RUNS_DIR;
      } else {
        process.env.MARTIN_RUNS_DIR = previousRunsRoot;
      }
    }
  });

  it("allows inspect paths under the configured Martin run store", async () => {
    const previousRunsRoot = process.env.MARTIN_RUNS_DIR;
    const runsRoot = join(tmpdir(), `martin-mcp-validation-runs-${Date.now()}`);
    process.env.MARTIN_RUNS_DIR = runsRoot;
    await mkdir(join(runsRoot, "loop_001"), { recursive: true });
    await writeFile(join(runsRoot, "loop_001", "loop-record.json"), "{}", "utf8");

    try {
      const result = validateToolInput("martin_inspect", {
        file: "loop_001/loop-record.json"
      });

      expect(result).toEqual({
        file: join(runsRoot, "loop_001", "loop-record.json")
      });
    } finally {
      if (previousRunsRoot === undefined) {
        delete process.env.MARTIN_RUNS_DIR;
      } else {
        process.env.MARTIN_RUNS_DIR = previousRunsRoot;
      }
    }
  });

  it("allows inspect to target the run-store root explicitly", () => {
    const previousRunsRoot = process.env.MARTIN_RUNS_DIR;
    const runsRoot = join(tmpdir(), `martin-mcp-validation-runs-${Date.now()}`);
    process.env.MARTIN_RUNS_DIR = runsRoot;

    try {
      const result = validateToolInput("martin_inspect", {
        runsDir: "."
      });

      expect(result).toEqual({
        runsDir: runsRoot
      });
    } finally {
      if (previousRunsRoot === undefined) {
        delete process.env.MARTIN_RUNS_DIR;
      } else {
        process.env.MARTIN_RUNS_DIR = previousRunsRoot;
      }
    }
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

    expect(serverSource).toContain('import { createRequire } from "node:module"');
    expect(serverSource).toContain("const require = createRequire(import.meta.url);");
    expect(serverSource).toContain('const packageJson = require("../package.json") as { version: string };');
    expect(serverSource).toContain('{ name: "martin-loop", version: packageJson.version }');
    expect(serverSource).toContain("additionalProperties: false");
    expect(serverSource).toContain('maxIterations: {\n            type: "integer"');
    expect(serverSource).toContain('maxTokens: {\n            type: "integer"');
    expect(serverSource).toContain('latest: {\n            const: true');
    expect(serverSource).toContain("oneOf: [");
    expect(serverSource).toContain('{ required: ["loopJson"] }');
    expect(serverSource).toContain('{ required: ["file"] }');
    expect(serverSource).toContain('{ required: ["loopId"] }');
    expect(serverSource).toContain('{ required: ["latest"] }');
  });
});
