import { symlink, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MARTIN_PROMPT_NAMES,
  MARTIN_RESOURCE_TEMPLATE_URIS,
  MARTIN_RESOURCE_URIS,
  MARTIN_STARTER_TOOL_NAMES,
  MARTIN_TOOL_NAMES
} from "../src/discovery-metadata.js";
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

async function withValidationWorkspaceRoot<T>(fn: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const previousWorkspaceRoot = process.env.MARTIN_MCP_WORKSPACE_ROOT;
  const workspaceRoot = await mkdtemp(join(tmpdir(), "martin-mcp-validation-workspace-"));
  process.env.MARTIN_MCP_WORKSPACE_ROOT = workspaceRoot;

  try {
    return await fn(workspaceRoot);
  } finally {
    if (previousWorkspaceRoot === undefined) {
      delete process.env.MARTIN_MCP_WORKSPACE_ROOT;
    } else {
      process.env.MARTIN_MCP_WORKSPACE_ROOT = previousWorkspaceRoot;
    }

    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
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

  it("rejects run-store paths that resolve through a junction or symlink outside the configured root", async () => {
    await withValidationRunsRoot(async (runsRoot) => {
      const outsideRoot = await mkdtemp(join(tmpdir(), "martin-mcp-validation-outside-"));
      const outsideLoopRoot = join(outsideRoot, "loop_escape");
      const linkedRoot = join(runsRoot, "runs_link");
      await mkdir(outsideLoopRoot, { recursive: true });
      await writeFile(join(outsideLoopRoot, "loop-record.json"), "{}", "utf8");
      await symlink(outsideRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");

      try {
        expect(() =>
          validateToolInput("martin_inspect", {
            file: "runs_link/loop_escape/loop-record.json"
          })
        ).toThrow("Invalid file.");
      } finally {
        await rm(outsideRoot, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  it("rejects working directories that traverse through a symlinked workspace segment", async () => {
    await withValidationWorkspaceRoot(async (workspaceRoot) => {
      const outsideRoot = await mkdtemp(join(tmpdir(), "martin-mcp-validation-outside-workspace-"));
      const linkedRoot = join(workspaceRoot, "workspace_link");
      await mkdir(join(outsideRoot, "repo"), { recursive: true });
      await symlink(outsideRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");

      try {
        expect(() =>
          validateToolInput("martin_run", {
            objective: "Fix the bug",
            workingDirectory: "workspace_link/repo"
          })
        ).toThrow("Invalid workingDirectory.");
      } finally {
        await rm(outsideRoot, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  it("resolves file selectors relative to an explicit narrowed runsDir", async () => {
    await withValidationRunsRoot(async (runsRoot) => {
      const narrowedRunsRoot = join(runsRoot, "team-a");
      await mkdir(join(narrowedRunsRoot, "loop_001"), { recursive: true });
      await writeFile(join(narrowedRunsRoot, "loop_001", "loop-record.json"), "{}", "utf8");

      const result = validateToolInput("martin_inspect", {
        runsDir: "team-a",
        file: "loop_001/loop-record.json"
      });

      expect(result).toEqual({
        runsDir: narrowedRunsRoot,
        file: join(narrowedRunsRoot, "loop_001", "loop-record.json")
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

  it("validates doctor and preflight public tool shapes", () => {
    expect(
      validateToolInput("martin_doctor", {
        engine: "codex"
      })
    ).toEqual({
      engine: "codex"
    });

    expect(
      validateToolInput("martin_preflight", {
        objective: "Fix the bug",
        allowedPaths: ["src/**"]
      })
    ).toEqual({
      objective: "Fix the bug",
      allowedPaths: ["src/**"]
    });

    expect(
      validateToolInput("martin_triage_runs", {
        includeHealthy: true,
        limit: 5
      })
    ).toEqual({
      includeHealthy: true,
      limit: 5
    });
  });

  it("rejects non-boolean triage flags", () => {
    expect(() =>
      validateToolInput("martin_triage_runs", {
        includeHealthy: "yes"
      })
    ).toThrow("Invalid includeHealthy.");
  });

  it("rejects attemptIndex values that do not match the public positive-integer contract", () => {
    expect(() =>
      validateToolInput("martin_get_attempt", {
        loopId: "loop_123",
        attemptIndex: 0
      })
    ).toThrow("Invalid attemptIndex.");
  });

  it("scrubs filesystem paths from reflected tool errors", () => {
    expect(
      sanitizeToolErrorMessage(
        new Error("Failed to load C:\\secret\\repo\\.martin\\policy.rego")
      )
    ).toBe("Tool execution failed.");
  });

  it("keeps discovery metadata internally consistent", () => {
    for (const starterTool of MARTIN_STARTER_TOOL_NAMES) {
      expect(MARTIN_TOOL_NAMES).toContain(starterTool);
    }

    expect(MARTIN_RESOURCE_URIS).toContain("martin://runs/triage");
    expect(MARTIN_RESOURCE_TEMPLATE_URIS).toContain("martin://runs/{loopId}/verification");
    expect(MARTIN_PROMPT_NAMES).toContain("martin_triage_run_store");
  });

  it("documents the same positive attemptIndex contract in the public schema", async () => {
    const testsDir = dirname(fileURLToPath(import.meta.url));
    const serverSource = await readFile(join(testsDir, "../src/server.ts"), "utf8");
    const normalizedServerSource = serverSource.replace(/\r\n/g, "\n");

    expect(normalizedServerSource).toContain('name: "martin_get_attempt"');
    expect(normalizedServerSource).toMatch(/attemptIndex:\s*\{\s*type:\s*"integer",\s*minimum:\s*1,/m);
  });
});
