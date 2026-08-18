import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStubDirectProviderAdapter } from "@martin/adapters";
import { afterEach, describe, expect, it } from "vitest";

import { createLoopRecord } from "../../contracts/src/index.js";
import { __setRunAdapterOverrideForTests, executeCli, parseCliArguments } from "../src/index.js";

const STAR_CTA_HEADLINE = "⭐ MartinLoop produced a verified handoff.";
const STAR_CTA_REPO = "github.com/Keesan12/martin-loop";

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

afterEach(() => {
  __setRunAdapterOverrideForTests(undefined);
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
      "--soft-limit-usd",
      "9.5",
      "--max-iterations",
      "4",
      "--max-tokens",
      "60000",
      "--verify-timeout-ms",
      "240000",
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
      installGovernance: false
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
  it("prints runs verify help with --latest selector support", async () => {
    const result = await executeCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Your coding agent says it's done. MartinLoop makes it prove it.");
    expect(result.stdout).toContain("Apache 2.0 · martinloop.com · github.com/Keesan12/martin-loop");
    expect(result.stdout).toContain("martin start [options]");
    expect(result.stdout).toContain("martin receipts explain");
    expect(result.stdout).toContain("martin runs verify (--loop-id <id> | --file <path> | --latest) [options]");
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
      /martin enable --engine (claude|codex|gemini|openai) --verify "(npm|pnpm) test" --budget-usd 2 --max-iterations 1/u
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
          "--verify-only",
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
          "--verify-only",
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
          "--verify-only",
          "--verify",
          `"${process.execPath}" -e "process.exit(0)"`,
          "--verify-timeout-ms",
          "240000",
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
    } finally {
      await rm(directory, { force: true, recursive: true });
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

      expect(result.exitCode).toBe(7);

      const payload = JSON.parse(result.stdout);
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

      expect(result.exitCode).toBe(7);

      const payload = JSON.parse(result.stdout);
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

      expect(result.exitCode).toBe(7);
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

      expect(result.exitCode).toBe(9);

      const payload = JSON.parse(result.stdout);
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

      expect(result.exitCode).toBe(9);

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
