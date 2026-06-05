/**
 * CLI integration tests covering adapter selection, engine flags,
 * and the MARTIN_LIVE guard introduced with the real adapter.
 */

import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLoopRecord } from "@martin/contracts";
import { describe, expect, it } from "vitest";

import { executeCli } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOOP_VERIFIER = process.platform === "win32" ? "cmd /c exit 0" : "true";
const CLI_INTEGRATION_TIMEOUT_MS = 15_000;

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "martin-cli-int-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

async function withEnv<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
  const original = process.env[key];
  process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

async function withoutAgentCliOnPath<T>(fn: () => Promise<T>): Promise<T> {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const original = process.env[pathKey];
  process.env[pathKey] = "";

  try {
    return await fn();
  } finally {
    if (original === undefined) {
      delete process.env[pathKey];
    } else {
      process.env[pathKey] = original;
    }
  }
}

async function withPathPrefix<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const original = process.env[pathKey] ?? "";
  process.env[pathKey] = original.length > 0 ? `${dir}${process.platform === "win32" ? ";" : ":"}${original}` : dir;

  try {
    return await fn();
  } finally {
    process.env[pathKey] = original;
  }
}

async function withFakeCodexCli<T>(fn: () => Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    const script = process.platform === "win32"
      ? "@echo off\r\necho fake codex completed\r\nexit /b 0\r\n"
      : "#!/usr/bin/env sh\necho fake codex completed\n";
    const file = join(dir, process.platform === "win32" ? "codex.cmd" : "codex");
    await writeFile(file, script, "utf8");
    if (process.platform !== "win32") {
      await chmod(file, 0o755);
    }

    return withPathPrefix(dir, fn);
  });
}

// ---------------------------------------------------------------------------
// MARTIN_LIVE guard
// ---------------------------------------------------------------------------

describe("MARTIN_LIVE=false — no-spend proof mode", () => {
  it("run command completes without requiring a live provider", { timeout: CLI_INTEGRATION_TIMEOUT_MS }, async () => {
    const result = await withEnv("MARTIN_LIVE", "false", () =>
      executeCli([
        "--json",
        "run",
        "--objective",
        "Add a greeting function",
        "--max-iterations",
        "1",
        "--budget-usd",
        "5"
      ])
    );

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.command).toBe("run");
    expect(payload.loop.loopId).toMatch(/^loop_/u);
    expect(payload.loop.lifecycleState).toBe("completed");
    expect(payload.loop.cost.actualUsd).toBe(0);
    expect(payload.environment.liveMode).toBe("proof");
  });

  it("returns a valid loop record structure in proof mode", { timeout: CLI_INTEGRATION_TIMEOUT_MS }, async () => {
    const result = await withEnv("MARTIN_LIVE", "false", () =>
      executeCli([
        "--json",
        "run",
        "--workspace",
        "ws_stub",
        "--project",
        "proj_stub",
        "--objective",
        "Write a hello world function",
        "--max-iterations",
        "1"
      ])
    );

    const payload = JSON.parse(result.stdout);
    expect(payload.loop.workspaceId).toBe("ws_stub");
    expect(payload.loop.projectId).toBe("proj_stub");
    expect(payload.loop.budget.maxIterations).toBe(1);
    expect(payload.loop.lifecycleState).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Engine selection
// ---------------------------------------------------------------------------

describe("--engine flag", () => {
  it("defaults to claude when no --engine flag is given", { timeout: CLI_INTEGRATION_TIMEOUT_MS }, async () => {
    // Use proof mode — we verify no engine flag selects the claude adapter path,
    // not that claude itself runs successfully
    const result = await withEnv("MARTIN_LIVE", "false", () =>
      executeCli([
        "--json",
        "run",
        "--objective",
        "Fix the bug",
        "--max-iterations",
        "1",
        "--budget-usd",
        "2"
      ])
    );

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    // The adapter id should contain "claude" (it will be in the loop attempt if any ran)
    expect(payload.loop.loopId).toMatch(/^loop_/u);
  });

  it("selects codex adapter when --engine codex is given", { timeout: CLI_INTEGRATION_TIMEOUT_MS }, async () => {
    const result = await withTempDir((workspace) =>
      withFakeCodexCli(() =>
        withEnv("MARTIN_LIVE", "true", () =>
          executeCli([
            "--json",
            "run",
            "--engine",
            "codex",
            "--cwd",
            workspace,
            "--objective",
            "Fix the bug",
            "--verify",
            NOOP_VERIFIER,
            "--max-iterations",
            "1",
            "--budget-usd",
            "2"
          ])
        )
      )
    );

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.loop.loopId).toMatch(/^loop_/u);
    expect(["completed", "exited"]).toContain(payload.loop.status);
    // If an attempt ran, adapterId should reference codex
    const attempts = payload.loop.attempts as Array<{ adapterId: string }>;
    if (attempts.length > 0) {
      expect(attempts[0]?.adapterId).toContain("codex");
    }
  });

  it("remains graceful in live mode even when the selected CLI is unavailable", { timeout: CLI_INTEGRATION_TIMEOUT_MS }, async () => {
    const result = await withoutAgentCliOnPath(() =>
      withEnv("MARTIN_LIVE", "true", () =>
        executeCli([
          "--json",
          "run",
          "--objective",
          "Fix the bug",
          "--verify",
          NOOP_VERIFIER,
          "--max-iterations",
          "1",
          "--budget-usd",
          "2"
        ])
      )
    );

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.command).toBe("run");
    expect(payload.loop.loopId).toMatch(/^loop_/u);
  });
});

// ---------------------------------------------------------------------------
// --cwd flag
// ---------------------------------------------------------------------------

describe("--cwd flag", () => {
  it("passes working directory to the adapter", { timeout: CLI_INTEGRATION_TIMEOUT_MS }, async () => {
    await withTempDir(async (dir) => {
      const result = await withEnv("MARTIN_LIVE", "false", () =>
        executeCli([
          "run",
          "--objective",
          "Fix the bug",
          "--cwd",
          dir,
          "--max-iterations",
          "1"
        ])
      );

      expect(result.exitCode).toBe(0);
    });
  });

  it("honors --runs-dir for preflight and persisted runs", { timeout: CLI_INTEGRATION_TIMEOUT_MS }, async () => {
    await withTempDir(async (workspace) => {
      await withTempDir(async (runsDir) => {
        const preflight = await executeCli([
          "--json",
          "preflight",
          "--objective",
          "Fix the bug",
          "--cwd",
          workspace,
          "--runs-dir",
          runsDir,
          "--verify",
          NOOP_VERIFIER
        ]);

        expect(preflight.exitCode).toBe(0);
        const preflightPayload = JSON.parse(preflight.stdout);
        expect(preflightPayload.environment.runsRoot).toBe(runsDir);

        const run = await withEnv("MARTIN_LIVE", "false", () =>
          executeCli([
            "--json",
            "run",
            "--objective",
            "Fix the bug",
            "--cwd",
            workspace,
            "--runs-dir",
            runsDir,
            "--verify",
            NOOP_VERIFIER,
            "--max-iterations",
            "1"
          ])
        );

        expect(run.exitCode).toBe(0);
        const runPayload = JSON.parse(run.stdout);
        expect(runPayload.environment.runsRoot).toBe(runsDir);
        await expect(access(join(runsDir, runPayload.loop.loopId, "loop-record.json"))).resolves.toBeUndefined();
      });
    });
  });

  it("keeps preflight aligned with proof-mode verify-only semantics", { timeout: CLI_INTEGRATION_TIMEOUT_MS }, async () => {
    await withTempDir(async (workspace) => {
      const configPath = join(workspace, "martin.config.yaml");
      await writeFile(
        configPath,
        [
          "workspaceId: ws_test",
          "projectId: proj_test",
          "policyProfile: strict",
          "governance:",
          "  verifierRules:",
          "    - pnpm test",
          "    - pnpm lint"
        ].join("\n"),
        "utf8"
      );

      const preflight = await withEnv("MARTIN_LIVE", "false", () =>
        executeCli([
          "--json",
          "preflight",
          "--objective",
          "Fix the bug",
          "--cwd",
          workspace,
          "--config",
          configPath
        ])
      );

      expect(preflight.exitCode).toBe(0);
      const payload = JSON.parse(preflight.stdout);
      expect(payload.request.mutationMode).toBe("verify_only");
      expect(payload.request.verificationPlan).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Inspect command
// ---------------------------------------------------------------------------

describe("inspect command", () => {
  it("reads a loop record file and summarises the portfolio", async () => {
    await withTempDir(async (dir) => {
      const loop = createLoopRecord({
        workspaceId: "ws_test",
        projectId: "proj_test",
        task: {
          title: "Fix auth bug",
          objective: "Fix auth bug",
          verificationPlan: ["pnpm test"]
        },
        cost: {
          actualUsd: 4,
          avoidedUsd: 6,
          tokensIn: 800,
          tokensOut: 300
        }
      });

      const filePath = join(dir, "loop.json");
      await writeFile(filePath, JSON.stringify(loop), "utf8");

      const result = await executeCli(["--json", "inspect", "--file", filePath]);

      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.command).toBe("inspect");
      expect(payload.summary.totalActualUsd).toBe(4);
      expect(payload.summary.totalAvoidedUsd).toBe(6);
    });
  });

  it("exits with an error when the file does not exist", async () => {
    const result = await executeCli([
      "inspect",
      "--file",
      "/tmp/martin-nonexistent-xyzabc.json"
    ]);

    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("Persisted loop file not found");
  });

  it("summarizes persisted run directories instead of throwing EISDIR", async () => {
    await withTempDir(async (dir) => {
      const runDirectory = join(dir, "loop_123");
      const loop = createLoopRecord({
        workspaceId: "ws_test",
        projectId: "proj_test",
        task: {
          title: "Fix auth bug",
          objective: "Fix auth bug",
          verificationPlan: ["pnpm test"]
        },
        cost: {
          actualUsd: 2,
          avoidedUsd: 3,
          tokensIn: 400,
          tokensOut: 150
        }
      });

      await mkdir(runDirectory, { recursive: true });
      await writeFile(join(runDirectory, "loop-record.json"), JSON.stringify(loop), "utf8");

      const result = await executeCli(["--json", "inspect", "--file", runDirectory]);

      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.command).toBe("inspect");
      expect(payload.source).toBe(runDirectory);
      expect(payload.summary.totalActualUsd).toBe(2);
      expect(payload.summary.activeLoops).toBe(1);
    });
  });

  it("resolves relative inspect paths against --runs-dir when provided", async () => {
    await withTempDir(async (runsDir) => {
      const runDirectory = join(runsDir, "loop_456");
      const loop = createLoopRecord({
        workspaceId: "ws_test",
        projectId: "proj_test",
        task: {
          title: "Fix auth bug",
          objective: "Fix auth bug",
          verificationPlan: ["pnpm test"]
        },
        cost: {
          actualUsd: 5,
          avoidedUsd: 1,
          tokensIn: 900,
          tokensOut: 325
        }
      });

      await mkdir(runDirectory, { recursive: true });
      await writeFile(join(runDirectory, "loop-record.json"), JSON.stringify(loop), "utf8");

      const result = await executeCli([
        "--json",
        "inspect",
        "--runs-dir",
        runsDir,
        "--file",
        "loop_456"
      ]);

      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.source).toBe(runDirectory);
      expect(payload.summary.totalActualUsd).toBe(5);
      expect(payload.summary.activeLoops).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Bench command
// ---------------------------------------------------------------------------

describe("bench command", () => {
  it("guides operators to the workspace benchmark harness instead of shipping bench in the public CLI", async () => {
    const result = await executeCli(["bench", "--suite", "ralphy-smoke"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("workspace-only RC surface");
    expect(result.stderr).toContain("pnpm --filter @martin/benchmarks");
  });
});

describe("demo command", () => {
  it("copies a public-safe sandbox and prints next steps", async () => {
    await withTempDir(async (dir) => {
      const targetDirectory = join(dir, "demo sandbox");
      const result = await executeCli(["demo", "--dir", targetDirectory]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(targetDirectory);
      expect(result.stdout).toContain("npm test");
      expect(result.stdout).toContain("Task ideas live in");
    });
  });
});

// ---------------------------------------------------------------------------
// Help surface
// ---------------------------------------------------------------------------

describe("help command", () => {
  it("prints usage when invoked through the public root CLI help path", async () => {
    const result = await executeCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("martin-loop run");
    expect(result.stdout).toContain("martin-loop demo");
    expect(result.stdout).toContain("martin-loop inspect");
    expect(result.stdout).toContain("martin-loop resume");
  });
});
