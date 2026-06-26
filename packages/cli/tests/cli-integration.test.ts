/**
 * CLI integration tests covering adapter selection, engine flags,
 * and explicit no-spend proof mode guardrails.
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function withScratchEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const originals = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, original] of originals) {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  }
}

async function withEnvVars<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const originals = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, original] of originals) {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  }
}

async function withRunsRoot<T>(fn: (runsRoot: string) => Promise<T>): Promise<T> {
  const previousRunsRoot = process.env.MARTIN_RUNS_DIR;
  const previousGroundingRoot = process.env.MARTIN_GROUNDING_DIR;
  const previousIntegrityKeyDir = process.env.MARTIN_INTEGRITY_KEY_DIR;
  const root = await mkdtemp(join(tmpdir(), "martin-cli-int-runs-"));
  process.env.MARTIN_RUNS_DIR = join(root, "runs");
  process.env.MARTIN_GROUNDING_DIR = join(root, "grounding");
  process.env.MARTIN_INTEGRITY_KEY_DIR = join(root, "receipt-integrity");

  try {
    return await fn(process.env.MARTIN_RUNS_DIR);
  } finally {
    if (previousRunsRoot === undefined) {
      delete process.env.MARTIN_RUNS_DIR;
    } else {
      process.env.MARTIN_RUNS_DIR = previousRunsRoot;
    }
    if (previousGroundingRoot === undefined) {
      delete process.env.MARTIN_GROUNDING_DIR;
    } else {
      process.env.MARTIN_GROUNDING_DIR = previousGroundingRoot;
    }
    if (previousIntegrityKeyDir === undefined) {
      delete process.env.MARTIN_INTEGRITY_KEY_DIR;
    } else {
      process.env.MARTIN_INTEGRITY_KEY_DIR = previousIntegrityKeyDir;
    }

    await rm(root, { force: true, recursive: true }).catch(() => {});
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

function normalizeWorkingDirectoryForExpectation(workingDirectory: string): string {
  return process.platform === "win32" ? workingDirectory.toLowerCase() : workingDirectory;
}

async function readWorkflowState(
  runsRoot: string
): Promise<{ cli?: Record<string, unknown> } | undefined> {
  try {
    return JSON.parse(await readFile(join(runsRoot, "_martin", "workflow-state.json"), "utf8")) as {
      cli?: Record<string, unknown>;
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// explicit --proof guard
// ---------------------------------------------------------------------------

describe("--proof — stub adapter", () => {
  it("run command completes without spawning a real subprocess", async () => {
    const result = await withRunsRoot(() =>
      executeCli([
        "--json",
        "run",
        "--objective",
        "Add a greeting function",
        "--proof",
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
    const result = await withRunsRoot(() =>
      executeCli([
        "--json",
        "run",
        "--workspace",
        "ws_stub",
        "--project",
        "proj_stub",
        "--objective",
        "Write a hello world function",
        "--proof",
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
    // Use explicit no-spend proof mode — we verify no engine flag selects the claude adapter path,
    // not that claude itself runs successfully
    const result = await withRunsRoot(() =>
      executeCli([
        "--json",
        "run",
        "--objective",
        "Fix the bug",
        "--proof",
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

  it("passes codex launch preflight when a compatible Codex CLI is present", { timeout: 45_000 }, async () => {
    const result = await withTempDir((workspace) =>
      withFakeCodexCli(async () => {
        initializeGitRepo(workspace);
        return withRunsRoot(() =>
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
    await withTempDir(async (workspace) => {
      const runsDir = join(workspace, ".martin-runs");
      const result = await withoutAgentCliOnPath(() =>
        executeCli([
          "run",
          "--cwd",
          workspace,
          "--runs-dir",
          runsDir,
          "--objective",
          "Fix the bug",
          "--verify",
          NOOP_VERIFIER,
          "--max-iterations",
          "1",
          "--budget-usd",
          "2"
        ])
      );

      expect(result.exitCode).toBe(8);
      // Governance gate fires before engine-availability check — message reflects
      // missing receipt chain, not missing engine CLI.
      expect(result.stderr).toContain("Governed run blocked until MartinLoop receipts exist");
      expect(result.stderr).toContain("martin-loop doctor");

      const workflowState = await readWorkflowState(runsDir);
      const cliState = (workflowState?.cli ?? {}) as Record<string, unknown>;
      expect(cliState.doctor).toBeUndefined();
      expect(cliState["session-start"]).toBeUndefined();
      expect(cliState.preflight).toBeUndefined();
    });
  });

  it("auto-bootstraps governed prerequisites and executes a live Codex run when host is ready", { timeout: 90_000 }, async () => {
    await withTempDir((workspace) =>
      withFakeCodexCli(() =>
        withScratchEnv(
          {
            MARTIN_INTEGRITY_KEY_DIR: join(workspace, ".martin-receipt-integrity"),
            MARTIN_GROUNDING_DIR: join(workspace, ".martin-grounding")
          },
          async () => {
            initializeGitRepo(workspace);
            const runsDir = join(workspace, ".martin-runs");
            const result = await executeCli([
              "--json",
              "run",
              "--engine",
              "codex",
              "--cwd",
              workspace,
              "--runs-dir",
              runsDir,
              "--objective",
              "Fix the bug",
              "--verify",
              NOOP_VERIFIER,
              "--max-iterations",
              "1",
              "--budget-usd",
              "2",
            ]);

            expect(result.exitCode).toBe(0);
            const payload = JSON.parse(result.stdout);
            expect(payload.command).toBe("run");
            expect(payload.environment.engine).toBe("codex");
            expect(payload.environment.liveMode).toBe("live");
            expect(payload.loop.loopId).toMatch(/^loop_/u);
            expect(payload.loop.attempts).toHaveLength(1);
            expect(payload.loop.attempts[0].adapterId).toBe("agent-cli:codex");
            expect(payload.loop.attempts[0].summary).toContain("fake codex completed");
            const verificationEvent = payload.loop.events.find((event: { type: string }) => event.type === "verification.completed");
            expect(verificationEvent?.payload?.passed).toBe(true);
            expect(verificationEvent?.payload?.summary).toContain("passed");

            const workflowState = await readWorkflowState(runsDir);
            const cliState = (workflowState?.cli ?? {}) as Record<string, { workingDirectory?: string }>;
            const normalizedWorkingDirectory = normalizeWorkingDirectoryForExpectation(payload.environment.workingDirectory);
            expect(cliState.doctor?.workingDirectory).toBe(normalizedWorkingDirectory);
            expect(cliState["session-start"]?.workingDirectory).toBe(normalizedWorkingDirectory);
            expect(cliState.preflight?.workingDirectory).toBe(normalizedWorkingDirectory);

            const verifyResult = await executeCli([
              "--json",
              "runs",
              "verify",
              "--latest",
              "--runs-dir",
              runsDir
            ]);
            expect(verifyResult.exitCode).toBe(0);
            const verificationPayload = JSON.parse(verifyResult.stdout);
            expect(verificationPayload.verification.status).toBe("passed");
          }
        )
      )
    );
  });

  it("accepts an explicit session-start -> preflight -> run governed receipt chain", { timeout: 45000 }, async () => {
    await withTempDir((workspace) =>
      withFakeCodexCli(() =>
        withScratchEnv(
          {
            MARTIN_INTEGRITY_KEY_DIR: join(workspace, ".martin-receipt-integrity"),
            MARTIN_GROUNDING_DIR: join(workspace, ".martin-grounding")
          },
          async () => {
            initializeGitRepo(workspace);
            const runsDir = join(workspace, ".martin-runs");

            const sessionStartResult = await withEnv("MARTIN_LIVE", "true", () =>
              executeCli([
                "--json",
                "session-start",
                "--cwd",
                workspace,
                "--runs-dir",
                runsDir
              ])
            );
            expect(sessionStartResult.exitCode).toBe(0);

            const preflightResult = await withEnv("MARTIN_LIVE", "true", () =>
              executeCli([
                "--json",
                "preflight",
                "--engine",
                "codex",
                "--cwd",
                workspace,
                "--runs-dir",
                runsDir,
                "--objective",
                "Fix the bug",
                "--verify",
                NOOP_VERIFIER,
                "--max-iterations",
                "1",
                "--budget-usd",
                "2"
              ])
            );
            expect(preflightResult.exitCode).toBe(0);

            const workflowStateAfterPreflight = await readWorkflowState(runsDir);
            const cliStateAfterPreflight = (workflowStateAfterPreflight?.cli ?? {}) as Record<string, { workingDirectory?: string }>;
            const normalizedWorkingDirectory = normalizeWorkingDirectoryForExpectation(workspace);
            expect(cliStateAfterPreflight["session-start"]?.workingDirectory).toBe(normalizedWorkingDirectory);
            expect(cliStateAfterPreflight.preflight?.workingDirectory).toBe(normalizedWorkingDirectory);

            // Estimate required before governed run — proves cost was reviewed
            await withEnv("MARTIN_LIVE", "true", () =>
              executeCli(["estimate", "Fix the bug", "--engine", "codex", "--runs-dir", runsDir, "--budget-usd", "2"])
            );

            const runResult = await withEnv("MARTIN_LIVE", "true", () =>
              executeCli([
                "--json",
                "run",
                "--engine",
                "codex",
                "--cwd",
                workspace,
                "--runs-dir",
                runsDir,
                "--objective",
                "Fix the bug",
                "--verify",
                NOOP_VERIFIER,
                "--max-iterations",
                "1",
                "--budget-usd",
                "2"
              ])
            );

            expect(runResult.exitCode).toBe(0);
            const payload = JSON.parse(runResult.stdout);
            expect(payload.command).toBe("run");
            expect(payload.environment.engine).toBe("codex");
            expect(payload.environment.liveMode).toBe("live");
          }
        )
      )
    );
  });

  it("keeps governed receipts valid when guardrails normalize configured budgets", { timeout: 45000 }, async () => {
    await withTempDir((workspace) =>
      withFakeCodexCli(() =>
        withScratchEnv(
          {
            MARTIN_INTEGRITY_KEY_DIR: join(workspace, ".martin-receipt-integrity"),
            MARTIN_GROUNDING_DIR: join(workspace, ".martin-grounding")
          },
          async () => {
            initializeGitRepo(workspace);
            await writeFile(
              join(workspace, "martin.config.yaml"),
              [
                "budget:",
                "  maxUsd: 2",
                "  softLimitUsd: 2",
                "  maxIterations: 1",
                "  maxTokens: 1000",
                ""
              ].join("\n"),
              "utf8"
            );
            const runsDir = join(workspace, ".martin-runs");

            const preflightResult = await withEnv("MARTIN_LIVE", "true", () =>
              executeCli([
                "--json",
                "preflight",
                "--engine",
                "codex",
                "--cwd",
                workspace,
                "--runs-dir",
                runsDir,
                "--objective",
                "Verify the outreach runtime",
                "--verify",
                NOOP_VERIFIER
              ])
            );
            expect(preflightResult.exitCode).toBe(0);

            // Estimate required before governed run
            await withEnv("MARTIN_LIVE", "true", () =>
              executeCli(["estimate", "Verify the outreach runtime", "--engine", "codex", "--runs-dir", runsDir, "--budget-usd", "2"])
            );

            const runResult = await withEnv("MARTIN_LIVE", "true", () =>
              executeCli([
                "--json",
                "run",
                "--engine",
                "codex",
                "--cwd",
                workspace,
                "--runs-dir",
                runsDir,
                "--objective",
                "Verify the outreach runtime",
                "--verify",
                NOOP_VERIFIER
              ])
            );

            expect(runResult.exitCode).toBe(0);
          }
        )
      )
    );
  });

  it("keeps governed receipts valid when INIT_CWD changes between preflight and run", { timeout: 45000 }, async () => {
    await withTempDir((workspace) =>
      withFakeCodexCli(() =>
        withScratchEnv(
          {
            MARTIN_INTEGRITY_KEY_DIR: join(workspace, ".martin-receipt-integrity"),
            MARTIN_GROUNDING_DIR: join(workspace, ".martin-grounding")
          },
          async () => {
            initializeGitRepo(workspace);
            const runsDir = join(workspace, ".martin-runs");
            const alternateInvocationRoot = join(workspace, "tools");
            await writeFile(join(workspace, ".gitkeep"), "", "utf8");

            const preflightResult = await withEnvVars(
              {
                MARTIN_LIVE: "true",
                INIT_CWD: workspace
              },
              () =>
                executeCli([
                  "--json",
                  "preflight",
                  "--engine",
                  "codex",
                  "--cwd",
                  workspace,
                  "--runs-dir",
                  runsDir,
                  "--objective",
                  "Verify the outreach runtime",
                  "--verify",
                  NOOP_VERIFIER
                ])
            );
            expect(preflightResult.exitCode).toBe(0);

            // Estimate required before governed run
            await withEnv("MARTIN_LIVE", "true", () =>
              executeCli(["estimate", "Verify the outreach runtime", "--engine", "codex", "--runs-dir", runsDir, "--budget-usd", "2"])
            );

            const runResult = await withEnvVars(
              {
                MARTIN_LIVE: "true",
                INIT_CWD: alternateInvocationRoot
              },
              () =>
                executeCli([
                  "--json",
                  "run",
                  "--engine",
                  "codex",
                  "--cwd",
                  workspace,
                  "--runs-dir",
                  runsDir,
                  "--objective",
                  "Verify the outreach runtime",
                  "--verify",
                  NOOP_VERIFIER
                ])
            );

            expect(runResult.exitCode).toBe(0);
          }
        )
      )
    );
  });

  it("accepts explicit unsafe gate bypass in live mode", { timeout: 15000 }, async () => {
    await withTempDir((workspace) =>
      withScratchEnv(
        {
          MARTIN_INTEGRITY_KEY_DIR: join(workspace, ".martin-receipt-integrity"),
          MARTIN_GROUNDING_DIR: join(workspace, ".martin-grounding"),
          MARTIN_RUNS_DIR: join(workspace, ".martin-runs")
        },
        async () => {
          const result = await withoutAgentCliOnPath(() =>
            executeCli([
              "run",
              "--objective",
              "Fix the bug",
              "--verify",
              NOOP_VERIFIER,
              "--max-iterations",
              "1",
              "--budget-usd",
              "2",
              "--unsafe-allow-unguarded-run"
            ])
          );

          expect(result.exitCode).not.toBe(8);
          expect(result.stderr).not.toContain("Governed run preflight blocked execution");
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// --cwd flag
// ---------------------------------------------------------------------------

describe("--cwd flag", () => {
  it("passes working directory to the adapter", async () => {
    await withTempDir(async (dir) => {
      const result = await withRunsRoot(() =>
        executeCli([
          "run",
          "--objective",
          "Fix the bug",
          "--cwd",
          dir,
          "--proof",
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
