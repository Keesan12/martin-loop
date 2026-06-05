import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLoopRecord, type LoopEventDraft } from "@martin/contracts";
import { describe, expect, it } from "vitest";

import { executeCli } from "../src/index.js";

function makeLoopRecord() {
  const loop = createLoopRecord({
    workspaceId: "ws_ops",
    projectId: "proj_runtime",
    task: {
      title: "Repair the failing MCP lane",
      objective: "Repair the failing MCP lane",
      verificationPlan: ["pnpm --filter @martinloop/mcp test"]
    },
    budget: {
      maxUsd: 12,
      softLimitUsd: 8,
      maxIterations: 4,
      maxTokens: 12000
    },
    cost: {
      actualUsd: 4.5,
      avoidedUsd: 1.25,
      tokensIn: 900,
      tokensOut: 420
    }
  });

  const attemptId = "att_001";
  const events: LoopEventDraft[] = [
    {
      type: "run.started",
      lifecycleState: "running",
      payload: {
        adapterId: "codex-cli",
        model: "gpt-5-codex"
      }
    },
    {
      type: "verification.completed",
      lifecycleState: "verifying",
      payload: {
        attemptId,
        attemptIndex: 1,
        passed: false,
        summary: "The verification lane still has a failing MCP test."
      }
    }
  ];

  return {
    ...loop,
    status: "failed" as const,
    lifecycleState: "budget_exit" as const,
    updatedAt: "2026-05-16T12:00:00.000Z",
    attempts: [
      {
        attemptId,
        index: 1,
        adapterId: "codex-cli",
        model: "gpt-5-codex",
        startedAt: "2026-05-16T11:45:00.000Z",
        completedAt: "2026-05-16T11:55:00.000Z",
        summary: "Attempted the MCP fix but verification still failed.",
        failureClass: "verification_failure" as const,
        intervention: "run_verifier" as const
      }
    ],
    artifacts: [
      {
        artifactId: "artifact_diff",
        kind: "diff" as const,
        label: "Latest diff",
        uri: "file:///tmp/diff.patch"
      }
    ],
    events: events.map((event, index) => ({
      eventId: `evt_${index + 1}`,
      timestamp: `2026-05-16T11:5${index}:00.000Z`,
      ...event
    }))
  };
}

async function withRunsRoot<T>(fn: (runsRoot: string) => Promise<T>): Promise<T> {
  const previousRunsRoot = process.env.MARTIN_RUNS_DIR;
  const runsRoot = await mkdtemp(join(tmpdir(), "martin-cli-operator-"));
  process.env.MARTIN_RUNS_DIR = runsRoot;

  try {
    return await fn(runsRoot);
  } finally {
    if (previousRunsRoot === undefined) {
      delete process.env.MARTIN_RUNS_DIR;
    } else {
      process.env.MARTIN_RUNS_DIR = previousRunsRoot;
    }

    await rm(runsRoot, { force: true, recursive: true }).catch(() => {});
  }
}

describe.sequential("operator commands", () => {
  it("doctor reports environment readiness and starter MCP tools", async () => {
    const result = await executeCli(["--json", "doctor"]);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe("doctor");
    expect(payload.cliVersion).toBeTypeOf("string");
    expect(payload.profiles.minimal).toContain("martin_list_runs");
    expect(payload.starterTools).toContain("martin_doctor");
    expect(payload.environment.runsRoot).toBeTypeOf("string");
    expect(payload.bestNextCommand).toBeTypeOf("string");
  });

  it("start returns an onboarding plan with host bootstrap guidance", async () => {
    const result = await executeCli(["--json", "start", "--host", "codex"]);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe("start");
    expect(payload.bestNextCommand).toBeTypeOf("string");
    expect(payload.recommendedFlow).toContain("martin doctor");
    expect(payload.hostBootstrap.host).toBe("codex");
    expect(payload.hostBootstrap.printConfigCommand).toContain("--host codex");
  });

  it("tour returns the interactive walkthrough steps", async () => {
    const result = await executeCli(["--json", "tour", "--host", "claude"]);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe("tour");
    expect(payload.steps[0].command).toBe("martin start");
    expect(payload.steps.at(-1).command).toContain("@martinloop/mcp");
  });

  it("blocks governed runs until doctor, session, and preflight receipts exist", async () => {
    await withRunsRoot(async () => {
      const workspace = await mkdtemp(join(tmpdir(), "martin-cli-guarded-"));
      const prevLive = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";

      try {
        const blocked = await executeCli([
          "--json",
          "run",
          "--objective",
          "Repair the failing MCP lane",
          "--cwd",
          workspace,
          "--verify",
          `"${process.execPath}" -e "process.exit(0)"`
        ]);
        const blockedPayload = JSON.parse(blocked.stdout);

        expect(blocked.exitCode).toBe(8);
        expect(blockedPayload.category).toBe("policy_blocked");
        expect(blockedPayload.details.missingSteps).toContain("doctor");

        await executeCli(["--json", "doctor", "--cwd", workspace]);
        await executeCli(["--json", "start", "--cwd", workspace]);
        await executeCli([
          "--json",
          "preflight",
          "--objective",
          "Repair the failing MCP lane",
          "--cwd",
          workspace,
          "--verify",
          `"${process.execPath}" -e "process.exit(0)"`
        ]);

        const allowed = await executeCli([
          "--json",
          "run",
          "--objective",
          "Repair the failing MCP lane",
          "--cwd",
          workspace,
          "--verify",
          `"${process.execPath}" -e "process.exit(0)"`
        ]);
        const allowedPayload = JSON.parse(allowed.stdout);

        expect(allowed.exitCode).toBe(0);
        expect(allowedPayload.command).toBe("run");
        expect(allowedPayload.governance.hardGate).toBe(true);
      } finally {
        if (prevLive === undefined) {
          delete process.env.MARTIN_LIVE;
        } else {
          process.env.MARTIN_LIVE = prevLive;
        }
        await rm(workspace, { force: true, recursive: true }).catch(() => {});
      }
    });
  });

  it("preflight reports blocked state when the working directory is missing", async () => {
    const missingDirectory = join(tmpdir(), "martin-cli-missing", "repo");
    const result = await executeCli([
      "--json",
      "preflight",
      "--objective",
      "Repair the failing MCP lane",
      "--cwd",
      missingDirectory
    ]);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe("preflight");
    expect(payload.ready).toBe(false);
    expect(payload.blockingIssues).toContain("Working directory does not exist.");
  });

  it("loads persisted runs through dossier, attempt, verify, and triage commands", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = makeLoopRecord();
      const loopDir = join(runsRoot, loop.loopId);
      await mkdir(loopDir, { recursive: true });
      await writeFile(join(loopDir, "loop-record.json"), JSON.stringify(loop, null, 2), "utf8");
      await writeFile(
        join(runsRoot, `${loop.workspaceId}.jsonl`),
        `${JSON.stringify({ loopId: loop.loopId, status: loop.status, updatedAt: loop.updatedAt })}\n`,
        "utf8"
      );

      const dossier = JSON.parse((await executeCli(["--json", "dossier", "--loop-id", loop.loopId])).stdout);
      const attempt = JSON.parse(
        (await executeCli(["--json", "runs", "attempt", "--loop-id", loop.loopId])).stdout
      );
      const verify = JSON.parse(
        (await executeCli(["--json", "runs", "verify", "--loop-id", loop.loopId])).stdout
      );
      const triage = JSON.parse((await executeCli(["--json", "triage"])).stdout);

      expect(dossier.command).toBe("dossier");
      expect(dossier.loop.loopId).toBe(loop.loopId);
      expect(dossier.verification.status).toBe("failed");
      expect(dossier.receipt.whatMartinPrevented).toContain("false success claims after a failed verifier");
      expect(dossier.receipt.tokenWasteReceipt.estimateLabel).toContain("directional local estimates");
      expect(attempt.command).toBe("runs_attempt");
      expect(attempt.attempt.index).toBe(1);
      expect(verify.command).toBe("runs_verify");
      expect(verify.verification.summary).toContain("verification lane");
      expect(triage.command).toBe("triage");
      expect(triage.findings[0].loopId).toBe(loop.loopId);
      expect(triage.findings[0].reasons).toContain("verification_failed");
    });
  });

  it("prints dry-run MCP host config for Codex, Claude, Gemini, and generic wrapper hosts", async () => {
    const codex = JSON.parse(
      (
        await executeCli([
          "--json",
          "mcp",
          "install",
          "--host",
          "codex",
          "--scope",
          "project",
          "--dry-run",
          "--transport",
          "remote"
        ])
      ).stdout
    );
    const claude = JSON.parse(
      (await executeCli(["--json", "mcp", "print-config", "--host", "claude", "--scope", "project"])).stdout
    );
    const gemini = JSON.parse(
      (
        await executeCli([
          "--json",
          "mcp",
          "print-config",
          "--host",
          "gemini",
          "--scope",
          "project",
          "--transport",
          "remote",
          "--profile",
          "starter"
        ])
      ).stdout
    );
    const generic = JSON.parse(
      (
        await executeCli([
          "--json",
          "mcp",
          "print-config",
          "--host",
          "generic",
          "--scope",
          "project",
          "--profile",
          "full",
          "--platform",
          "linux"
        ])
      ).stdout
    );

    expect(codex.command).toBe("mcp_install");
    expect(codex.dryRun).toBe(true);
    expect(codex.transport).toBe("remote");
    expect(codex.content).toContain('[mcp_servers."martin-loop-remote"]');
    expect(codex.content).toContain("enabled_tools");
    expect(claude.command).toBe("mcp_print_config");
    expect(claude.content).toContain("\"martin-loop\"");
    expect(claude.content).toContain("\"MARTIN_RUNS_DIR\"");
    expect(gemini.command).toBe("mcp_print_config");
    expect(gemini.content).toContain("\"httpUrl\"");
    expect(gemini.content).toContain("\"includeTools\"");
    expect(generic.command).toBe("mcp_print_config");
    expect(generic.content).toContain("\"host\": \"generic\"");
    expect(generic.enabledTools).toContain("martin_get_verification_results");
  });

  it("prints a Claude local-scope install command instead of a guessed config file path", async () => {
    const claudeLocal = JSON.parse(
      (
        await executeCli([
          "--json",
          "mcp",
          "print-config",
          "--host",
          "claude",
          "--scope",
          "local",
          "--transport",
          "remote"
        ])
      ).stdout
    );

    expect(claudeLocal.command).toBe("mcp_print_config");
    expect(claudeLocal.scope).toBe("local");
    expect(claudeLocal.installMethod).toBe("command");
    expect(claudeLocal.targetPath).toContain("Claude Code local scope");
    expect(claudeLocal.content).toContain("claude mcp add --transport http --scope local");
  });

  it("rejects invalid MCP host and scope values instead of silently falling back", async () => {
    const invalidHost = await executeCli(["mcp", "print-config", "--host", "vscode"]);
    const invalidScope = await executeCli(["mcp", "install", "--host", "codex", "--scope", "workspace"]);
    const invalidLocalScope = await executeCli(["mcp", "install", "--host", "codex", "--scope", "local"]);
    const invalidTransport = await executeCli(["mcp", "print-config", "--host", "codex", "--transport", "sse"]);
    const invalidProfile = await executeCli(["mcp", "print-config", "--host", "codex", "--profile", "dense"]);
    const invalidPlatform = await executeCli(["mcp", "print-config", "--host", "codex", "--platform", "bsd"]);
    const missingHost = await executeCli(["mcp", "print-config"]);

    expect(invalidHost.exitCode).toBe(2);
    expect(invalidHost.stderr).toContain("Invalid --host value");
    expect(invalidScope.exitCode).toBe(2);
    expect(invalidScope.stderr).toContain("Invalid --scope value");
    expect(invalidLocalScope.exitCode).toBe(2);
    expect(invalidLocalScope.stderr).toContain("does not support --scope local");
    expect(invalidTransport.exitCode).toBe(2);
    expect(invalidTransport.stderr).toContain("Invalid --transport value");
    expect(invalidProfile.exitCode).toBe(2);
    expect(invalidProfile.stderr).toContain("Invalid --profile value");
    expect(invalidPlatform.exitCode).toBe(2);
    expect(invalidPlatform.stderr).toContain("Invalid --platform value");
    expect(missingHost.exitCode).toBe(2);
    expect(missingHost.stderr).toContain("require --host");
  });
});

describe("challenge command", () => {
  it("renders a seeded challenge proof card without requiring a persisted run", async () => {
    const result = await executeCli(["challenge"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Martin Loop Under-$3 Challenge");
    expect(result.stdout).toContain("$2.30");
    expect(result.stdout).toContain("$3.00");
    expect(result.stdout).toContain("passed");
    expect(result.stdout).toContain("Martin stopped Ralph here.");
    expect(result.stdout).not.toMatch(/[A-Z]:\\/);
  });

  it("renders challenge proof cards from persisted runs as JSON", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = makeLoopRecord();
      const loopDir = join(runsRoot, loop.loopId);
      await mkdir(loopDir, { recursive: true });
      await writeFile(join(loopDir, "loop-record.json"), JSON.stringify(loop, null, 2), "utf8");

      const result = await executeCli(["--json", "challenge", "--loop-id", loop.loopId]);
      const payload = JSON.parse(result.stdout) as { command: string; card: { loopId: string }; markdown: string };

      expect(result.exitCode).toBe(0);
      expect(payload.command).toBe("challenge");
      expect(payload.card.loopId).toBe(loop.loopId);
      expect(payload.markdown).toContain("Repair the failing MCP lane");
      expect(payload.markdown).not.toContain(runsRoot);
    });
  });
});

describe("badge command", () => {
  it("renders an OSS reliability badge as SVG without autonomy claims", async () => {
    const result = await executeCli(["badge", "--format", "svg"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("<svg");
    expect(result.stdout).toContain("agent reliability");
    expect(result.stdout).not.toContain("full autonomy");
    expect(result.stdout).not.toContain("self-learning");
    expect(result.stdout).not.toMatch(/[A-Z]:\\/);
  });
});
