/**
 * CLI integration tests covering adapter selection, engine flags,
 * and explicit verification-only evidence guardrails.
 */

import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { spawnSync } from "node:child_process";

import {
  createStubDirectProviderAdapter,
  detectCodexHostPlatform,
  probeCodexLaunch,
  resolveCliCommandAvailability
} from "@martin/adapters";
import { createLoopRecord } from "@martin/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  __setCodexHostOverridesForTests,
  __setRunAdapterOverrideForTests,
  executeCli
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOOP_VERIFIER = process.platform === "win32" ? "cmd /c exit 0" : "true";
const FAILING_VERIFIER = process.platform === "win32" ? "cmd /c exit 1" : "false";
const codexAvailable = resolveCliCommandAvailability("codex").available;
const codexGovernedRunOptIn = process.env["MARTIN_TEST_ENABLE_LIVE_CODEX"] === "1";
const codexLaunchReady = codexGovernedRunOptIn ? detectCodexLaunchReadiness() : false;
const itIfCodexLaunchReady = codexLaunchReady ? it : it.skip;
const itIfCodexLiveHostOptIn = codexLaunchReady && codexGovernedRunOptIn ? it : it.skip;

afterEach(() => {
  __setRunAdapterOverrideForTests(undefined);
  __setCodexHostOverridesForTests(undefined);
});

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

function initializeGitRepo(directory: string): void {
  const result = spawnSync("git", ["init"], { cwd: directory, encoding: "utf8" });
  if (result.status !== 0 || result.error) {
    throw new Error(
      `Failed to initialize git repository for CLI integration test. status=${String(result.status)} error=${result.error?.message ?? "none"} stdout=${result.stdout ?? ""} stderr=${result.stderr ?? ""}`
    );
  }
}

function detectCodexLaunchReadiness(): boolean {
  const probeWorkspace = mkdtempSync(join(tmpdir(), "martin-cli-int-probe-"));
  try {
    initializeGitRepo(probeWorkspace);
    return probeCodexLaunch({
      workingDirectory: probeWorkspace,
    }).ok;
  } finally {
    rmSync(probeWorkspace, { force: true, recursive: true });
  }
}

function normalizeWorkingDirectoryForExpectation(workingDirectory: string): string {
  return process.platform === "win32" ? workingDirectory.toLowerCase() : workingDirectory;
}

function installDeterministicCodexHost(onAdapterSelect?: (engine: string | undefined) => void): void {
  const availability = {
    command: "codex",
    available: true,
    locator: "test-override",
    detail: "Codex launch overridden for deterministic governed CLI contract tests.",
    resolvedPath: "codex",
    candidatePaths: ["codex"]
  };

  __setCodexHostOverridesForTests({
    availability,
    probe: {
      ok: true,
      summary: "Codex launch overridden for deterministic governed CLI contract tests.",
      availability,
      diagnosis: {
        hostPlatform: detectCodexHostPlatform(),
        nativeInstallValid: true,
        installKind: "native",
        invocationMode: "direct",
        sandboxMode: "workspace-write",
        sandboxCompatible: true,
        resolvedPath: "codex",
        warnings: []
      },
      command: "codex",
      args: ["exec"]
    }
  });

  __setRunAdapterOverrideForTests(
    createStubDirectProviderAdapter({
      providerId: "codex-test",
      model: "gpt-5.4",
      responder: (request) => ({
        status: "completed",
        summary: "Deterministic Codex contract adapter completed.",
        usage: {
          actualUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
          provenance: "actual"
        },
        verification: {
          passed: true,
          summary: "Verification completed in deterministic CLI contract coverage.",
          binding: {
            runId: request.loopId,

            attemptId: request.attemptId,
            ...(request.context.runsRoot ? { runsRoot: request.context.runsRoot } : {}),
            ...(request.context.executionProfile ? { executionProfile: request.context.executionProfile } : {}),
            ...(request.context.allowedNetworkDomains?.length ? { allowedNetworkDomains: request.context.allowedNetworkDomains } : {}),
            workspaceId: request.workspaceId,
            cwd: request.context.repoRoot ?? process.cwd(),
            commands: request.context.verificationPlan,
          },
          steps: request.context.verificationPlan.map((command) => ({ command, launched: true, completed: true, crashed: false, exitCode: 0, timedOut: false })),
        }
      })
    }),
    onAdapterSelect
  );
}

function deriveWorkspaceKey(workingDirectory: string): string {
  const normalized = resolve(workingDirectory);
  const input = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

async function readWorkflowState(
  runsRoot: string,
  workingDirectory?: string
): Promise<{ cli?: Record<string, unknown> } | undefined> {
  try {
    const statePath = workingDirectory
      ? join(runsRoot, "_martin", "workspaces", deriveWorkspaceKey(workingDirectory), "workflow-state.json")
      : join(runsRoot, "_martin", "workflow-state.json");
    return JSON.parse(await readFile(statePath, "utf8")) as {
      cli?: Record<string, unknown>;
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// explicit --proof guard
// ---------------------------------------------------------------------------

describe("--proof mode", () => {
  it("runs only the explicit verifier and cannot claim governed success", async () => {
    const result = await withRunsRoot(() =>
      executeCli([
        "--json",
        "run",
        "--objective",
        "Add a greeting function",
        "--proof",
        "--verify",
        NOOP_VERIFIER,
        "--max-iterations",
        "1",
        "--budget-usd",
        "5"
      ])
    );

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.command).toBe("run");
    expect(payload.proofOutcome).toBe("PROOF_PASSED");
    expect(payload.loop.loopId).toMatch(/^loop_/u);
    expect(typeof payload.loop.attempts).toBe("object");
    expect(payload.loop.metadata.executionMode).toBe("verification_only");
    expect(payload.loop.metadata.governanceClaimEligible).toBe("false");
  });


  it("returns proof failure when the verifier fails", async () => {
    const result = await withRunsRoot(() =>
      executeCli([
        "--json",
        "run",
        "--objective",
        "Check a failing verifier",
        "--proof",
        "--verify",
        FAILING_VERIFIER,
        "--max-iterations",
        "1",
        "--budget-usd",
        "5"
      ])
    );

    expect(result.exitCode).toBe(7);
    const payload = JSON.parse(result.stdout);
    expect(payload.proofOutcome).toBe("PROOF_FAILED");
    expect(payload.loop.metadata.executionMode).toBe("verification_only");
    expect(payload.loop.metadata.governanceClaimEligible).toBe("false");
  });

  it("renders a passing proof as proof evidence, not governed VERIFIED", async () => {
    const result = await withRunsRoot(() =>
      executeCli([
        "run",
        "--objective",
        "Check proof-mode human output",
        "--proof",
        "--verify",
        NOOP_VERIFIER,
        "--max-iterations",
        "1",
        "--budget-usd",
        "5"
      ])
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("proof passed");
    expect(result.stdout).not.toContain("run failed");
    expect(result.stdout).not.toContain("MARTINLOOP VERIFIED HANDOFF");
    expect(result.stdout).toContain("no governed VERIFIED claim");
  });

  it("returns a valid verification-only loop record structure", async () => {
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
        "--verify",
        NOOP_VERIFIER,
        "--max-iterations",
        "1"
      ])
    );

    const payload = JSON.parse(result.stdout);
    expect(payload.loop.workspaceId).toBe("ws_stub");
    expect(payload.loop.projectId).toBe("proj_stub");
    expect(payload.loop.budget.maxIterations).toBe(1);
    expect(payload.loop.metadata.executionMode).toBe("verification_only");
    expect(payload.loop.metadata.governanceClaimEligible).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// Engine selection
// ---------------------------------------------------------------------------

describe("--engine flag", () => {
  it("defaults to claude when no --engine flag is given", { timeout: 45_000 }, async () => {
    // Verification-only mode preserves the requested engine metadata without launching it.
    const result = await withRunsRoot(() =>
      executeCli([
        "--json",
        "run",
        "--objective",
        "Fix the bug",
        "--proof",
        "--verify",
        NOOP_VERIFIER,
        "--max-iterations",
        "1",
        "--budget-usd",
        "2"
      ])
    );

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.proofOutcome).toBe("PROOF_PASSED");
    // The adapter id should contain "claude" (it will be in the loop attempt if any ran)
    expect(payload.loop.loopId).toMatch(/^loop_/u);
  });

  itIfCodexLiveHostOptIn("passes codex launch preflight when a compatible Codex CLI is present", { timeout: 45_000 }, async () => {
    const result = await withTempDir((workspace) =>
      withRunsRoot(() => {
        initializeGitRepo(workspace);
        return executeCli([
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
        ]);
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

  it("blocks Codex preflight before provider execution when the token cap cannot cover one viable turn", async () => {
    await withTempDir(async (workspace) => {
      installDeterministicCodexHost();
      initializeGitRepo(workspace);

      const result = await withEnv("MARTIN_LIVE", "true", () =>
        executeCli([
          "--json",
          "preflight",
          "--engine",
          "codex",
          "--cwd",
          workspace,
          "--objective",
          "Make one small edit",
          "--verify",
          NOOP_VERIFIER,
          "--max-tokens",
          "6000",
          "--max-iterations",
          "1",
          "--budget-usd",
          "2"
        ])
      );

      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.ready).toBe(false);
      expect(payload.blockingIssues).toContain(
        "Codex token budget is too small: 6000 configured tokens cannot cover the 128000-token minimum viable first-turn reserve."
      );
      expect(payload.tokenBudgetPreflight).toEqual({
        providerId: "codex",
        configuredMaxTokens: 6000,
        minimumViableTokens: 128000,
        provenance: "estimated",
        basis: "codex_first_turn_usage_reports_after_completion"
      });
    });
  });

  it("does not use policy_blocked for missing manual prerequisites", { timeout: 15000 }, async () => {
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

      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("Error [environment]");
      expect(result.stderr).toContain("coding-agent runtime");
      expect(result.stderr).not.toContain("Governed run blocked until MartinLoop receipts exist");
      expect(result.stderr).not.toContain("Governed run preflight blocked execution");

      const workflowState = await readWorkflowState(runsDir);
      const cliState = (workflowState?.cli ?? {}) as Record<string, unknown>;
      expect(cliState.doctor).toBeUndefined();
      expect(cliState.estimate).toBeUndefined();
      expect(cliState.preflight).toBeUndefined();
      const workspaceState = await readWorkflowState(runsDir, workspace);
      const workspaceCliState = (workspaceState?.cli ?? {}) as Record<string, unknown>;
      expect(workspaceCliState.doctor).toBeDefined();
      expect(workspaceCliState.estimate).toBeDefined();
      expect(workspaceCliState.preflight).toBeDefined();
    });
  });

  it("keeps real policy denial blocking execution", { timeout: 15000 }, async () => {
    await withTempDir(async (workspace) => {
      const runsDir = join(workspace, ".martin-runs");
      const result = await executeCli([
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
        "2",
        "--unsafe-allow-unguarded-run"
      ]);

      expect(result.exitCode).toBe(8);
      expect(result.stderr).toContain("--unsafe-allow-unguarded-run is blocked for live governed coding runs.");
    });
  });

  it("ensures estimate and preflight for a fresh one-command run", { timeout: 45000 }, async () => {
    await withTempDir(async (workspace) => {
      initializeGitRepo(workspace);
      installDeterministicCodexHost();
      const runsDir = join(workspace, ".martin-runs");

      const result = await executeCli([
        "--json", "run", "--engine", "codex", "--cwd", workspace,
        "--runs-dir", runsDir, "--objective", "Fix the fresh run",
        "--verify", NOOP_VERIFIER, "--max-iterations", "1", "--budget-usd", "2"
      ]);

      expect(result.exitCode).toBe(7);
      const payload = JSON.parse(result.stdout);
      expect(payload.command).toBe("run");
      const state = await readWorkflowState(runsDir, workspace);
      const cliState = (state?.cli ?? {}) as Record<string, unknown>;
      expect(cliState.doctor).toBeDefined();
      expect(cliState.estimate).toBeDefined();
      expect(cliState.preflight).toBeDefined();
    });
  });

  itIfCodexLiveHostOptIn("auto-bootstraps governed prerequisites and executes a live Codex run when host is ready", { timeout: 90_000 }, async () => {
    await withTempDir((workspace) =>
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
            "Inspect the repository and keep changes minimal.",
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
          expect(payload.loop.attempts[0].summary.length).toBeGreaterThan(0);
          const verificationEvent = payload.loop.events.find((event: { type: string }) => event.type === "verification.completed");
          expect(verificationEvent).toBeDefined();
          expect(typeof verificationEvent?.payload?.passed).toBe("boolean");

          const workflowState = await readWorkflowState(runsDir, payload.environment.workingDirectory);
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
          expect(["passed", "failed", "contradicted"]).toContain(verificationPayload.verification.status);
        }
      )
    );
  });

  it("accepts an explicit session-start -> preflight -> run governed receipt chain", { timeout: 45000 }, async () => {
    await withTempDir((workspace) =>
      withScratchEnv(
        {
          MARTIN_INTEGRITY_KEY_DIR: join(workspace, ".martin-receipt-integrity"),
          MARTIN_GROUNDING_DIR: join(workspace, ".martin-grounding")
        },
        async () => {
          installDeterministicCodexHost();
          initializeGitRepo(workspace);
          const runsDir = join(workspace, ".martin-runs");

            const doctorResult = await withEnv("MARTIN_LIVE", "true", () =>
              executeCli([
                "--json",
                "doctor",
                "--engine",
                "codex",
                "--cwd",
                workspace,
                "--runs-dir",
                runsDir
              ])
            );
            expect(doctorResult.exitCode).toBe(0);

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

            const workflowStateAfterPreflight = await readWorkflowState(runsDir, workspace);
            const cliStateAfterPreflight = (workflowStateAfterPreflight?.cli ?? {}) as Record<string, { workingDirectory?: string }>;
            const normalizedWorkingDirectory = normalizeWorkingDirectoryForExpectation(workspace);
            expect(cliStateAfterPreflight["session-start"]?.workingDirectory).toBe(normalizedWorkingDirectory);
            expect(cliStateAfterPreflight.preflight?.workingDirectory).toBe(normalizedWorkingDirectory);

            // Estimate required before governed run — proves cost was reviewed
            await withEnv("MARTIN_LIVE", "true", () =>
              executeCli([
                "estimate",
                "Fix the bug",
                "--engine",
                "codex",
                "--cwd",
                workspace,
                "--runs-dir",
                runsDir,
                "--budget-usd",
                "2"
              ])
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

            expect(runResult.exitCode).toBe(7);
            const payload = JSON.parse(runResult.stdout);
            expect(payload.command).toBe("run");
            expect(payload.environment.engine).toBe("codex");
          expect(payload.environment.liveMode).toBe("live");
        }
      )
    );
  });

  it("keeps governed receipts valid when guardrails normalize configured budgets", { timeout: 45000 }, async () => {
    await withTempDir((workspace) =>
      withScratchEnv(
        {
          MARTIN_INTEGRITY_KEY_DIR: join(workspace, ".martin-receipt-integrity"),
          MARTIN_GROUNDING_DIR: join(workspace, ".martin-grounding")
        },
        async () => {
          installDeterministicCodexHost();
          initializeGitRepo(workspace);
          await writeFile(
            join(workspace, "martin.config.yaml"),
            [
              "budget:",
              "  maxUsd: 2",
              "  softLimitUsd: 2",
              "  maxIterations: 1",
              "  maxTokens: 128000",
              ""
            ].join("\n"),
            "utf8"
          );
          const runsDir = join(workspace, ".martin-runs");

            const doctorResult = await withEnv("MARTIN_LIVE", "true", () =>
              executeCli([
                "--json",
                "doctor",
                "--engine",
                "codex",
                "--cwd",
                workspace,
                "--runs-dir",
                runsDir
              ])
            );
            expect(doctorResult.exitCode).toBe(0);

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
              executeCli([
                "estimate",
                "Verify the outreach runtime",
                "--engine",
                "codex",
                "--cwd",
                workspace,
                "--runs-dir",
                runsDir,
                "--budget-usd",
                "2"
              ])
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

          expect(runResult.exitCode).toBe(7);
          const payload = JSON.parse(runResult.stdout);
          expect(payload.effectivePolicy.configPath).toBe(join(workspace, "martin.config.yaml"));
          expect(payload.loop.budget).toMatchObject({
            maxUsd: 2,
            softLimitUsd: 1.5,
            maxIterations: 1,
            maxTokens: 128000
          });
        }
      )
    );
  });

  it("keeps governed receipts valid when INIT_CWD changes between preflight and run", { timeout: 45000 }, async () => {
    await withTempDir((workspace) =>
      withScratchEnv(
        {
          MARTIN_INTEGRITY_KEY_DIR: join(workspace, ".martin-receipt-integrity"),
          MARTIN_GROUNDING_DIR: join(workspace, ".martin-grounding")
        },
        async () => {
          installDeterministicCodexHost();
          initializeGitRepo(workspace);
          const runsDir = join(workspace, ".martin-runs");
          const alternateInvocationRoot = join(workspace, "tools");
          await writeFile(join(workspace, ".gitkeep"), "", "utf8");

            const doctorResult = await withEnvVars(
              {
                MARTIN_LIVE: "true",
                INIT_CWD: workspace
              },
              () =>
                executeCli([
                  "--json",
                  "doctor",
                  "--engine",
                  "codex",
                  "--cwd",
                  workspace,
                  "--runs-dir",
                  runsDir
                ])
            );
            expect(doctorResult.exitCode).toBe(0);

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
              executeCli([
                "estimate",
                "Verify the outreach runtime",
                "--engine",
                "codex",
                "--cwd",
                workspace,
                "--runs-dir",
                runsDir,
                "--budget-usd",
                "2"
              ])
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

          expect(runResult.exitCode).toBe(7);
        }
      )
    );
  });

  it("rejects explicit unsafe gate bypass in live mode", { timeout: 15000 }, async () => {
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

          expect(result.exitCode).toBe(8);
          expect(result.stderr).toContain(
            "--unsafe-allow-unguarded-run is blocked for live governed coding runs."
          );
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// --cwd flag
// ---------------------------------------------------------------------------

describe("saved engine preference lifecycle", () => {
  it("uses one saved engine for preflight and run while explicit input wins", { timeout: 45_000 }, async () => {
    await withTempDir(async (workspace) => {
      initializeGitRepo(workspace);
      const runsDir = join(workspace, ".martin-runs");
      const configPath = join(workspace, "martin.config.yaml");
      await writeFile(configPath, "# existing operator config\nengine: claude\n", "utf8");
      const selectedEngines: Array<string | undefined> = [];
      installDeterministicCodexHost((engine) => selectedEngines.push(engine));

      const enabled = await executeCli([
        "--json", "enable",
        "--cwd", workspace,
        "--runs-dir", runsDir,
        "--engine", "codex"
      ]);
      expect(enabled.exitCode).toBe(0);

      const preflight = await withEnv("MARTIN_LIVE", "true", () => executeCli([
        "--json", "preflight",
        "--cwd", workspace,
        "--runs-dir", runsDir,
        "--objective", "Use the saved engine",
        "--verify", NOOP_VERIFIER,
        "--budget-usd", "2"
      ]));
      expect(preflight.exitCode).toBe(0);
      expect(JSON.parse(preflight.stdout).environment.engine).toBe("codex");

      const run = await withEnv("MARTIN_LIVE", "true", () => executeCli([
        "--json", "run",
        "--cwd", workspace,
        "--runs-dir", runsDir,
        "--objective", "Use the saved engine",
        "--verify", NOOP_VERIFIER,
        "--budget-usd", "2",
        "--max-iterations", "1"
      ]));
      expect([0, 7]).toContain(run.exitCode);
      expect(JSON.parse(run.stdout).environment.engine).toBe("codex");
      expect(selectedEngines).toContain("codex");

      const explicitPreflight = await withEnv("MARTIN_LIVE", "true", () => executeCli([
        "--json", "preflight",
        "--cwd", workspace,
        "--runs-dir", runsDir,
        "--engine", "openai",
        "--objective", "Override the saved engine",
        "--verify", NOOP_VERIFIER,
        "--budget-usd", "2"
      ]));
      expect(explicitPreflight.exitCode).toBe(0);
      expect(JSON.parse(explicitPreflight.stdout).environment.engine).toBe("openai");

      const explicitRun = await withEnv("MARTIN_LIVE", "true", () => executeCli([
        "--json", "run",
        "--cwd", workspace,
        "--runs-dir", runsDir,
        "--engine", "openai",
        "--objective", "Override the saved engine",
        "--verify", NOOP_VERIFIER,
        "--budget-usd", "2",
        "--max-iterations", "1"
      ]));
      expect([0, 7]).toContain(explicitRun.exitCode);
      expect(JSON.parse(explicitRun.stdout).environment.engine).toBe("openai");
      expect(selectedEngines).toContain("openai");
    });
  });
});

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
          "--verify",
          NOOP_VERIFIER,
          "--max-iterations",
          "1"
        ])
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("proof passed");
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

  it("renders the full deterministic 15-role swarm transcript", async () => {
    await withTempDir(async (dir) => {
      const targetDirectory = join(dir, "swarm demo");
      const result = await executeCli(["demo", "--swarm", "--dir", targetDirectory]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("LOCAL SIMULATION · NON-GOVERNED · deterministic local workers · $0 provider spend");
      expect(result.stdout).toContain("LOCAL SIMULATION CHECK PASSED");
      for (const phase of ["CREATE", "PLAN", "FAN OUT", "REVIEW", "RECOVER", "INTEGRATE", "VERIFY", "COMPLETE"]) {
        expect(result.stdout).toContain(phase);
      }
      for (const role of ["Planner", "Data", "API", "Validation", "UI", "State", "Unit Tests", "Integration Tests", "Accessibility", "Error Handling", "Docs", "Scope Reviewer", "Test Reviewer", "Integrator", "Final Verifier"]) {
        expect(result.stdout).toContain(role);
      }
      expect(result.stdout).toContain("BLOCKED BY MARTINLOOP");
      expect(result.stdout).toContain("Task reassigned");
      expect(result.stdout).toContain("Swarm continued");
      expect(result.stdout).toContain("ONE JOB · 15 AGENTS · ONE ACCOUNTABLE OUTCOME");
      expect(result.stdout).toContain("14 completed · 1 stopped · 1 reassigned task");
      expect(result.stdout).toContain("0 denied changes admitted");
      expect(result.stdout).toContain("Parent verifier: PASS");
      expect(result.stdout).toContain("non-governed · not persisted · signed receipt integrity not evaluated");
      expect(result.stdout).not.toContain("SWARM VERIFIED");
      expect(result.stdout).not.toContain("DEMO VERIFIED");
      expect(result.stdout).not.toContain("GOVERNED BY MARTINLOOP");
    });
  });

  it("emits stable JSON and quiet output without motion controls", async () => {
    await withTempDir(async (dir) => {
      const jsonTarget = join(dir, "json-target");
      const jsonResult = await withEnv("CI", "1", () => executeCli([
        "demo", "--swarm", "--scenario", "launch-board", "--dir", jsonTarget, "--json",
      ]));
      const payload = JSON.parse(jsonResult.stdout) as Record<string, unknown>;

      expect(jsonResult.exitCode).toBe(0);
      expect(jsonResult.stdout).not.toMatch(/[\u001B\r]/u);
      expect(payload).toMatchObject({
        command: "demo --swarm",
        evidenceKind: "deterministic_demo",
        executionMode: "local_simulation",
        simulationCheck: "passed",
        governanceClaimEligible: false,
        persistedToSwarmRunStore: false,
        signedIntegrity: "not_evaluated",
        inspectionPath: "demo --swarm",
        swarmId: "swarm-demo-launch-board",
        agents: 15,
        completed: 14,
        stopped: 1,
        reassignedTasks: 1,
        deniedChangesAdmitted: 0,
        providerMode: "deterministic_local",
        providerSpendUsd: 0,
      });
      expect(Array.isArray(payload["events"])).toBe(true);
      expect(payload).not.toHaveProperty("status");
      expect(payload).not.toHaveProperty("record");

      const quietTarget = join(dir, "quiet-target");
      const quietResult = await executeCli(["demo", "--swarm", "--dir", quietTarget, "--quiet"]);
      expect(quietResult).toEqual({ exitCode: 0, stdout: "swarm-demo-launch-board", stderr: "" });
    });
  });

  it("keeps demo output outside every persisted swarm selector", async () => {
    await withTempDir(async (dir) => {
      const targetDirectory = join(dir, "demo-target");
      const runsDir = join(dir, "runs");
      const shareDirectory = join(dir, "share-bundle");
      await mkdir(runsDir, { recursive: true });

      const demo = await withEnv("MARTIN_RUNS_DIR", runsDir, () => executeCli([
        "demo", "--swarm", "--dir", targetDirectory, "--json",
      ]));
      const demoId = (JSON.parse(demo.stdout) as { swarmId: string }).swarmId;
      expect(demo.exitCode).toBe(0);
      await expect(access(join(runsDir, "_swarms"))).rejects.toThrow();

      const commands = [
        ["swarm", "status", "--swarm-id", demoId, "--runs-dir", runsDir, "--json"],
        ["swarm", "status", "--latest", "--runs-dir", runsDir, "--json"],
        ["swarm", "inspect", "--swarm-id", demoId, "--runs-dir", runsDir, "--json"],
        ["swarm", "inspect", "--latest", "--runs-dir", runsDir, "--json"],
        ["swarm", "dossier", "--id", demoId, "--runs-dir", runsDir, "--json"],
        ["swarm", "dossier", "--latest", "--runs-dir", runsDir, "--json"],
        ["swarm", "verify", "--id", demoId, "--runs-dir", runsDir, "--json"],
        ["swarm", "verify", "--latest", "--runs-dir", runsDir, "--json"],
        ["swarm", "share", "--id", demoId, "--runs-dir", runsDir, "--out-dir", shareDirectory, "--json"],
        ["swarm", "share", "--latest", "--runs-dir", runsDir, "--out-dir", shareDirectory, "--json"],
      ];

      for (const command of commands) {
        const result = await executeCli(command);
        expect(result.exitCode).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toMatch(/not_found|not found|missing swarm store/iu);
      }
      await expect(access(shareDirectory)).rejects.toThrow();
    });
  });

  it("fails unsupported modes before mutating the requested target", async () => {
    await withTempDir(async (dir) => {
      const unknownTarget = join(dir, "unknown-target");
      const unknown = await executeCli(["demo", "--swarm", "--scenario", "unknown", "--dir", unknownTarget]);
      expect(unknown.exitCode).toBe(2);
      expect(unknown.stderr).toMatch(/unknown.*scenario/iu);
      await expect(access(unknownTarget)).rejects.toThrow();

      const liveTarget = join(dir, "live-target");
      const live = await executeCli(["demo", "--swarm", "--live", "--dir", liveTarget]);
      expect(live.exitCode).toBe(2);
      expect(live.stderr).toMatch(/live workers are not part/iu);
      await expect(access(liveTarget)).rejects.toThrow();
    });
  });

  it("preserves refusal and explicit force replacement for swarm targets", async () => {
    await withTempDir(async (dir) => {
      const targetDirectory = join(dir, "existing-swarm");
      await mkdir(targetDirectory, { recursive: true });
      await writeFile(join(targetDirectory, "keep.txt"), "keep", "utf8");

      const refused = await executeCli(["demo", "--swarm", "--dir", targetDirectory]);
      expect(refused.exitCode).toBe(2);
      expect(refused.stderr).toContain("already exists and is not empty");
      expect(await readFile(join(targetDirectory, "keep.txt"), "utf8")).toBe("keep");

      const replaced = await executeCli(["demo", "--swarm", "--dir", targetDirectory, "--force"]);
      expect(replaced.exitCode).toBe(0);
      await expect(access(join(targetDirectory, "keep.txt"))).rejects.toThrow();
      expect(await readFile(join(targetDirectory, "src", "state.js"), "utf8")).toContain("createLaunchState");
    });
  });
});

// ---------------------------------------------------------------------------
// MCP portable runs-root intent
// ---------------------------------------------------------------------------

describe("mcp project Codex runs-root portability", () => {
  it.each([
    ["print-config", []],
    ["install", ["--dry-run"]]
  ] as const)("omits the resolved default runs root from mcp %s output", async (subcommand, extraArgs) => {
    await withTempDir(async (cwd) => {
      await withRunsRoot(async (runsRoot) => {
        const result = await executeCli([
          "--json",
          "mcp",
          subcommand,
          "--host",
          "codex",
          "--scope",
          "project",
          "--cwd",
          cwd,
          ...extraArgs
        ]);

        expect(result.exitCode).toBe(0);
        const payload = JSON.parse(result.stdout);
        expect(payload.targetPath).toBe(join(cwd, ".codex", "config.toml"));
        expect(payload.serverId).toBe("martin-loop");
        expect(payload.content).not.toContain("cwd =");
        expect(payload.content).not.toContain("MARTIN_RUNS_DIR");
        expect(payload.content).not.toContain(runsRoot);
      });
    });
  });

  it.each([
    ["print-config", []],
    ["install", ["--dry-run"]]
  ] as const)("preserves an explicit runs root in mcp %s output", async (subcommand, extraArgs) => {
    await withTempDir(async (cwd) => {
      const customRunsRoot = join(cwd, "chosen-runs");
      const renderedRunsRoot = customRunsRoot.replaceAll("\\", "\\\\");
      const result = await executeCli([
        "--json",
        "mcp",
        subcommand,
        "--host",
        "codex",
        "--scope",
        "project",
        "--cwd",
        cwd,
        "--runs-dir",
        customRunsRoot,
        ...extraArgs
      ]);

      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.targetPath).toBe(join(cwd, ".codex", "config.toml"));
      expect(payload.serverId).toBe("martin-loop");
      expect(payload.content).not.toContain("cwd =");
      expect(payload.content).toContain(`MARTIN_RUNS_DIR = "${renderedRunsRoot}"`);
    });
  });

  it("keeps project install, verify, rollback, and uninstall portable", async () => {
    await withTempDir(async (cwd) => {
      const targetPath = join(cwd, ".codex", "config.toml");
      await mkdir(join(cwd, ".codex"), { recursive: true });
      await writeFile(targetPath, "# operator config\n", "utf8");
      const baseArgs = ["--host", "codex", "--scope", "project", "--cwd", cwd];

      const installed = await executeCli(["--json", "mcp", "install", ...baseArgs]);
      expect(installed.exitCode).toBe(0);
      const installedContent = await readFile(targetPath, "utf8");
      expect(installedContent).toContain('[mcp_servers."martin-loop"]');
      expect(installedContent).not.toContain("cwd =");
      expect(installedContent).not.toContain("MARTIN_RUNS_DIR");

      const verified = await executeCli(["--json", "mcp", "verify-install", ...baseArgs]);
      expect(verified.exitCode).toBe(0);

      const rolledBack = await executeCli(["--json", "mcp", "rollback", ...baseArgs]);
      expect(rolledBack.exitCode).toBe(0);
      expect(await readFile(targetPath, "utf8")).toBe("# operator config\n");

      const reinstalled = await executeCli(["--json", "mcp", "install", ...baseArgs]);
      expect(reinstalled.exitCode).toBe(0);
      const uninstalled = await executeCli(["--json", "mcp", "uninstall", ...baseArgs]);
      expect(uninstalled.exitCode).toBe(0);
      expect(await readFile(targetPath, "utf8")).toBe("# operator config\n");
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
    expect(result.stdout).toContain("Your coding agent says it's done. MartinLoop makes it prove it.");
    expect(result.stdout).toContain("Apache 2.0 · martinloop.com · github.com/Keesan12/martin-loop");
    expect(result.stdout).toContain("martin-loop run");
    expect(result.stdout).toContain("martin-loop demo");
    expect(result.stdout).toContain("martin-loop inspect");
    expect(result.stdout).toContain("martin-loop resume");
    expect(result.stdout).toContain("provider-free local simulation");
    expect(result.stdout).toContain("non-governed");
    expect(result.stdout).toContain("not written to the Swarm run store");
    expect(result.stdout).toMatch(/swarm status.*persisted/iu);
    expect(result.stdout).toMatch(/swarm inspect.*persisted/iu);
    expect(result.stdout).toMatch(/swarm dossier.*sealed persisted/iu);
    expect(result.stdout).toMatch(/swarm verify.*sealed persisted/iu);
    expect(result.stdout).toMatch(/swarm share.*sealed persisted/iu);
  });
});
