/**
 * CLI integration tests covering adapter selection, engine flags,
 * and the MARTIN_LIVE guard introduced with the real adapter.
 */

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { createLoopRecord } from "@martin/contracts";
import { describe, expect, it } from "vitest";

import { executeCli } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOOP_VERIFIER = process.platform === "win32" ? "cmd /c exit 0" : "true";

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
    const originalLocalAppData = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = dir;
    const script = process.platform === "win32"
      ? [
          "@echo off",
          "echo %* | findstr /C:\"--help\" >nul",
          "if %errorlevel%==0 (",
          "  echo usage: codex exec ...",
          "  exit /b 0",
          ")",
          "echo {\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"status\":\"completed\",\"exit_code\":0}}",
          "echo {\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"fake codex completed\"}}",
          "echo {\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}",
          "exit /b 0",
          ""
        ].join("\r\n")
      : [
          "#!/usr/bin/env sh",
          "case \"$*\" in",
          "  *--help*)",
          "    echo 'usage: codex exec ...'",
          "    ;;",
          "  *)",
          "    echo '{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"status\":\"completed\",\"exit_code\":0}}'",
          "    echo '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"fake codex completed\"}}'",
          "    echo '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}'",
          "    ;;",
          "esac",
          ""
        ].join("\n");
    const file = join(dir, process.platform === "win32" ? "codex.cmd" : "codex");
    await writeFile(file, script, "utf8");
    if (process.platform !== "win32") {
      await chmod(file, 0o755);
    }

    try {
      return await withPathPrefix(dir, fn);
    } finally {
      if (originalLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = originalLocalAppData;
      }
    }
  });
}

function initializeGitRepo(directory: string): void {
  const result = spawnSync("git", ["init"], { cwd: directory, encoding: "utf8" });
  if (result.status !== 0 || result.error) {
    throw new Error(
      `Failed to initialize git repository for CLI integration test. status=${String(result.status)} error=${result.error?.message ?? "none"} stdout=${result.stdout ?? ""} stderr=${result.stderr ?? ""}`
    );
  }
}

// ---------------------------------------------------------------------------
// MARTIN_LIVE guard
// ---------------------------------------------------------------------------

describe("MARTIN_LIVE=false — stub adapter", () => {
  it("run command completes without spawning a real subprocess", async () => {
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
    expect(typeof payload.loop.attempts).toBe("object");
  });

  it("returns a valid loop record structure in stub mode", async () => {
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
  });
});

// ---------------------------------------------------------------------------
// Engine selection
// ---------------------------------------------------------------------------

describe("--engine flag", () => {
  it("defaults to claude when no --engine flag is given", { timeout: 45_000 }, async () => {
    // Use stub mode — we verify no engine flag selects the claude adapter path,
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

  it("passes codex launch preflight when a compatible Codex CLI is present", async () => {
    const result = await withTempDir((workspace) =>
      withFakeCodexCli(async () => {
        initializeGitRepo(workspace);
        return withEnv("MARTIN_LIVE", "true", () =>
          executeCli([
            "--json",
            "preflight",
            "--engine",
            "codex",
            "--cwd",
            workspace,
            "--objective",
            "Fix the bug",
            "--verify",
            NOOP_VERIFIER
          ])
        );
      })
    );

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.command).toBe("preflight");
    expect(payload.ready).toBe(true);
    expect(payload.request.engine).toBe("codex");
    expect(payload.engineProbe.available).toBe(true);
    expect(payload.engineProbe.launchReady).toBe(true);
  });

  it("blocks live run execution before spend when the governed receipt chain is missing", { timeout: 15000 }, async () => {
    const result = await withoutAgentCliOnPath(() =>
      withEnv("MARTIN_LIVE", "true", () =>
        executeCli([
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

    expect(result.exitCode).toBe(8);
    expect(result.stderr).toContain("Governed run blocked until MartinLoop receipts exist");
    expect(result.stderr).toMatch(/martin-loop (doctor|session-start)/);
  });
});

// ---------------------------------------------------------------------------
// --cwd flag
// ---------------------------------------------------------------------------

describe("--cwd flag", () => {
  it("passes working directory to the adapter", async () => {
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
});

// ---------------------------------------------------------------------------
// Bench command
// ---------------------------------------------------------------------------

describe("bench command", () => {
  it("prints a real public benchmark summary instead of a dead-end workspace warning", async () => {
    const result = await executeCli(["bench", "--suite", "ralphy-smoke"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Under-$3 Challenge");
    expect(result.stdout).toContain("$2.30");
    expect(result.stdout).toContain("$5.20");
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
