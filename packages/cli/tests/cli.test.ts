import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStubDirectProviderAdapter, detectCodexHostPlatform } from "@martin/adapters";
import { writeReceiptIntegrityMaterial } from "@martin/core";
import { afterEach, describe, expect, it } from "vitest";

import { createLoopRecord, type LoopRecord } from "../../contracts/src/index.js";
import {
  __setCodexHostOverridesForTests,
  __setRunAdapterOverrideForTests,
  describeApprovalRollbackStatus,
  executeCli,
  parseCliArguments,
} from "../src/index.js";

const STAR_CTA_HEADLINE = "⭐ MartinLoop produced a verified handoff.";
const STAR_CTA_REPO = "github.com/Keesan12/martin-loop";

describe("approval rollback wording", () => {
  it("never claims the workspace is unchanged when rollback failed", () => {
    const message = describeApprovalRollbackStatus(
      {
        attempted: true,
        status: "failed",
        restoredAt: "2026-10-15T00:00:00.000Z",
        decision: "DISCARD",
        before: { trackedDirtyFiles: ["test.ts"], untrackedFiles: [] },
        after: { trackedDirtyFiles: ["test.ts"], untrackedFiles: [] },
        restoredFiles: [],
        deletedFiles: [],
        error: "safe restoration could not be proved"
      },
      "loop_failed_rollback"
    );

    expect(message).toContain("Rollback failed");
    expect(message).not.toContain("workspace is unchanged");
  });

  it("points operators to the supported attempt inspection command", () => {
    const message = describeApprovalRollbackStatus(undefined, "loop_blocked_291");

    expect(message).toContain("martin runs attempt --loop-id loop_blocked_291");
    expect(message).not.toContain("martin receipt --run");
  });
});

describe("swarm demo argument parsing", () => {
  it("preserves the exact legacy demo command shape", () => {
    expect(parseCliArguments(["demo", "--dir", "legacy-demo", "--force"])).toEqual({
      command: "demo",
      directory: join(process.cwd(), "legacy-demo"),
      force: true,
    });
  });

  it("adds swarm fields only for the deterministic swarm path", () => {
    expect(parseCliArguments(["demo", "--swarm", "--scenario", "launch-board", "--dir", "swarm-demo"])).toEqual({
      command: "demo",
      directory: join(process.cwd(), "swarm-demo"),
      force: false,
      swarm: true,
      scenario: "launch-board",
    });
  });

  it("rejects unknown scenarios, live mode, and unsupported swarm flags", () => {
    expect(() => parseCliArguments(["demo", "--swarm", "--scenario", "unknown"])).toThrow(/unknown.*scenario/iu);
    expect(() => parseCliArguments(["demo", "--swarm", "--live"])).toThrow(/live workers are not part/iu);
    expect(() => parseCliArguments(["demo", "--swarm", "--surprise"])).toThrow(/unsupported/iu);
  });

  it("keeps legacy single-run share routing distinct from local swarm share", () => {
    expect(parseCliArguments(["share", "--loop-id", "loop-a"])).toMatchObject({
      command: "share", selector: { loopId: "loop-a" },
    });
    expect(parseCliArguments(["swarm", "share", "--id", "swarm-a", "--out-dir", "bundle"]))
      .toEqual({ command: "swarm_share", request: { swarmId: "swarm-a", outputDir: "bundle" } });
  });
});

function initializeCommittedGitRepository(directory: string): void {
  expect(spawnSync("git", ["init"], { cwd: directory }).status).toBe(0);
  expect(spawnSync("git", ["config", "user.email", "cli@test.invalid"], { cwd: directory }).status).toBe(0);
  expect(spawnSync("git", ["config", "user.name", "CLI Test"], { cwd: directory }).status).toBe(0);
  expect(spawnSync("git", ["add", "."], { cwd: directory }).status).toBe(0);
  expect(spawnSync("git", ["commit", "--allow-empty", "-m", "fixture"], { cwd: directory }).status).toBe(0);
}

function installFastRunAdapter(): void {
  __setRunAdapterOverrideForTests(
    createStubDirectProviderAdapter({
      providerId: "test",
      model: "fast",
      responder: (request) => ({
        status: "completed",
        summary: "Fast test adapter completed.",
        usage: {
          actualUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
          provenance: "actual"
        },
        verification: {
          passed: true,
          summary: "Verification completed in config-focused CLI tests.",
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
          steps: request.context.verificationPlan.map((command) => ({
            command,
            launched: true,
            completed: true,
            crashed: false,
            exitCode: 0,
            timedOut: false,
          })),
        }
      })
    })
  );
}

function installFailingRunAdapter(): void {
  __setRunAdapterOverrideForTests(
    createStubDirectProviderAdapter({
      providerId: "test",
      model: "slow-fail",
      responder: () => ({
        status: "failed",
        summary: "The adapter could not satisfy the verifier.",
        usage: {
          actualUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
          provenance: "actual"
        },
        verification: {
          passed: false,
          summary: "Verification failed in the stub adapter."
        },
        failure: {
          message: "Verification failed in the stub adapter.",
          classHint: "verification_failure"
        }
      })
    })
  );
}

function installChangingRunAdapter(changedFiles: string[]): void {
  const adapter: NonNullable<Parameters<typeof __setRunAdapterOverrideForTests>[0]> = {
    adapterId: "agent-cli:change-approval-test",
    kind: "agent-cli",
    label: "Change approval test adapter",
    metadata: { providerId: "codex", model: "test-change-producer" },
    async execute(request) {
      return {
        status: "completed",
        summary: "Produced a controlled test change.",
        usage: {
          actualUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
          provenance: "actual"
        },
        verification: {
          passed: true,
          summary: "Verification completed in approval-policy CLI tests.",
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
          steps: request.context.verificationPlan.map((command) => ({
            command,
            launched: true,
            completed: true,
            crashed: false,
            exitCode: 0,
            timedOut: false,
          })),
        },
        execution: {
          changedFiles,
          diffStats: {
            filesChanged: changedFiles.length,
            addedLines: changedFiles.length,
            deletedLines: 0
          }
        }
      };
    }
  };
  __setRunAdapterOverrideForTests(adapter);
}

function installWritingRunAdapter(filePath: string, contents: string): void {
  const availability = {
    command: "codex",
    available: true,
    locator: "test-override",
    detail: "Codex launch overridden for deterministic governed CLI artifact tests.",
    resolvedPath: "codex",
    candidatePaths: ["codex"]
  };
  __setCodexHostOverridesForTests({
    availability,
    probe: {
      ok: true,
      summary: "Codex launch overridden for deterministic governed CLI artifact tests.",
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

  const adapter: NonNullable<Parameters<typeof __setRunAdapterOverrideForTests>[0]> = {
    adapterId: "agent-cli:cli-artifact-test",
    kind: "agent-cli",
    label: "CLI artifact persistence test adapter",
    metadata: { providerId: "codex", model: "test-artifact-producer" },
    async execute(request) {
      await mkdir(join(request.context.repoRoot ?? process.cwd(), filePath.split("/").slice(0, -1).join("/")), {
        recursive: true
      });
      await writeFile(join(request.context.repoRoot ?? process.cwd(), filePath), contents, "utf8");
      return {
        status: "completed",
        summary: "Created a controlled CLI test artifact.",
        usage: {
          actualUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
          provenance: "actual"
        },
        verification: {
          passed: true,
          summary: "Verification completed in CLI artifact persistence test.",
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
          steps: request.context.verificationPlan.map((command) => ({
            command,
            launched: true,
            completed: true,
            crashed: false,
            exitCode: 0,
            timedOut: false,
          })),
        },
        execution: {
          changedFiles: [filePath],
          diffStats: {
            filesChanged: 1,
            addedLines: 1,
            deletedLines: 0
          }
        }
      };
    }
  };
  __setRunAdapterOverrideForTests(adapter);
}

afterEach(() => {
  __setRunAdapterOverrideForTests(undefined);
  __setCodexHostOverridesForTests(undefined);
});

async function withIsolatedRunsEnv<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  const previousRunsDir = process.env.MARTIN_RUNS_DIR;
  const previousGroundingDir = process.env.MARTIN_GROUNDING_DIR;
  const previousIntegrityKeyDir = process.env.MARTIN_INTEGRITY_KEY_DIR;
  process.env.MARTIN_RUNS_DIR = join(directory, ".martin-runs");
  process.env.MARTIN_GROUNDING_DIR = join(directory, ".martin-grounding");
  process.env.MARTIN_INTEGRITY_KEY_DIR = join(directory, ".martin-receipt-integrity");

  try {
    return await fn();
  } finally {
    if (previousRunsDir === undefined) {
      delete process.env.MARTIN_RUNS_DIR;
    } else {
      process.env.MARTIN_RUNS_DIR = previousRunsDir;
    }
    if (previousGroundingDir === undefined) {
      delete process.env.MARTIN_GROUNDING_DIR;
    } else {
      process.env.MARTIN_GROUNDING_DIR = previousGroundingDir;
    }
    if (previousIntegrityKeyDir === undefined) {
      delete process.env.MARTIN_INTEGRITY_KEY_DIR;
    } else {
      process.env.MARTIN_INTEGRITY_KEY_DIR = previousIntegrityKeyDir;
    }
  }
}

function makeCliLifecycleTruthRecord(directory: string): LoopRecord {
  const loopId = "loop_cli_surface_agreement";
  const workspaceId = "ws_cli_surface_agreement";
  const attemptId = "attempt_cli_surface_agreement";
  const runsRoot = join(directory, ".martin-runs");
  const verificationPlan = ["npm test"];
  const base = createLoopRecord({
    workspaceId,
    projectId: "proj_cli_surface_agreement",
    task: {
      title: "Reconcile CLI evidence surfaces",
      objective: "Reconcile CLI evidence surfaces",
      repoRoot: directory,
      verificationPlan,
      mutationMode: "edit",
    },
    budget: { maxUsd: 10, softLimitUsd: 6, maxIterations: 3, maxTokens: 10_000 },
    cost: {
      actualUsd: 1,
      avoidedUsd: 0,
      tokensIn: 100,
      tokensOut: 50,
      provenance: "actual",
    },
    receiptScope: { workingDirectory: directory, runsRoot },
    terminationEnvelope: {
      schemaVersion: "termination/1",
      class: "operational_exit",
      exit: {
        schemaVersion: "exit-evaluation/1",
        policyVersion: "exit-policy/1",
        shouldExit: true,
        primary: "goal_met",
        matched: ["goal_met"],
        phase: "post_attempt",
        evaluatedAt: "2026-10-09T20:31:00.000Z",
        matches: [{
          kind: "goal_met",
          reason: "Persisted goal evidence passed.",
          evidence: { verifierScore: 1 },
        }],
      },
    },
  });
  const fileEffects = {
    observationStatus: "observed",
    touchedDuringExecution: ["src/kept.ts", "src/reverted.ts"],
    netChangedAtCompletion: ["src/kept.ts"],
    revertedBeforeCompletion: ["src/reverted.ts"],
  };

  return {
    ...base,
    loopId,
    status: "completed",
    lifecycleState: "completed",
    updatedAt: "2026-10-09T20:31:01.000Z",
    attempts: [{
      attemptId,
      index: 1,
      adapterId: "agent-cli:codex",
      model: "gpt-5.4",
      startedAt: "2026-10-09T20:30:00.000Z",
      completedAt: "2026-10-09T20:31:00.000Z",
    }],
    events: [
      {
        eventId: "evt_cli_surface_verified",
        timestamp: "2026-10-09T20:31:00.000Z",
        type: "verification.completed",
        lifecycleState: "verifying",
        payload: {
          passed: true,
          attemptIndex: 1,
          summary: "Verifier passed.",
          changedFiles: ["src/kept.ts"],
          binding: {
            runId: loopId,
            workspaceId,
            attemptId,
            cwd: directory,
            runsRoot,
            commands: verificationPlan,
          },
          steps: [{
            command: "npm test",
            launched: true,
            completed: true,
            crashed: false,
            exitCode: 0,
            timedOut: false,
          }],
        },
      },
      {
        eventId: "evt_cli_surface_completed",
        timestamp: "2026-10-09T20:31:01.000Z",
        type: "run.completed",
        lifecycleState: "completed",
        payload: { reason: "goal_met", fileEffects },
      },
    ],
  };
}

async function persistCanonicalLifecycleRecord(directory: string, loop: LoopRecord): Promise<void> {
  const runsRoot = join(directory, ".martin-runs");
  const loopDir = join(runsRoot, loop.loopId);
  const ledgerEntries = loop.events;
  await mkdir(loopDir, { recursive: true });
  await writeFile(join(loopDir, "loop-record.json"), `${JSON.stringify(loop, null, 2)}\n`, "utf8");
  await writeFile(
    join(loopDir, "ledger.jsonl"),
    `${ledgerEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
  await writeReceiptIntegrityMaterial({
    runId: loop.loopId,
    runsRoot,
    loopRecord: loop,
    ledgerEntries,
    scope: loop.receiptScope,
    signedAt: loop.updatedAt,
  });
}

describe("parseCliArguments", () => {
  it("parses version flags and subcommand", () => {
    expect(parseCliArguments(["--version"])).toEqual({ command: "version" });
    expect(parseCliArguments(["-V"])).toEqual({ command: "version" });
    expect(parseCliArguments(["version"])).toEqual({ command: "version" });
  });

  it("parses start onboarding and tour shorthand", () => {
    expect(parseCliArguments(["start"])).toEqual({ command: "start" });
    expect(parseCliArguments(["tour"])).toEqual({ command: "start" });
  });

  it("binds estimate receipts to an explicit token-capped budget", () => {
    expect(parseCliArguments([
      "estimate",
      "Qualify the live three-agent swarm",
      "--engine",
      "codex",
      "--budget-usd",
      "5",
      "--soft-limit-usd",
      "3.75",
      "--max-iterations",
      "1",
      "--max-tokens",
      "30000",
    ])).toEqual({
      command: "estimate",
      objective: "Qualify the live three-agent swarm",
      engine: "codex",
      budgetUsd: 5,
      fileScope: [],
      budget: {
        maxUsd: 5,
        softLimitUsd: 3.75,
        maxIterations: 1,
        maxTokens: 30000,
      },
    });
  });

  it("parses a run command into a typed request", () => {
    const parsed = parseCliArguments([
      "run",
      "--workspace",
      "ws_ops",
      "--project",
      "proj_runtime",
      "--objective",
      "Repair the flaky CI gate",
      "--verify",
      "pnpm test",
      "--verify",
      "pnpm build",
      "--metadata",
      "owner=platform",
      "--metadata",
      "lane=nightly",
      "--budget-usd",
      "18",
      "--baseline-usd",
      "30.7",
      "--baseline-source",
      "measured_control",
      "--baseline-provenance",
      "actual",
      "--soft-limit-usd",
      "9.5",
      "--max-iterations",
      "4",
      "--max-tokens",
      "60000",
      "--verify-timeout-ms",
      "240000",
      "--provider-execution-timeout-ms",
      "900000",
      "--policy",
      "balanced",
      "--telemetry",
      "control-plane",
      "--proof",
      "--unsafe-allow-unguarded-run"
    ]);

    expect(parsed).toEqual({
      command: "run",
      request: {
        workspaceId: "ws_ops",
        projectId: "proj_runtime",
        title: "Repair the flaky CI gate",
        objective: "Repair the flaky CI gate",
        verificationPlan: ["pnpm test", "pnpm build"],
        verifyTimeoutMs: 240000,
        providerExecutionTimeoutMs: 900000,
        metadata: {
          policyProfile: "balanced",
          telemetryDestination: "control-plane",
          lane: "nightly",
          owner: "platform"
        },
        budget: {
          maxIterations: 4,
          maxTokens: 60000,
          maxUsd: 18,
          softLimitUsd: 9.5
        },
        savingsBaseline: {
          usd: 30.7,
          source: "measured_control",
          provenance: "actual"
        },
        budgetOverrides: {
          maxIterations: true,
          maxTokens: true,
          maxUsd: true,
          softLimitUsd: true
        },
        liveMode: "proof",
        unsafeAllowUnguardedRun: true
      }
    });
  });

  it("rejects unknown run flags instead of silently ignoring them", () => {
    expect(() => parseCliArguments([
      "run",
      "--objective",
      "Reject unknown flags",
      "--definitely-not-a-real-option"
    ])).toThrow(/Unknown run option: --definitely-not-a-real-option/u);
  });

  it("rejects unsupported single-dash run options instead of treating them as positional noise", () => {
    expect(() => parseCliArguments([
      "run",
      "--objective",
      "Reject typoed proof mode",
      "-proof"
    ])).toThrow(/Unknown run option: -proof/u);
  });

  it.each([
    ["missing", undefined],
    ["zero", "0"],
    ["negative", "-1"],
    ["NaN", "NaN"],
    ["infinite", "Infinity"]
  ])("rejects a %s --max-tokens value", (_label, value) => {
    const argv = ["run", "--objective", "Reject invalid token budgets", "--max-tokens"];
    if (value !== undefined) argv.push(value);

    expect(() => parseCliArguments(argv)).toThrow(/--max-tokens requires (?:a value|a finite positive integer)/u);
  });

  it("accepts a finite positive --max-tokens value", () => {
    expect(parseCliArguments([
      "run",
      "--objective",
      "Accept a valid token budget",
      "--max-tokens",
      "128000"
    ])).toEqual(expect.objectContaining({
      command: "run",
      request: expect.objectContaining({
        budget: expect.objectContaining({ maxTokens: 128000 })
      })
    }));
  });

  it.each(["run", "preflight"])("rejects malformed run and preflight values for %s", (command) => {
    const invalidCases: Array<{ args: string[]; message: RegExp }> = [
      { args: ["--budget-usd", "not-a-number"], message: /--budget-usd.*finite.*greater than zero/iu },
      { args: ["--budget-usd", "NaN"], message: /--budget-usd.*finite.*greater than zero/iu },
      { args: ["--budget-usd", "Infinity"], message: /--budget-usd.*finite.*greater than zero/iu },
      { args: ["--budget-usd", "0"], message: /--budget-usd.*finite.*greater than zero/iu },
      { args: ["--budget-usd", "-1"], message: /--budget-usd.*finite.*greater than zero/iu },
      { args: ["--soft-limit-usd", "NaN"], message: /--soft-limit-usd.*finite.*non-negative/iu },
      { args: ["--soft-limit-usd", "-1"], message: /--soft-limit-usd.*finite.*non-negative/iu },
      { args: ["--max-iterations", "1.2"], message: /--max-iterations.*positive integer/iu },
      { args: ["--max-tokens", "1.2"], message: /--max-tokens.*positive integer/iu },
      { args: ["--verify-timeout-ms", "0"], message: /--verify-timeout-ms.*positive integer/iu },
      { args: ["--provider-execution-timeout-ms", "Infinity"], message: /--provider-execution-timeout-ms.*positive integer/iu },
      { args: ["--budget-usd"], message: /--budget-usd requires a value/iu },
      { args: ["--budget-usd", ""], message: /--budget-usd requires a non-empty value/iu },
      { args: ["--budget-usd", "--proof"], message: /--budget-usd requires a value/iu },
      { args: ["--budget-usd", "1", "--budget", "2"], message: /budget.*only be provided once/iu },
      { args: ["--max-iterations", "1", "--max-iterations", "2"], message: /--max-iterations.*only be provided once/iu },
    ];

    for (const invalid of invalidCases) {
      expect(
        () => parseCliArguments([command, "--objective", "Reject malformed limits", ...invalid.args]),
        `${command} ${invalid.args.join(" ")}`,
      ).toThrow(invalid.message);
    }
  });

  it("preserves valid run and preflight scalar boundaries", () => {
    for (const command of ["run", "preflight"] as const) {
      const parsed = parseCliArguments([
        command,
        "--objective", "Keep valid limits",
        "--budget-usd", "1",
        "--soft-limit-usd", "0.99",
        "--max-iterations", "1",
        "--max-tokens", "1",
        "--verify-timeout-ms", "1",
        "--provider-execution-timeout-ms", "1",
      ]);
      expect(parsed).toMatchObject({
        command,
        request: {
          budget: { maxUsd: 1, softLimitUsd: 0.99, maxIterations: 1, maxTokens: 1 },
          verifyTimeoutMs: 1,
          providerExecutionTimeoutMs: 1,
        },
      });
    }
  });

  it("returns one invalid_input JSON document for the malformed run and preflight budget case", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-invalid-budget-json-"));
    const runsDirectory = join(directory, "runs-must-not-exist");

    try {
      const result = await executeCli([
        "preflight",
        "Invalid budget should fail",
        "--engine", "codex",
        "--verify", "npm test",
        "--budget-usd", "not-a-number",
        "--json",
        "--runs-dir", runsDirectory,
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe("");
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload).toMatchObject({ ok: false, category: "invalid_input" });
      expect(payload).not.toHaveProperty("ready", true);
      expect(result.stdout).not.toContain('"maxUsd": null');
      await expect(readdir(runsDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.each(["run", "preflight"])("rejects budget conflicts for %s", (command) => {
    expect(() => parseCliArguments([
      command,
      "--objective", "Reject conflicting budgets",
      "--soft-limit-usd", "1",
      "--budget-usd", "1",
    ])).toThrow(/--soft-limit-usd must be less than --budget-usd/iu);

    expect(() => parseCliArguments([
      command,
      "--objective", "Keep the valid budget boundary",
      "--soft-limit-usd", "0.99",
      "--budget-usd", "1",
    ])).not.toThrow();
  });

  it("preserves repeated verifier order, proof mode, and a literal Windows path", () => {
    const windowsPath = "C:\\Program Files\\Example Tool\\verify.cmd";
    const parsed = parseCliArguments([
      "preflight",
      "--objective", "Preserve supported argv",
      "--proof",
      "--verify", "pnpm test",
      "--verify", windowsPath,
      "--cwd", "C:\\Program Files\\Example Workspace",
    ]);

    expect(parsed).toMatchObject({
      command: "preflight",
      request: {
        liveMode: "proof",
        verificationPlan: ["pnpm test", windowsPath],
        cwd: "C:\\Program Files\\Example Workspace",
      },
    });
  });

  it.each([
    ["budget text", ["--budget-usd", "not-a-number"]],
    ["budget NaN", ["--budget-usd", "NaN"]],
    ["budget infinity", ["--budget-usd", "Infinity"]],
    ["budget zero", ["--budget-usd", "0"]],
    ["budget negative", ["--budget-usd", "-1"]],
    ["fractional iterations", ["--max-iterations", "1.2"]],
    ["fractional tokens", ["--max-tokens", "1.2"]],
    ["missing value", ["--budget-usd"]],
    ["flag as value", ["--budget-usd", "--engine", "codex"]],
    ["duplicate alias", ["--budget", "1", "--budget-usd", "2"]],
    ["budget conflict", ["--budget-usd", "1", "--soft-limit-usd", "1"]],
  ])("rejects estimate invalid %s input", (_label, invalidArgs) => {
    expect(() => parseCliArguments([
      "estimate",
      "Reject invalid estimate input",
      ...invalidArgs,
    ])).toThrow();
  });

  it("preserves estimate boundary values and absent-option defaults", () => {
    expect(parseCliArguments(["estimate", "Use defaults"])).toMatchObject({
      command: "estimate",
      budgetUsd: 5,
    });
    expect(parseCliArguments([
      "estimate", "Use exact boundaries",
      "--budget-usd", "1",
      "--soft-limit-usd", "0.99",
      "--max-iterations", "1",
      "--max-tokens", "1",
    ])).toMatchObject({
      command: "estimate",
      budgetUsd: 1,
      budget: { maxUsd: 1, softLimitUsd: 0.99, maxIterations: 1, maxTokens: 1 },
    });
  });

  it("rejects enable invalid numeric input during parsing", () => {
    for (const invalidArgs of [
      ["--budget-usd", "not-a-number"],
      ["--budget-usd", "0"],
      ["--max-iterations", "1.2"],
      ["--max-iterations", "Infinity"],
      ["--budget-usd"],
      ["--max-iterations", "--force"],
      ["--budget-usd", "1", "--budget-usd", "2"],
    ]) {
      expect(() => parseCliArguments(["enable", ...invalidArgs])).toThrow();
    }

    expect(parseCliArguments([
      "enable",
      "--budget-usd", "2.5",
      "--max-iterations", "2",
    ])).toMatchObject({
      command: "enable",
      budgetUsd: 2.5,
      maxIterations: 2,
    });
  });

  it("rejects --verify when its command is missing", () => {
    expect(() => parseCliArguments([
      "run",
      "--objective",
      "Require an explicit verifier command",
      "--verify",
      "--engine",
      "codex"
    ])).toThrow(/--verify requires a verifier command/u);
  });

  it("rejects an incomplete RoTS-Cost baseline", () => {
    expect(() => parseCliArguments([
      "run",
      "--objective",
      "Repair the flaky CI gate",
      "--baseline-usd",
      "5.2"
    ])).toThrow(/requires --baseline-usd, --baseline-source, and --baseline-provenance together/u);
  });

  it("maps approval flags to the typed approval policy fields", () => {
    const parsed = parseCliArguments([
      "run",
      "--objective",
      "Apply an approved dependency and migration update",
      "--approve-dependency-changes",
      "--approve-migrations",
      "--approve-config-changes"
    ]);

    expect(parsed).toEqual({
      command: "run",
      request: expect.objectContaining({
        approvalPolicy: {
          dependencyAdds: true,
          migrations: true,
          configChanges: true
        }
      })
    });
  });

  it("maps --approve-test-changes to the test-change approval field", () => {
    const parsed = parseCliArguments([
      "run",
      "--objective",
      "Rewrite the outdated add test",
      "--approve-test-changes"
    ]);

    expect(parsed).toEqual({
      command: "run",
      request: expect.objectContaining({ approvalPolicy: { testChanges: true } })
    });
  });

  it("treats run/preflight help flags as top-level help", () => {
    expect(parseCliArguments(["run", "--help"])).toEqual({ command: "help" });
    expect(parseCliArguments(["run", "-h"])).toEqual({ command: "help" });
    expect(parseCliArguments(["preflight", "--help"])).toEqual({ command: "help" });
    expect(parseCliArguments(["preflight", "-h"])).toEqual({ command: "help" });
  });

  it("parses onboarding commands and objective shorthand", () => {
    expect(parseCliArguments(["start"])).toEqual({ command: "start" });
    expect(parseCliArguments(["env"])).toEqual({ command: "env" });
    expect(parseCliArguments(["review"])).toEqual({
      command: "review",
      selector: { latest: true }
    });
    expect(parseCliArguments(["receipts", "explain"])).toEqual({
      command: "receipts_explain",
      selector: { latest: true }
    });
    expect(parseCliArguments(["fix flaky tests", "--proof", "--verify", "npm test"])).toEqual({
      command: "run",
      request: expect.objectContaining({
        objective: "fix flaky tests",
        liveMode: "proof",
        verificationPlan: ["npm test"]
      })
    });
  });

  it("parses MCP install with paid-remote profile and experimental host flag", () => {
    expect(
      parseCliArguments([
        "mcp",
        "install",
        "--host",
        "cursor",
        "--transport",
        "remote",
        "--profile",
        "paid-remote",
        "--experimental-remote-hosts"
      ])
    ).toEqual({
      command: "mcp_install",
      host: "cursor",
      scope: "user",
      transport: "remote",
      profile: "paid-remote",
      experimentalRemoteHosts: true,
      dryRun: false,
      installGovernance: false,
      runsRootSource: "default"
    });
  });

  it("parses MCP install lifecycle commands", () => {
    expect(parseCliArguments([
      "mcp",
      "verify-install",
      "--host",
      "vscode",
      "--scope",
      "project"
    ])).toEqual({
      command: "mcp_verify_install",
      host: "vscode",
      scope: "project"
    });
    expect(parseCliArguments(["mcp", "rollback", "--host", "cursor"])).toEqual({
      command: "mcp_rollback",
      host: "cursor",
      scope: "user"
    });
    expect(parseCliArguments(["mcp", "uninstall", "--host", "codex"])).toEqual({
      command: "mcp_uninstall",
      host: "codex",
      scope: "user"
    });
  });
});

describe("executeCli", () => {
  it("keeps lifecycle truth share agreement across dossier, runs verify, receipt, and share", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-lifecycle-truth-"));

    try {
      await withIsolatedRunsEnv(directory, async () => {
        const loop = makeCliLifecycleTruthRecord(directory);
        await persistCanonicalLifecycleRecord(directory, loop);

        const dossierResult = await executeCli(["--json", "dossier", "--loop-id", loop.loopId]);
        const verifyResult = await executeCli(["--json", "runs", "verify", "--loop-id", loop.loopId]);
        const shareResult = await executeCli(["--json", "share", "--loop-id", loop.loopId]);
        expect([dossierResult.exitCode, verifyResult.exitCode, shareResult.exitCode]).toEqual([0, 0, 0]);

        const dossier = JSON.parse(dossierResult.stdout);
        const verify = JSON.parse(verifyResult.stdout);
        const share = JSON.parse(shareResult.stdout);
        const receipt = JSON.parse(await readFile(share.files.receiptJson, "utf8"));
        const markdown = await readFile(share.files.receiptMarkdown, "utf8");
        const selectAuthority = (handoff: Record<string, unknown>) => ({
          outcome: handoff["outcome"],
          verification: handoff["verification"],
          receiptIntegrity: handoff["receiptIntegrity"],
          lifecycleTruth: handoff["lifecycleTruth"],
          fileEffects: handoff["fileEffects"],
        });
        const canonical = selectAuthority(dossier.verifiedHandoff);

        expect(canonical).toMatchObject({
          outcome: "VERIFIED",
          verification: { status: "PASSED" },
          receiptIntegrity: { state: "verified" },
          lifecycleTruth: { reasonCode: "goal_met", exhaustedLimits: [] },
          fileEffects: {
            observationStatus: "observed",
            touchedDuringExecution: ["src/kept.ts", "src/reverted.ts"],
            netChangedAtCompletion: ["src/kept.ts"],
            revertedBeforeCompletion: ["src/reverted.ts"],
          },
        });
        expect(selectAuthority(verify.verifiedHandoff)).toEqual(canonical);
        expect(selectAuthority(receipt.verifiedHandoff)).toEqual(canonical);
        expect(receipt.receipt).toMatchObject({
          outcome: canonical.outcome,
          lifecycleTruth: canonical.lifecycleTruth,
          fileEffects: canonical.fileEffects,
        });
        expect(markdown).toContain("- Outcome: VERIFIED");
        expect(markdown).toContain("- Execution: completed / completed");
        expect(markdown).toContain("- Verification: PASSED");
        expect(markdown).toContain("- Receipt integrity: verified");
        expect(markdown).toContain("- Termination: goal_met");
        expect(markdown).toContain("- File effects: touched 2, net 1, reverted 1");
        expect(markdown).not.toContain(directory);
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("renders turn-cap lifecycle truth without dollar or token pressure claims", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-turn-cap-truth-"));

    try {
      await withIsolatedRunsEnv(directory, async () => {
        const base = makeCliLifecycleTruthRecord(directory);
        const loop: LoopRecord = {
          ...base,
          loopId: "loop_cli_turn_cap_truth",
          status: "exited",
          lifecycleState: "budget_exit",
          budget: { ...base.budget, maxIterations: 1 },
          terminationEnvelope: {
            schemaVersion: "termination/1",
            class: "operational_exit",
            exit: {
              schemaVersion: "exit-evaluation/1",
              policyVersion: "exit-policy/1",
              shouldExit: true,
              primary: "turn_cap",
              matched: ["turn_cap"],
              phase: "post_attempt",
              evaluatedAt: "2026-10-09T20:31:00.000Z",
              matches: [{
                kind: "turn_cap",
                reason: "Iteration limit reached.",
                evidence: { turnsUsed: 1, maxTurns: 1 },
              }],
            },
          },
          events: base.events.map((event) =>
            event.type === "verification.completed"
              ? {
                  ...event,
                  payload: {
                    ...event.payload,
                    binding: {
                      ...(event.payload["binding"] as Record<string, unknown>),
                      runId: "loop_cli_turn_cap_truth",
                    },
                  },
                }
              : {
                  ...event,
                  lifecycleState: "budget_exit",
                  payload: { ...event.payload, reason: "turn_cap" },
                },
          ),
        };
        await persistCanonicalLifecycleRecord(directory, loop);

        const result = await executeCli(["--json", "share", "--loop-id", loop.loopId]);
        const payload = JSON.parse(result.stdout);
        const markdown = await readFile(payload.files.receiptMarkdown, "utf8");

        expect(result.exitCode).toBe(0);
        expect(payload.receipt.verifiedHandoff).toMatchObject({
          outcome: "STOPPED",
          lifecycleTruth: { reasonCode: "turn_cap", exhaustedLimits: ["iterations"] },
        });
        expect(markdown).toContain("- Termination: turn_cap");
        expect(markdown).toContain("- Exhausted limits: iterations");
        expect(markdown).toMatch(/iteration limit/iu);
        expect(markdown).not.toMatch(/dollar pressure|token pressure|\$/iu);
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("prints runs verify help with --latest selector support", async () => {
    const result = await executeCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Your coding agent says it's done. MartinLoop makes it prove it.");
    expect(result.stdout).toContain("Apache 2.0 · martinloop.com · github.com/Keesan12/martin-loop");
    expect(result.stdout).toContain("martin start [options]");
    expect(result.stdout).toContain("martin receipts explain");
    expect(result.stdout).toContain("martin runs verify (--loop-id <id> | --file <path> | --latest) [options]");
    expect(result.stdout).toContain("martin sync [status|flush]");
    expect(result.stdout).toContain("martin start [options]");
    expect(result.stdout).toContain("--experimental-remote-hosts");
  });

  it("blocks remote MCP config for cursor without explicit experimental opt-in", async () => {
    const result = await executeCli([
      "mcp",
      "print-config",
      "--host",
      "cursor",
      "--transport",
      "remote"
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("experimental");
    expect(result.stderr).toContain("--experimental-remote-hosts");
  });

  it("prints the public root package version", async () => {
    const rootPackageVersion = (
      JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as {
        version: string;
      }
    ).version;
    const result = await executeCli(["--version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(rootPackageVersion);
  });

  it("returns invalid_input JSON for estimate invalid explicit values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-invalid-estimate-"));
    const runsDirectory = join(directory, "runs-must-not-exist");
    try {
      const result = await executeCli([
        "--json", "estimate", "Reject invalid estimate",
        "--budget-usd", "not-a-number",
        "--runs-dir", runsDirectory,
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, category: "invalid_input" });
      await expect(readdir(runsDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects enable invalid numeric input before writing config or run state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-invalid-enable-"));
    try {
      const before = await readdir(directory);
      const result = await executeCli([
        "--json", "enable",
        "--cwd", directory,
        "--budget-usd", "not-a-number",
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, category: "invalid_input" });
      expect(await readdir(directory)).toEqual(before);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("recovers an engine preference without rewriting an existing config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-enable-engine-recovery-"));
    const configPath = join(directory, "martin.config.yaml");
    const runsDirectory = join(directory, "runs");
    const original = "# operator-owned bytes\nengine: claude\n";
    await writeFile(configPath, original, "utf8");
    const originalDigest = createHash("sha256").update(original).digest("hex");

    try {
      const result = await executeCli([
        "--json", "enable",
        "--cwd", directory,
        "--runs-dir", runsDirectory,
        "--engine", "codex"
      ]);
      const after = await readFile(configPath, "utf8");

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command: "enable",
        defaults: { engine: "codex" }
      });
      expect(after).toBe(original);
      expect(createHash("sha256").update(after).digest("hex")).toBe(originalDigest);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("still refuses config-changing enable options without force", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-enable-config-refusal-"));
    const configPath = join(directory, "martin.config.yaml");
    const original = "# preserve me\nengine: claude\n";
    await writeFile(configPath, original, "utf8");

    try {
      const result = await executeCli([
        "enable",
        "--cwd", directory,
        "--engine", "codex",
        "--budget-usd", "3"
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Config already exists");
      expect(await readFile(configPath, "utf8")).toBe(original);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps proof preflight non-live when MARTIN_LIVE defaults to true", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-proof-preflight-"));
    const previousMartinLive = process.env.MARTIN_LIVE;
    process.env.MARTIN_LIVE = "true";

    try {
      const result = await withIsolatedRunsEnv(directory, () => executeCli([
        "--json",
        "preflight",
        "--objective",
        "Collect verification-only evidence",
        "--proof",
        "--engine",
        "codex",
        "--cwd",
        directory,
        "--verify",
        process.platform === "win32" ? "cmd /c exit 0" : "true"
      ]));
      const payload = JSON.parse(result.stdout) as {
        environment: { liveMode: string };
        tokenBudgetPreflight?: unknown;
      };

      expect(result.exitCode).toBe(0);
      expect(payload.environment.liveMode).toBe("proof");
      expect(payload.tokenBudgetPreflight).toBeUndefined();
    } finally {
      if (previousMartinLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = previousMartinLive;
      }
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects malformed input and budget conflicts before invoking adapters or Codex probes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-invalid-before-effects-"));
    let adapterCalls = 0;
    let probeCalls = 0;
    __setRunAdapterOverrideForTests(
      createStubDirectProviderAdapter({
        providerId: "test",
        model: "must-not-run",
        responder: () => {
          adapterCalls += 1;
          throw new Error("invalid argv reached the provider adapter");
        },
      }),
    );
    __setCodexHostOverridesForTests({
      probe: () => {
        probeCalls += 1;
        throw new Error("invalid argv reached the Codex launch probe");
      },
    });

    const cases = [
      ["--budget-usd", "not-a-number"],
      ["--max-iterations", "1.2"],
      ["--verify-timeout-ms", "0"],
      ["--budget-usd", "1", "--budget", "2"],
      ["--soft-limit-usd", "1", "--budget-usd", "1"],
    ];

    try {
      for (const [caseIndex, invalidArgs] of cases.entries()) {
        const runsDirectory = join(directory, `runs-${caseIndex}`);
        const result = await executeCli([
          "--json",
          caseIndex % 2 === 0 ? "run" : "preflight",
          "--objective", "Reject before side effects",
          "--engine", "codex",
          ...invalidArgs,
          "--runs-dir", runsDirectory,
        ]);

        expect(result.exitCode).toBe(2);
        expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, category: "invalid_input" });
        await expect(readdir(runsDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(adapterCalls).toBe(0);
      expect(probeCalls).toBe(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects -proof before invoking an adapter or creating a run store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-single-dash-proof-"));
    let adapterInvoked = false;
    __setRunAdapterOverrideForTests(
      createStubDirectProviderAdapter({
        providerId: "test",
        model: "must-not-run",
        responder: () => {
          adapterInvoked = true;
          throw new Error("-proof reached the provider adapter");
        }
      })
    );

    try {
      const result = await withIsolatedRunsEnv(directory, () => executeCli([
        "run",
        "--objective",
        "Do not accept a typoed proof flag",
        "-proof",
        "--cwd",
        directory
      ]));

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Unknown run option: -proof");
      expect(adapterInvoked).toBe(false);
      await expect(readdir(join(directory, ".martin-runs"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects top-level proof before invoking an adapter or creating a run store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-top-level-proof-"));
    const runsDirectory = join(directory, "runs-must-not-exist");
    let adapterInvoked = false;
    __setRunAdapterOverrideForTests(
      createStubDirectProviderAdapter({
        providerId: "test",
        model: "must-not-run",
        responder: () => {
          adapterInvoked = true;
          throw new Error("top-level proof reached the provider adapter");
        }
      })
    );

    try {
      const result = await executeCli([
        "--json",
        "proof",
        "Collect evidence without a governed run",
        "--runs-dir",
        runsDirectory
      ]);

      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, category: "invalid_input" });
      expect(result.stdout).toContain("martin run <objective> --proof");
      expect(adapterInvoked).toBe(false);
      await expect(readdir(runsDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.each([
    ["missing", undefined],
    ["zero", "0"],
    ["negative", "-1"],
    ["NaN", "NaN"],
    ["infinite", "Infinity"]
  ])("rejects a %s --max-tokens value before invoking an adapter or creating a run store", async (_label, value) => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-invalid-max-tokens-"));
    let adapterInvoked = false;
    __setRunAdapterOverrideForTests(
      createStubDirectProviderAdapter({
        providerId: "test",
        model: "must-not-run",
        responder: () => {
          adapterInvoked = true;
          throw new Error("invalid --max-tokens reached the provider adapter");
        }
      })
    );

    try {
      const argv = [
        "run",
        "--objective",
        "Reject an invalid token budget",
        "--max-tokens"
      ];
      if (value !== undefined) argv.push(value);
      argv.push("--cwd", directory);
      const result = await withIsolatedRunsEnv(directory, () => executeCli(argv));

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toMatch(/--max-tokens requires (?:a value|a finite positive integer)/u);
      expect(adapterInvoked).toBe(false);
      await expect(readdir(join(directory, ".martin-runs"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects the retired --verify-only run flag instead of silently ignoring it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-retired-verify-only-"));
    let adapterInvoked = false;
    __setRunAdapterOverrideForTests(
      createStubDirectProviderAdapter({
        providerId: "test",
        model: "must-not-run",
        responder: () => {
          adapterInvoked = true;
          throw new Error("retired --verify-only reached the provider adapter");
        }
      })
    );

    try {
      const result = await withIsolatedRunsEnv(directory, () => executeCli([
        "run",
        "--objective",
        "Do not accept retired verifier-only semantics",
        "--verify-only",
        "--verify",
        process.platform === "win32" ? "cmd /c exit 0" : "true",
        "--cwd",
        directory
      ]));

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("--verify-only");
      expect(result.stderr).toContain("--proof");
      expect(adapterInvoked).toBe(false);
      await expect(readdir(join(directory, ".martin-runs"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("renders start onboarding guidance with governed defaults", { timeout: 30_000 }, async () => {
    const result = await executeCli(["start"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("MartinLoop — Governed AI Coding");
    expect(result.stdout).toContain("martin doctor");
    expect(result.stdout).toContain("martin estimate");
    expect(result.stdout).toMatch(
      /martin run "Summarize this repository and confirm the verifier is green\." --verify "(npm|pnpm) test" --budget-usd 2 --max-iterations 1/u
    );
    expect(result.stdout).toMatch(
      /martin enable --engine (auto|claude|codex|gemini|openai) --verify "(npm|pnpm) test" --budget-usd 2 --max-iterations 1/u
    );
  });

  it("resolves effectivePolicy from config and applies it to the run", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-config-"));
    const configPath = join(directory, "martin.config.yaml");

    try {
      installFastRunAdapter();
      await writeFile(
        configPath,
        [
          "policyProfile: strict",
          "budget:",
          "  maxUsd: 12",
          "  softLimitUsd: 7",
          "  maxIterations: 6",
          "  maxTokens: 45000",
          "governance:",
          "  destructiveActionPolicy: approval",
          "  telemetryDestination: control-plane",
          "  verifierRules:",
          "    - pnpm test",
          "    - pnpm lint"
        ].join("\n"),
        "utf8"
      );

      const prevLive = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";
      const result = await withIsolatedRunsEnv(directory, () =>
        executeCli([
          "--json",
          "run",
          "--objective",
          "Repair flaky CI gate",
          "--config",
          configPath
        ])
      );
      if (prevLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = prevLive;
      }

      expect(result.exitCode).toBe(7);

      const payload = JSON.parse(result.stdout);

      expect(payload.command).toBe("run");
      expect(payload.effectivePolicy).toEqual({
        configPath,
        destructiveActionPolicy: "approval",
        policyProfile: "strict",
        budget: {
          maxUsd: 12,
          softLimitUsd: 7,
          maxIterations: 6,
          maxTokens: 45000
        },
        verifierRules: ["pnpm test", "pnpm lint"],
        maxUsd: 12,
        softLimitUsd: 7,
        maxIterations: 6,
        maxTokens: 45000,
        telemetryDestination: "control-plane"
      });
      expect(payload.loop.budget).toEqual({
        maxUsd: 12,
        softLimitUsd: 7,
        maxIterations: 6,
        maxTokens: 45000
      });
      expect(payload.loop.task.verificationPlan).toEqual(["pnpm test", "pnpm lint"]);
      expect(payload.loop.metadata.executionMode).toBe("simulated");
      expect(payload.loop.metadata.governanceClaimEligible).toBe("false");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("surfaces effective governance policy metadata in run output", { timeout: 45_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-policy-"));
    const configPath = join(directory, "martin.config.yaml");

    try {
      installFastRunAdapter();
      await writeFile(
        configPath,
        [
          "policyProfile: strict",
          "budget:",
          "  maxUsd: 12",
          "  softLimitUsd: 7",
          "  maxIterations: 5",
          "  maxTokens: 30000",
          "governance:",
          "  destructiveActionPolicy: approval",
          "  telemetryDestination: seeded-telemetry",
          "  verifierRules:",
          process.platform === "win32" ? "    - cmd /c exit 0" : "    - true",
          process.platform === "win32" ? "    - cmd /c exit 0" : "    - true"
        ].join("\n"),
        "utf8"
      );

      const prevLive = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";
      const result = await withIsolatedRunsEnv(directory, () =>
        executeCli([
          "--json",
          "run",
          "--objective",
          "Repair flaky CI gate",
          "--config",
          configPath,
          "--budget-usd",
          "8",
          "--soft-limit-usd",
          "5",
          "--max-iterations",
          "3",
          "--max-tokens",
          "20000",
          "--policy",
          "balanced",
          "--telemetry",
          "control-plane"
        ])
      );
      if (prevLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = prevLive;
      }

      expect(result.exitCode).toBe(7);

      const payload = JSON.parse(result.stdout);

      expect(payload.command).toBe("run");
      expect(payload.effectivePolicy).toEqual({
        configPath,
        destructiveActionPolicy: "approval",
        policyProfile: "balanced",
        budget: {
          maxUsd: 8,
          softLimitUsd: 5,
          maxIterations: 3,
          maxTokens: 20000
        },
        verifierRules: [
          process.platform === "win32" ? "cmd /c exit 0" : "true",
          process.platform === "win32" ? "cmd /c exit 0" : "true"
        ],
        maxUsd: 8,
        softLimitUsd: 5,
        maxIterations: 3,
        maxTokens: 20000,
        telemetryDestination: "control-plane"
      });
      expect(payload.loop.task.verificationPlan).toEqual([
        process.platform === "win32" ? "cmd /c exit 0" : "true",
        process.platform === "win32" ? "cmd /c exit 0" : "true"
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });


  it("prints the v5 run header for successful human-readable runs", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-run-header-"));

    try {
      installFastRunAdapter();
      const previousMartinLive = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";
      const result = await withIsolatedRunsEnv(directory, () =>
        executeCli([
          "run",
          "--objective",
          "Verify the contracts package without edits",
          "--engine",
          "codex",
          "--verify",
          `"${process.execPath}" -e "process.exit(0)"`,
          "--cwd",
          directory
        ])
      );
      if (previousMartinLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = previousMartinLive;
      }

      expect(result.exitCode).toBe(7);
      expect(result.stdout).toContain("∞ martinloop");
      expect(result.stdout).not.toContain("✓ verified");
      expect(result.stdout).not.toContain("MartinLoop saved you from a runaway bill.");
      expect(result.stdout).not.toContain("Star the repo:");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps the v5 run header out of machine-readable JSON output", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-run-header-json-"));

    try {
      installFastRunAdapter();
      const previousMartinLive = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";
      const result = await withIsolatedRunsEnv(directory, () =>
        executeCli([
          "--json",
          "run",
          "--objective",
          "Verify the contracts package without edits",
          "--engine",
          "codex",
          "--verify",
          `"${process.execPath}" -e "process.exit(0)"`,
          "--cwd",
          directory
        ])
      );
      if (previousMartinLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = previousMartinLive;
      }

      expect(result.exitCode).toBe(7);
      expect(result.stdout).not.toContain("∞ martinloop");
      expect(result.stdout).not.toContain("Star the repo");
      expect(result.stdout).not.toContain("runaway bill");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("prints approval guidance for dependency changes that need operator approval", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-approval-human-"));

    try {
      installChangingRunAdapter(["package.json"]);
      await writeFile(join(directory, "package.json"), '{"name":"approval-human"}', "utf8");
      initializeCommittedGitRepository(directory);
      const previousMartinLive = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";
      const result = await withIsolatedRunsEnv(directory, () =>
        executeCli([
          "run",
          "--objective",
          "Update a dependency only when approval is present",
          "--engine",
          "codex",
          "--verify",
          `"${process.execPath}" -e "process.exit(0)"`,
          "--cwd",
          directory
        ])
      );
      if (previousMartinLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = previousMartinLive;
      }

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Blocked: the agent needs operator approval to proceed.");
      expect(result.stdout).toContain("--approve-dependency-changes");
      expect(result.stdout).toContain("--approve-migrations");
      expect(result.stdout).toContain("--approve-config-changes");
      expect(result.stdout).toContain("The workspace is unchanged.");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps approval-block guidance out of JSON output while preserving typed reason codes", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-approval-json-"));

    try {
      installChangingRunAdapter(["package.json"]);
      await writeFile(join(directory, "package.json"), '{"name":"approval-json"}', "utf8");
      initializeCommittedGitRepository(directory);
      const previousMartinLive = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";
      const result = await withIsolatedRunsEnv(directory, () =>
        executeCli([
          "--json",
          "run",
          "--objective",
          "Update a dependency only when approval is present",
          "--engine",
          "codex",
          "--verify",
          `"${process.execPath}" -e "process.exit(0)"`,
          "--cwd",
          directory
        ])
      );
      if (previousMartinLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = previousMartinLive;
      }

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain("Blocked: the agent needs operator approval");
      expect(result.stdout).not.toContain("--approve-dependency-changes");

      const payload = JSON.parse(result.stdout);
      expect(payload.decision).toMatchObject({
        failureClass: "safety_leash_blocked",
        reasonCode: "dependency_approval_required"
      });
      expect(payload.loop.lifecycleState).toBe("human_escalation");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("emits only the loop id for quiet approval-block output", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-approval-quiet-"));

    try {
      installChangingRunAdapter(["package.json"]);
      await writeFile(join(directory, "package.json"), '{"name":"approval-quiet"}', "utf8");
      initializeCommittedGitRepository(directory);
      const previousMartinLive = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";
      const result = await withIsolatedRunsEnv(directory, () =>
        executeCli([
          "--quiet",
          "run",
          "--objective",
          "Update a dependency only when approval is present",
          "--engine",
          "codex",
          "--verify",
          `"${process.execPath}" -e "process.exit(0)"`,
          "--cwd",
          directory
        ])
      );
      if (previousMartinLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = previousMartinLive;
      }

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^loop_[A-Za-z0-9_-]+$/);
      expect(result.stdout).not.toContain("Blocked:");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps CI approval-block output free of interactive prompts", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-approval-ci-"));

    try {
      installChangingRunAdapter(["package.json"]);
      await writeFile(join(directory, "package.json"), '{"name":"approval-ci"}', "utf8");
      initializeCommittedGitRepository(directory);
      const previousMartinLive = process.env.MARTIN_LIVE;
      const previousCi = process.env.CI;
      process.env.MARTIN_LIVE = "false";
      process.env.CI = "1";
      const result = await withIsolatedRunsEnv(directory, () =>
        executeCli([
          "run",
          "--objective",
          "Update a dependency only when approval is present",
          "--engine",
          "codex",
          "--verify",
          `"${process.execPath}" -e "process.exit(0)"`,
          "--cwd",
          directory
        ])
      );
      if (previousMartinLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = previousMartinLive;
      }
      if (previousCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = previousCi;
      }

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain("Blocked: the agent needs operator approval to proceed.");
      expect(result.stdout).not.toContain("quick one");
      expect(result.stdout).not.toContain("is martin actually earning its keep");
      expect(result.stderr).toBe("");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps non-TTY approval-block output free of interactive prompts", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-approval-nontty-"));
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

    try {
      installChangingRunAdapter(["package.json"]);
      await writeFile(join(directory, "package.json"), '{"name":"approval-nontty"}', "utf8");
      initializeCommittedGitRepository(directory);
      Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
      const previousMartinLive = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";
      const result = await withIsolatedRunsEnv(directory, () =>
        executeCli([
          "run",
          "--objective",
          "Update a dependency only when approval is present",
          "--engine",
          "codex",
          "--verify",
          `"${process.execPath}" -e "process.exit(0)"`,
          "--cwd",
          directory
        ])
      );
      if (previousMartinLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = previousMartinLive;
      }

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain("Blocked: the agent needs operator approval to proceed.");
      expect(result.stdout).not.toContain("quick one");
      expect(result.stdout).not.toContain("is martin actually earning its keep");
      expect(result.stderr).toBe("");
    } finally {
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      } else {
        delete (process.stdout as unknown as Record<string, unknown>)["isTTY"];
      }
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      } else {
        delete (process.stdin as unknown as Record<string, unknown>)["isTTY"];
      }
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("allows dependency changes when the dependency approval flag is present", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-approval-allowed-"));

    try {
      installChangingRunAdapter(["package.json"]);
      await writeFile(join(directory, "package.json"), '{"name":"approval-allowed"}', "utf8");
      initializeCommittedGitRepository(directory);
      const previousMartinLive = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";
      const result = await withIsolatedRunsEnv(directory, () =>
        executeCli([
          "--json",
          "run",
          "--objective",
          "Update an approved dependency",
          "--engine",
          "codex",
          "--verify",
          `"${process.execPath}" -e "process.exit(0)"`,
          "--approve-dependency-changes",
          "--cwd",
          directory
        ])
      );
      if (previousMartinLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = previousMartinLive;
      }

      expect(result.exitCode).toBe(7);
      const payload = JSON.parse(result.stdout);
      expect(payload.loop.task.approvalPolicy).toEqual({ dependencyAdds: true });
      expect(payload.loop.attempts).toHaveLength(1);
      expect(payload.loop.attempts[0]).toMatchObject({
        summary: "Produced a controlled test change."
      });
      expect(payload.loop.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "verification.completed",
            payload: expect.objectContaining({ passed: true })
          })
        ])
      );
      expect(payload.decision.failureClass).not.toBe("safety_leash_blocked");
      expect(payload.decision.reasonCode).not.toBe("dependency_approval_required");
      expect(payload.loop.lifecycleState).toBe("completed");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("persists verifier timeout on governed runs", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-verify-timeout-"));

    try {
      installFastRunAdapter();
      const previousMartinLive = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";
      const result = await withIsolatedRunsEnv(directory, () =>
        executeCli([
          "--json",
          "run",
          "--objective",
          "Verify timeout persistence",
          "--engine",
          "codex",
          "--verify",
          `"${process.execPath}" -e "process.exit(0)"`,
          "--verify-timeout-ms",
          "240000",
          "--provider-execution-timeout-ms",
          "900000",
          "--cwd",
          directory
        ])
      );
      if (previousMartinLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = previousMartinLive;
      }

      expect(result.exitCode).toBe(7);

      const payload = JSON.parse(result.stdout);
      expect(payload.loop.task.verificationTimeoutMs).toBe(240000);
      expect(payload.loop.task.providerExecutionTimeoutMs).toBe(900000);
      expect(payload.loop.receiptScope.providerExecutionTimeoutMs).toBe(900000);
      expect(payload.loop.task.agentExecutionIntent).toBe("governed-autonomous");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("persists patch decision artifacts for real CLI governed runs", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-patch-decision-"));
    const stateDirectory = await mkdtemp(join(tmpdir(), "martin-cli-patch-state-"));

    try {
      installWritingRunAdapter("src/cli-artifact.ts", "export const cliArtifact = true;\n");
      await writeFile(join(directory, "README.md"), "# CLI patch decision fixture\n", "utf8");
      initializeCommittedGitRepository(directory);
      const previousMartinLive = process.env.MARTIN_LIVE;
      // The adapter override is deterministic and provider-free, while the
      // command itself must exercise the governed (not proof-only) lifecycle.
      process.env.MARTIN_LIVE = "true";
      const result = await withIsolatedRunsEnv(stateDirectory, () =>
        executeCli([
          "--json",
          "run",
          "--objective",
          "Create a source artifact through the CLI",
          "--engine",
          "codex",
          "--verify",
          `"${process.execPath}" -e "process.exit(0)"`,
          "--cwd",
          directory,
          "--allow-path",
          "src/cli-artifact.ts"
        ])
      );
      if (previousMartinLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = previousMartinLive;
      }

      expect([0, 7]).toContain(result.exitCode);
      const payload = JSON.parse(result.stdout);
      expect(payload.loop.lifecycleState).toBe("completed");
      expect(payload.loop.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "verification.completed",
            payload: expect.objectContaining({
              passed: true,
              changedFiles: ["src/cli-artifact.ts"]
            })
          })
        ])
      );

      const patchDecision = JSON.parse(
        await readFile(
          join(
            payload.environment.runsRoot,
            payload.loop.loopId,
            "artifacts",
            "attempt-001",
            "patch-decision.json"
          ),
          "utf8"
        )
      );
      expect(patchDecision.decision).toBe("KEEP");
      expect(patchDecision.reasonCodes).toContain("verifier_passed");
    } finally {
      await rm(directory, { force: true, recursive: true });
      await rm(stateDirectory, { force: true, recursive: true });
    }
  });

  it("runs --proof through verifier-only and cannot claim governed success", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-proof-mode-"));

    try {
      const result = await executeCli([
        "--json",
        "run",
        "--objective",
        "Proof mode smoke",
        "--proof",
        "--engine",
        "codex",
        "--verify",
        `"${process.execPath}" -e "process.exit(0)"`,
        "--cwd",
        directory
      ]);

      expect(result.exitCode).toBe(0);

      const payload = JSON.parse(result.stdout);
      expect(payload.proofOutcome).toBe("PROOF_PASSED");
      expect(payload.environment.liveMode).toBe("proof");
      expect(payload.loop.cost.actualUsd).toBe(0);
      expect(payload.loop.task.mutationMode).toBeUndefined();
      expect(payload.loop.metadata.executionMode).toBe("verification_only");
      expect(payload.loop.metadata.governanceClaimEligible).toBe("false");
      expect(payload.loop.attempts[0].adapterId).toBe("direct:verifier:verify-only");
      expect(payload.successCallToAction).toBeUndefined();

      const persisted = JSON.parse(
        await readFile(
          join(payload.environment.runsRoot, payload.loop.loopId, "loop-record.json"),
          "utf8"
        )
      );
      expect(persisted.metadata.executionMode).toBe("verification_only");
      expect(persisted.metadata.governanceClaimEligible).toBe("false");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("prints approval guidance for dependency changes that need operator approval", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-approval-human-"));

    try {
      installChangingRunAdapter(["package.json"]);
      await writeFile(join(directory, "package.json"), '{"name":"approval-human"}', "utf8");
      initializeCommittedGitRepository(directory);
      const previousMartinLive = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";
      const result = await withIsolatedRunsEnv(directory, () =>
        executeCli([
          "run",
          "--objective",
          "Update a dependency only when approval is present",
          "--engine",
          "codex",
          "--verify",
          `"${process.execPath}" -e "process.exit(0)"`,
          "--cwd",
          directory
        ])
      );
      if (previousMartinLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = previousMartinLive;
      }

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Blocked: the agent needs operator approval to proceed.");
      expect(result.stdout).toContain("--approve-dependency-changes");
      expect(result.stdout).toContain("--approve-migrations");
      expect(result.stdout).toContain("--approve-config-changes");
      expect(result.stdout).toContain("The workspace is unchanged.");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps approval-block guidance out of JSON output while preserving typed reason codes", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-approval-json-"));

    try {
      installChangingRunAdapter(["package.json"]);
      await writeFile(join(directory, "package.json"), '{"name":"approval-json"}', "utf8");
      initializeCommittedGitRepository(directory);
      const previousMartinLive = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";
      const result = await withIsolatedRunsEnv(directory, () =>
        executeCli([
          "--json",
          "run",
          "--objective",
          "Update a dependency only when approval is present",
          "--engine",
          "codex",
          "--verify",
          `"${process.execPath}" -e "process.exit(0)"`,
          "--cwd",
          directory
        ])
      );
      if (previousMartinLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = previousMartinLive;
      }

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain("Blocked: the agent needs operator approval");
      expect(result.stdout).not.toContain("--approve-dependency-changes");

      const payload = JSON.parse(result.stdout);
      expect(payload.decision).toMatchObject({
        failureClass: "safety_leash_blocked",
        reasonCode: "dependency_approval_required"
      });
      expect(payload.loop.lifecycleState).toBe("human_escalation");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("emits only the loop id for quiet approval-block output", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-approval-quiet-"));

    try {
      installChangingRunAdapter(["package.json"]);
      await writeFile(join(directory, "package.json"), '{"name":"approval-quiet"}', "utf8");
      initializeCommittedGitRepository(directory);
      const previousMartinLive = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";
      const result = await withIsolatedRunsEnv(directory, () =>
        executeCli([
          "--quiet",
          "run",
          "--objective",
          "Update a dependency only when approval is present",
          "--engine",
          "codex",
          "--verify",
          `"${process.execPath}" -e "process.exit(0)"`,
          "--cwd",
          directory
        ])
      );
      if (previousMartinLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = previousMartinLive;
      }

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^loop_[A-Za-z0-9_-]+$/);
      expect(result.stdout).not.toContain("Blocked:");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps CI approval-block output free of interactive prompts", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-approval-ci-"));

    try {
      installChangingRunAdapter(["package.json"]);
      await writeFile(join(directory, "package.json"), '{"name":"approval-ci"}', "utf8");
      initializeCommittedGitRepository(directory);
      const previousMartinLive = process.env.MARTIN_LIVE;
      const previousCi = process.env.CI;
      process.env.MARTIN_LIVE = "false";
      process.env.CI = "1";
      const result = await withIsolatedRunsEnv(directory, () =>
        executeCli([
          "run",
          "--objective",
          "Update a dependency only when approval is present",
          "--engine",
          "codex",
          "--verify",
          `"${process.execPath}" -e "process.exit(0)"`,
          "--cwd",
          directory
        ])
      );
      if (previousMartinLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = previousMartinLive;
      }
      if (previousCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = previousCi;
      }

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain("Blocked: the agent needs operator approval to proceed.");
      expect(result.stdout).not.toContain("quick one");
      expect(result.stdout).not.toContain("is martin actually earning its keep");
      expect(result.stderr).toBe("");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps non-TTY approval-block output free of interactive prompts", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-approval-nontty-"));
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

    try {
      installChangingRunAdapter(["package.json"]);
      await writeFile(join(directory, "package.json"), '{"name":"approval-nontty"}', "utf8");
      initializeCommittedGitRepository(directory);
      Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
      const previousMartinLive = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";
      const result = await withIsolatedRunsEnv(directory, () =>
        executeCli([
          "run",
          "--objective",
          "Update a dependency only when approval is present",
          "--engine",
          "codex",
          "--verify",
          `"${process.execPath}" -e "process.exit(0)"`,
          "--cwd",
          directory
        ])
      );
      if (previousMartinLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = previousMartinLive;
      }

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain("Blocked: the agent needs operator approval to proceed.");
      expect(result.stdout).not.toContain("quick one");
      expect(result.stdout).not.toContain("is martin actually earning its keep");
      expect(result.stderr).toBe("");
    } finally {
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      } else {
        delete (process.stdout as unknown as Record<string, unknown>)["isTTY"];
      }
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      } else {
        delete (process.stdin as unknown as Record<string, unknown>)["isTTY"];
      }
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("allows dependency changes when the dependency approval flag is present", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-approval-allowed-"));

    try {
      installChangingRunAdapter(["package.json"]);
      await writeFile(join(directory, "package.json"), '{"name":"approval-allowed"}', "utf8");
      initializeCommittedGitRepository(directory);
      const previousMartinLive = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";
      const result = await withIsolatedRunsEnv(directory, () =>
        executeCli([
          "--json",
          "run",
          "--objective",
          "Update an approved dependency",
          "--engine",
          "codex",
          "--verify",
          `"${process.execPath}" -e "process.exit(0)"`,
          "--approve-dependency-changes",
          "--cwd",
          directory
        ])
      );
      if (previousMartinLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = previousMartinLive;
      }

      expect(result.exitCode).toBe(7);
      const payload = JSON.parse(result.stdout);
      expect(payload.loop.task.approvalPolicy).toEqual({ dependencyAdds: true });
      expect(payload.loop.attempts).toHaveLength(1);
      expect(payload.loop.attempts[0]).toMatchObject({
        summary: "Produced a controlled test change."
      });
      expect(payload.loop.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "verification.completed",
            payload: expect.objectContaining({ passed: true })
          })
        ])
      );
      expect(payload.decision.failureClass).not.toBe("safety_leash_blocked");
      expect(payload.decision.reasonCode).not.toBe("dependency_approval_required");
      expect(payload.loop.lifecycleState).toBe("completed");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not add a verified-success CTA to simulated test runs", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-star-cta-json-"));

    try {
      installFastRunAdapter();
      const result = await withIsolatedRunsEnv(directory, () =>
        executeCli([
          "--json",
          "run",
          "--objective",
          "Confirm the success CTA is present",
          "--proof",
          "--cwd",
          directory
        ])
      );

      expect(result.exitCode).toBe(0);

      const payload = JSON.parse(result.stdout);
      expect(payload.proofOutcome).toBe("PROOF_PASSED");
      expect(payload.decision.status).toBe("completed");
      expect(payload.successCallToAction).toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not add a verified-success CTA block to simulated human output", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-star-cta-human-"));

    try {
      installFastRunAdapter();
      const result = await withIsolatedRunsEnv(directory, () =>
        executeCli([
          "run",
          "--objective",
          "Confirm the human success CTA is present",
          "--proof",
          "--cwd",
          directory
        ])
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("proof passed");
      expect(result.stdout).not.toContain(STAR_CTA_HEADLINE);
      expect(result.stdout).not.toContain(`Star the repo: ${STAR_CTA_REPO}`);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not add the star CTA when the run exits on budget failure", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-star-cta-budget-exit-"));

    try {
      installFailingRunAdapter();
      const result = await withIsolatedRunsEnv(directory, () =>
        executeCli([
          "--json",
          "run",
          "--objective",
          "Force a non-success exit",
          "--proof",
          "--max-iterations",
          "1",
          "--cwd",
          directory
        ])
      );

      expect(result.exitCode).toBe(7);

      const payload = JSON.parse(result.stdout);
      expect(payload.proofOutcome).toBe("PROOF_FAILED");
      expect(payload.decision.status).toBe("exited");
      expect(payload.decision.lifecycleState).toBe("budget_exit");
      expect(payload.successCallToAction).toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not add the star CTA when safety escalation blocks the run", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-star-cta-human-escalation-"));

    try {
      const result = await withIsolatedRunsEnv(directory, () =>
        executeCli([
          "--json",
          "run",
          "--objective",
          "Block a destructive verifier command",
          "--proof",
          "--verify",
          "rm -rf .",
          "--cwd",
          directory
        ])
      );

      expect(result.exitCode).toBe(8);

      const payload = JSON.parse(result.stdout);
      expect(payload.decision.status).toBe("exited");
      expect(payload.decision.lifecycleState).toBe("human_escalation");
      expect(payload.successCallToAction).toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("resolves a relative --config path from INIT_CWD for filtered dev runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-init-cwd-"));
    const packageDirectory = join(directory, "packages", "cli");
    const configPath = join(directory, "martin.config.example.yaml");
    const previousCwd = process.cwd();
    const previousInitCwd = process.env.INIT_CWD;
    const previousMarinLive = process.env.MARTIN_LIVE;

    try {
      installFastRunAdapter();
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(
        configPath,
        [
          "policyProfile: strict",
          "budget:",
          "  maxUsd: 12",
          "  softLimitUsd: 7",
          "  maxIterations: 6",
          "  maxTokens: 45000",
          "governance:",
          "  destructiveActionPolicy: approval",
          "  telemetryDestination: control-plane",
          "  verifierRules:",
          "    - pnpm test",
          "    - pnpm lint"
        ].join("\n"),
        "utf8"
      );

      process.chdir(packageDirectory);
      process.env.INIT_CWD = directory;

      process.env.MARTIN_LIVE = "false";
      const result = await withIsolatedRunsEnv(directory, () =>
        executeCli([
          "--json",
          "run",
          "--objective",
          "Repair flaky CI gate",
          "--config",
          ".\\martin.config.example.yaml"
        ])
      );

      expect(result.exitCode).toBe(7);

      const payload = JSON.parse(result.stdout);

      expect(payload.effectivePolicy.configPath).toBe(configPath);
      expect(payload.effectivePolicy.policyProfile).toBe("strict");
      expect(payload.loop.task.verificationPlan).toEqual(["pnpm test", "pnpm lint"]);
    } finally {
      process.chdir(previousCwd);

      if (previousInitCwd === undefined) {
        delete process.env.INIT_CWD;
      } else {
        process.env.INIT_CWD = previousInitCwd;
      }

      if (previousMarinLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = previousMarinLive;
      }

      await rm(directory, { force: true, recursive: true });
    }
  });

  it("prints the public under-$3 benchmark summary from the shipped fixture", async () => {
    const result = await executeCli(["bench", "--suite", "ralphy-smoke"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Under-$3 Challenge");
    expect(result.stdout).toContain("$2.30");
    expect(result.stdout).toContain("$5.20");
    expect(result.stdout).toContain("@martin/benchmarks");
  });

  it("copies the seeded demo workspace into the default target directory", async () => {
    const previousCwd = process.cwd();
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-demo-default-"));

    try {
      process.chdir(directory);

      const result = await executeCli(["demo"]);
      const targetDirectory = join(directory, "martin-loop-demo");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(targetDirectory);
      expect(result.stdout).toContain("npm install");
      expect(result.stdout).toContain("Default first run (live spend-governed):");
      expect(result.stdout).toContain("--budget-usd 2 --max-iterations 1");
      expect(result.stdout).toContain(
        "Optional verification-only run (non-governed; cannot emit VERIFIED):"
      );
      expect(result.stdout).toContain("Task ideas live in");
      expect(await readFile(join(targetDirectory, "README.md"), "utf8")).toContain("Demo Sandbox");
    } finally {
      process.chdir(previousCwd);
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("supports --dir for the demo sandbox target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-demo-dir-"));
    const targetDirectory = join(directory, "custom-demo");

    try {
      const result = await executeCli(["demo", "--dir", targetDirectory]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(targetDirectory);
      expect(await readFile(join(targetDirectory, "package.json"), "utf8")).toContain(
        "martin-loop-demo-sandbox"
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("refuses to overwrite a non-empty demo target without --force", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-demo-blocked-"));
    const targetDirectory = join(directory, "existing demo");

    try {
      await mkdir(targetDirectory, { recursive: true });
      await writeFile(join(targetDirectory, "keep.txt"), "do not replace", "utf8");

      const result = await executeCli(["demo", "--dir", targetDirectory]);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("already exists and is not empty");
      expect(await readFile(join(targetDirectory, "keep.txt"), "utf8")).toBe("do not replace");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("replaces a non-empty demo target when --force is provided", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-demo-force-"));
    const targetDirectory = join(directory, "existing demo");

    try {
      await mkdir(targetDirectory, { recursive: true });
      await writeFile(join(targetDirectory, "keep.txt"), "replace me", "utf8");

      const result = await executeCli(["demo", "--dir", targetDirectory, "--force"]);

      expect(result.exitCode).toBe(0);
      await expect(readFile(join(targetDirectory, "keep.txt"), "utf8")).rejects.toThrow();
      expect(await readFile(join(targetDirectory, "TASKS.md"), "utf8")).toContain("Optional live run");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("handles demo target paths with spaces and prints the guided next steps", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-demo-spaces-"));
    const targetDirectory = join(directory, "demo sandbox with spaces");

    try {
      const result = await executeCli(["demo", "--dir", targetDirectory]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`cd ${targetDirectory}`);
      expect(result.stdout).toContain("Optional live implementation run");
      expect(await readFile(join(targetDirectory, "martin.config.yaml"), "utf8")).toContain(
        "strict_local"
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("inspects loop record files and returns a portfolio summary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-"));
    const filePath = join(directory, "loop.json");

    try {
      const loop = createLoopRecord(
        {
          workspaceId: "ws_ops",
          projectId: "proj_runtime",
          task: {
            title: "Repair the flaky CI gate",
            objective: "Repair the flaky CI gate",
            verificationPlan: ["pnpm test"]
          },
          cost: {
            actualUsd: 3,
            avoidedUsd: 7,
            tokensIn: 1200,
            tokensOut: 450
          }
        },
        {
          now: "2026-03-27T16:00:00.000Z",
          idFactory: (prefix) => `${prefix}_001`
        }
      );

      await writeFile(filePath, JSON.stringify(loop, null, 2), "utf8");

      const result = await executeCli(["--json", "inspect", "--file", filePath]);

      expect(result.exitCode).toBe(0);

      const payload = JSON.parse(result.stdout);

      expect(payload.command).toBe("inspect");
      expect(payload.summary.totalActualUsd).toBe(3);
      expect(payload.summary.totalAvoidedUsd).toBe(7);
      expect(payload.summary.activeLoops).toBe(1);
      expect(payload.source).toBe(filePath);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("inspects persisted JSONL loop records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-jsonl-"));
    const filePath = join(directory, "loops.jsonl");

    try {
      const firstLoop = createLoopRecord({
        workspaceId: "ws_ops",
        projectId: "proj_runtime",
        task: {
          title: "Repair the flaky CI gate",
          objective: "Repair the flaky CI gate",
          verificationPlan: ["pnpm test"]
        },
        cost: {
          actualUsd: 3,
          avoidedUsd: 7,
          tokensIn: 1200,
          tokensOut: 450
        }
      });
      const secondLoop = createLoopRecord({
        workspaceId: "ws_docs",
        projectId: "proj_readme",
        task: {
          title: "Polish release docs",
          objective: "Polish release docs",
          verificationPlan: ["pnpm test"]
        },
        cost: {
          actualUsd: 2,
          avoidedUsd: 5,
          tokensIn: 800,
          tokensOut: 200
        }
      });

      await writeFile(
        filePath,
        `${JSON.stringify(firstLoop)}\n${JSON.stringify(secondLoop)}\n`,
        "utf8"
      );

      const result = await executeCli(["--json", "inspect", "--file", filePath]);

      expect(result.exitCode).toBe(0);

      const payload = JSON.parse(result.stdout);

      expect(payload.command).toBe("inspect");
      expect(payload.summary.totalActualUsd).toBe(5);
      expect(payload.summary.totalAvoidedUsd).toBe(12);
      expect(payload.summary.activeLoops).toBe(2);
      expect(payload.source).toBe(filePath);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
