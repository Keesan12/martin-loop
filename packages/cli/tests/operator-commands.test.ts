import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeReceiptIntegrityMaterial } from "@martin/core";
import { createLoopRecord, type LoopEventDraft, type LoopRecord } from "@martin/contracts";
import { describe, expect, it } from "vitest";

import { executeCli } from "../src/index.js";

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

function makeLoopRecord(): LoopRecord {
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
  const events: Array<LoopEventDraft & { lifecycleState: LoopRecord["lifecycleState"] }> = [
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
  const previousGroundingDir = process.env.MARTIN_GROUNDING_DIR;
  const root = await mkdtemp(join(tmpdir(), "martin-cli-operator-"));
  const runsRoot = join(root, "runs");
  const groundingDir = join(root, "grounding");
  await mkdir(runsRoot, { recursive: true });
  await mkdir(groundingDir, { recursive: true });
  process.env.MARTIN_RUNS_DIR = runsRoot;
  process.env.MARTIN_GROUNDING_DIR = groundingDir;

  try {
    return await fn(runsRoot);
  } finally {
    if (previousRunsRoot === undefined) {
      delete process.env.MARTIN_RUNS_DIR;
    } else {
      process.env.MARTIN_RUNS_DIR = previousRunsRoot;
    }

    if (previousGroundingDir === undefined) {
      delete process.env.MARTIN_GROUNDING_DIR;
    } else {
      process.env.MARTIN_GROUNDING_DIR = previousGroundingDir;
    }

    await rm(root, { force: true, recursive: true }).catch(() => {});
  }
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

describe("operator commands", () => {
  it("doctor reports environment readiness and starter MCP tools", async () => {
    const result = await withEnv("MARTIN_LIVE", "false", () => executeCli(["--json", "doctor"]));
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe("doctor");
    expect(payload.cliVersion).toBeTypeOf("string");
    expect(payload.profiles.minimal).toContain("martin_list_runs");
    expect(payload.starterTools).toContain("martin_doctor");
    expect(payload.environment.runsRoot).toBeTypeOf("string");
    expect(payload.receiptScope).toEqual(payload.scope);
    expect(payload.scope.invocationRoot).toBeTypeOf("string");
    expect(payload.scope.repoRoot).toBe(payload.environment.workingDirectory);
    expect(payload.scope.runsRoot).toBe(payload.environment.runsRoot);
    expect(payload.engines.openai).toMatchObject({
      available: true,
      baseUrl: "https://api.openai.com",
      model: "gpt-4.1-mini",
      apiKeyConfigured: false,
      authPosture: "anonymous_or_local"
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
    expect(payload.receiptScope).toEqual(payload.scope);
    expect(payload.scope.workingDirectory).toBe(missingDirectory);
    expect(payload.scope.repoRoot).toBe(missingDirectory);
    expect(payload.scope.runsRoot).toBeTypeOf("string");
  });

  it("adds actionable OpenAI preflight blockers when auth is missing on hosted endpoints", async () => {
    const previousApiKey = process.env.MARTIN_OPENAI_API_KEY;
    const previousBaseUrl = process.env.MARTIN_OPENAI_BASE_URL;
    const previousModel = process.env.MARTIN_OPENAI_MODEL;
    delete process.env.MARTIN_OPENAI_API_KEY;
    delete process.env.MARTIN_OPENAI_BASE_URL;
    delete process.env.MARTIN_OPENAI_MODEL;

    try {
      const result = await executeCli([
        "--json",
        "preflight",
        "--objective",
        "Repair the failing MCP lane",
        "--engine",
        "openai"
      ]);
      const payload = JSON.parse(result.stdout);

      expect(result.exitCode).toBe(0);
      expect(payload.command).toBe("preflight");
      expect(payload.ready).toBe(false);
      expect(payload.blockingIssues.join(" ")).toContain("MARTIN_OPENAI_API_KEY");
      expect(payload.warnings.join(" ")).toContain("MARTIN_OPENAI_MODEL");
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.MARTIN_OPENAI_API_KEY;
      } else {
        process.env.MARTIN_OPENAI_API_KEY = previousApiKey;
      }
      if (previousBaseUrl === undefined) {
        delete process.env.MARTIN_OPENAI_BASE_URL;
      } else {
        process.env.MARTIN_OPENAI_BASE_URL = previousBaseUrl;
      }
      if (previousModel === undefined) {
        delete process.env.MARTIN_OPENAI_MODEL;
      } else {
        process.env.MARTIN_OPENAI_MODEL = previousModel;
      }
    }
  });

  it("rejects path-traversing allow/deny patterns during preflight", async () => {
    const traversalAllow = await executeCli([
      "preflight",
      "--objective",
      "Repair the failing MCP lane",
      "--allow-path",
      "..\\..\\*"
    ]);
    const traversalDeny = await executeCli([
      "preflight",
      "--objective",
      "Repair the failing MCP lane",
      "--deny-path",
      "..\\..\\*"
    ]);

    expect(traversalAllow.exitCode).toBe(2);
    expect(traversalAllow.stderr).toContain("Invalid allowedPaths.");
    expect(traversalDeny.exitCode).toBe(2);
    expect(traversalDeny.stderr).toContain("Invalid deniedPaths.");
  });

  it("preserves explicit --runs-dir overrides for preflight commands after the objective token", async () => {
    await withRunsRoot(async (runsRoot) => {
      const workingDirectory = await mkdtemp(join(tmpdir(), "martin-cli-preflight-workspace-"));
      const narrowedRunsRoot = join(runsRoot, "team-a");

      try {
        const result = await executeCli([
          "--json",
          "preflight",
          "Repair the failing MCP lane",
          "--cwd",
          workingDirectory,
          "--runs-dir",
          narrowedRunsRoot
        ]);
        const payload = JSON.parse(result.stdout);

        expect(result.exitCode).toBe(0);
        expect(payload.environment.workingDirectory).toBe(workingDirectory);
        expect(payload.environment.runsRoot).toBe(narrowedRunsRoot);
        expect(payload.receiptScope.runsRoot).toBe(narrowedRunsRoot);
      } finally {
        await rm(workingDirectory, { force: true, recursive: true }).catch(() => {});
      }
    });
  });

  it("blocks live run execution before spend when the governed receipt chain is missing", { timeout: 45000 }, async () => {
    await withRunsRoot(async () => {
      const result = await withoutAgentCliOnPath(() =>
        executeCli([
          "run",
          "--objective",
          "Repair the failing MCP lane",
          "--engine",
          "codex",
          "--verify",
          "pnpm --filter @martinloop/mcp test",
          "--budget-usd",
          "2",
          "--max-iterations",
          "1"
        ])
      );

      expect(result.exitCode).toBe(8);
      expect(result.stderr).toContain("Governed run preflight blocked execution");
      expect(result.stderr).toContain("martin-loop preflight");
    });
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
      expect(dossier.loop.receiptIntegrity.state).toBe("unsigned");
      expect(dossier.verification.status).toBe("failed");
      expect(dossier.verification.warnings).toContain(
        "Receipt integrity is unsigned; persisted verifier evidence is not trustworthy yet."
      );
      expect(dossier.receipt.trustworthy).toBe(false);
      expect(dossier.receipt.whatMartinPrevented).toContain(
        "trust claim unavailable until receipt integrity verifies"
      );
      expect(dossier.receipt.tokenWasteReceipt.estimateLabel).toContain("not trustworthy");
      expect(attempt.command).toBe("runs_attempt");
      expect(attempt.attempt.index).toBe(1);
      expect(verify.command).toBe("runs_verify");
      expect(verify.verification.summary).toContain("verification lane");
      expect(triage.command).toBe("triage");
      expect(triage.findings[0].loopId).toBe(loop.loopId);
      expect(triage.findings[0].reasons).toContain("verification_failed");
    });
  });

  it("fails closed on tampered canonical receipts and surfaces receipt scope on persisted-run commands", async () => {
    await withRunsRoot(async (runsRoot) => {
      const repoRoot = join(runsRoot, "workspace");
      const workingDirectory = join(repoRoot, "packages", "cli");
      const baseLoop = makeLoopRecord();
      const loop = {
        ...baseLoop,
        task: {
          ...baseLoop.task,
          repoRoot
        },
        receiptScope: {
          repoRoot,
          workingDirectory,
          invocationRoot: repoRoot,
          runsRoot
        }
      };
      const loopDir = join(runsRoot, loop.loopId);
      const loopRecordPath = join(loopDir, "loop-record.json");
      const ledgerPath = join(loopDir, "ledger.jsonl");
      const ledgerEntries = loop.events;

      await mkdir(loopDir, { recursive: true });
      await writeFile(loopRecordPath, JSON.stringify(loop, null, 2), "utf8");
      await writeFile(
        ledgerPath,
        ledgerEntries.map((entry) => JSON.stringify(entry)).join("\n").concat("\n"),
        "utf8"
      );
      await writeReceiptIntegrityMaterial({
        runId: loop.loopId,
        runsRoot,
        loopRecord: loop,
        ledgerEntries,
        scope: loop.receiptScope,
        signedAt: loop.updatedAt
      });

      const tamperedLoop = {
        ...loop,
        status: "completed" as const,
        updatedAt: "2026-05-16T12:05:00.000Z"
      };
      await writeFile(loopRecordPath, JSON.stringify(tamperedLoop, null, 2), "utf8");

      const dossier = JSON.parse((await executeCli(["--json", "dossier", "--loop-id", loop.loopId])).stdout);
      const getRun = JSON.parse((await executeCli(["--json", "runs", "get", "--loop-id", loop.loopId])).stdout);
      const verify = JSON.parse(
        (await executeCli(["--json", "runs", "verify", "--loop-id", loop.loopId])).stdout
      );

      for (const payload of [dossier, getRun, verify]) {
        expect(payload.receiptIntegrity.state).toBe("tamper_detected");
        expect(payload.receiptScope).toMatchObject({
          repoRoot,
          workingDirectory,
          invocationRoot: repoRoot,
          runsRoot
        });
      }

      expect(dossier.receipt.receiptScope).toMatchObject({
        repoRoot,
        workingDirectory,
        invocationRoot: repoRoot,
        runsRoot
      });
      expect(dossier.receipt.trustworthy).toBe(false);
      expect(dossier.verification.warnings).toContain(
        "Receipt integrity is tamper_detected; persisted verifier evidence is not trustworthy yet."
      );
      expect(dossier.warnings).toContain(
        "Receipt integrity is tamper_detected; persisted verifier evidence is not trustworthy yet."
      );
      expect(getRun.warnings).toContain(
        "Receipt integrity is tamper_detected; persisted verifier evidence is not trustworthy yet."
      );
      expect(verify.warnings).toContain(
        "Receipt integrity is tamper_detected; persisted verifier evidence is not trustworthy yet."
      );
    });
  });

  it("classifies missing run integrity material explicitly in runs verify", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = makeLoopRecord();
      const loopDir = join(runsRoot, loop.loopId);
      await mkdir(loopDir, { recursive: true });
      await writeFile(join(loopDir, "loop-record.json"), JSON.stringify(loop, null, 2), "utf8");

      const verify = JSON.parse(
        (await executeCli(["--json", "runs", "verify", "--loop-id", loop.loopId])).stdout
      );

      expect(verify.command).toBe("runs_verify");
      expect(verify.verification.integrity.status).toBe("failed");
      expect(verify.verification.integrity.classification).toBe("missing_integrity_material");
    });
  });

  it("classifies tampered payloads explicitly in runs verify", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = makeLoopRecord();
      const loopDir = join(runsRoot, loop.loopId);
      const loopRecordContents = JSON.stringify(loop, null, 2);
      const eventsContents = `${JSON.stringify(loop.events[0])}\n${JSON.stringify(loop.events[1])}\n`;
      await mkdir(loopDir, { recursive: true });
      await writeFile(join(loopDir, "loop-record.json"), loopRecordContents, "utf8");
      await writeFile(join(loopDir, "events.jsonl"), eventsContents, "utf8");
      await writeFile(
        join(loopDir, "receipt-integrity.json"),
        JSON.stringify(
          {
            schemaVersion: "martin.receipt-integrity.v1",
            runId: loop.loopId,
            keyId: "test-key",
            signedAt: loop.updatedAt,
            scope: {
              invocationRoot: runsRoot,
              workingDirectory: runsRoot,
              repoRoot: runsRoot,
              runsRoot
            },
            loopRecordSha256: "0000000000000000000000000000000000000000000000000000000000000000",
            ledgerSha256: sha256(eventsContents),
            ledgerHeadHash: "head-hash",
            entryCount: loop.events.length,
            chain: [],
            signatureHmacSha256: "signature"
          },
          null,
          2
        ),
        "utf8"
      );

      const verify = JSON.parse(
        (await executeCli(["--json", "runs", "verify", "--loop-id", loop.loopId])).stdout
      );

      expect(verify.command).toBe("runs_verify");
      expect(verify.verification.integrity.status).toBe("failed");
      expect(verify.verification.integrity.classification).toBe("tampered_payload");
    });
  });

  it("classifies unknown receipt-integrity fields explicitly in runs verify", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = makeLoopRecord();
      const loopDir = join(runsRoot, loop.loopId);
      const loopRecordContents = JSON.stringify(loop, null, 2);
      const eventsContents = `${JSON.stringify(loop.events[0])}\n${JSON.stringify(loop.events[1])}\n`;
      await mkdir(loopDir, { recursive: true });
      await writeFile(join(loopDir, "loop-record.json"), loopRecordContents, "utf8");
      await writeFile(join(loopDir, "events.jsonl"), eventsContents, "utf8");
      await writeFile(
        join(loopDir, "receipt-integrity.json"),
        JSON.stringify(
          {
            schemaVersion: "martin.receipt-integrity.v1",
            runId: loop.loopId,
            keyId: "test-key",
            signedAt: loop.updatedAt,
            scope: {
              invocationRoot: runsRoot,
              workingDirectory: runsRoot,
              repoRoot: runsRoot,
              runsRoot
            },
            loopRecordSha256: sha256(loopRecordContents),
            ledgerSha256: sha256(eventsContents),
            ledgerHeadHash: "head-hash",
            entryCount: loop.events.length,
            chain: [],
            signatureHmacSha256: "signature",
            hiddenProbeField: "should-be-rejected"
          },
          null,
          2
        ),
        "utf8"
      );

      const verify = JSON.parse(
        (await executeCli(["--json", "runs", "verify", "--loop-id", loop.loopId])).stdout
      );

      expect(verify.command).toBe("runs_verify");
      expect(verify.verification.integrity.status).toBe("failed");
      expect(verify.verification.integrity.classification).toBe("schema_unknown_fields");
    });
  });

  it("rejects non-canonical selector file paths for run verification", async () => {
    await withRunsRoot(async () => {
      const externalRunsRoot = await mkdtemp(join(tmpdir(), "martin-cli-external-run-"));
      const loop = makeLoopRecord();
      const loopDir = join(externalRunsRoot, loop.loopId);
      await mkdir(loopDir, { recursive: true });
      await writeFile(join(loopDir, "loop-record.json"), JSON.stringify(loop, null, 2), "utf8");

      try {
        const verify = await executeCli([
          "runs",
          "verify",
          "--file",
          join(loopDir, "loop-record.json")
        ]);
        expect(verify.exitCode).toBe(2);
        expect(verify.stderr).toContain("canonical run selector");
      } finally {
        await rm(externalRunsRoot, { recursive: true, force: true });
      }
    });
  });

  it("reports unsigned for ad-hoc --file loads outside the selected runs root without minting a new local key", async () => {
    const externalRunsRoot = await mkdtemp(join(tmpdir(), "martin-cli-external-runs-"));

    try {
      const loop = makeLoopRecord();
      const externalLoopDir = join(externalRunsRoot, loop.loopId);
      const loopRecordPath = join(externalLoopDir, "loop-record.json");
      const ledgerPath = join(externalLoopDir, "ledger.jsonl");
      const ledgerEntries = loop.events;

      await mkdir(externalLoopDir, { recursive: true });
      await writeFile(loopRecordPath, JSON.stringify(loop, null, 2), "utf8");
      await writeFile(
        ledgerPath,
        ledgerEntries.map((entry) => JSON.stringify(entry)).join("\n").concat("\n"),
        "utf8"
      );
      await writeReceiptIntegrityMaterial({
        runId: loop.loopId,
        runsRoot: externalRunsRoot,
        loopRecord: loop,
        ledgerEntries,
        signedAt: loop.updatedAt
      });
      await expect(
        readFile(join(externalLoopDir, "receipt-integrity.json"), "utf8")
      ).resolves.toContain("signatureHmacSha256");

      await withRunsRoot(async (selectedRunsRoot) => {
        const dossier = JSON.parse(
          (await executeCli(["--json", "dossier", "--file", externalLoopDir])).stdout
        );
        const getRun = JSON.parse(
          (await executeCli(["--json", "runs", "get", "--file", externalLoopDir])).stdout
        );

        expect(dossier.receiptIntegrity.state).toBe("unsigned");
        expect(getRun.receiptIntegrity.state).toBe("unsigned");
        await expect(readFile(join(selectedRunsRoot, ".integrity-key"), "utf8")).rejects.toThrow();
      });
    } finally {
      await rm(externalRunsRoot, { force: true, recursive: true }).catch(() => {});
    }
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
    expect(invalidLocalScope.stderr).toContain("--scope user");
    expect(invalidLocalScope.stderr).toContain("--scope project");
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
      const payload = JSON.parse(result.stdout) as {
        command: string;
        card: { loopId: string; completeEvidence: boolean };
        markdown: string;
      };

      expect(result.exitCode).toBe(0);
      expect(payload.command).toBe("challenge");
      expect(payload.card.loopId).toBe(loop.loopId);
      expect(payload.card.completeEvidence).toBe(false);
      expect(payload.markdown).toContain("Repair the failing MCP lane");
      expect(payload.markdown).toContain(
        "Receipt integrity unavailable: Martin proof is not yet trustworthy."
      );
      expect(payload.markdown).not.toContain("Martin stopped Ralph here.");
      expect(payload.markdown).not.toContain(runsRoot);
    });
  });
});

describe("share command", () => {
  it("writes a shareable receipt bundle for the latest persisted run", async () => {
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

      const result = await executeCli(["--json", "share", "--latest"]);
      const payload = JSON.parse(result.stdout) as {
        command: string;
        loopId: string;
        outputDir: string;
        files: {
          receiptJson: string;
          receiptMarkdown: string;
          proofCardSvg: string;
        };
      };

      expect(result.exitCode).toBe(0);
      expect(payload.command).toBe("share");
      expect(payload.loopId).toBe(loop.loopId);
      expect(payload.outputDir).toBe(join(loopDir, "share"));

      const receiptJson = await readFile(payload.files.receiptJson, "utf8");
      const receiptMarkdown = await readFile(payload.files.receiptMarkdown, "utf8");
      const proofCardSvg = await readFile(payload.files.proofCardSvg, "utf8");

      expect(receiptJson).toContain('"schemaVersion": "martin.share-receipt.v1"');
      expect(receiptJson).toContain('"loopId": "loop_');
      expect(receiptJson).not.toContain(runsRoot);
      expect(receiptJson).not.toContain("file:///tmp/diff.patch");
      expect(receiptJson).toContain("[redacted-path]/diff.patch");
      expect(receiptMarkdown).toContain("# Martin Loop Share Receipt");
      expect(receiptMarkdown).toContain("Receipt integrity unavailable: Martin proof is not yet trustworthy.");
      expect(receiptMarkdown).not.toContain(runsRoot);
      expect(proofCardSvg).toContain("Martin Loop Proof Card");
      expect(proofCardSvg).not.toContain(runsRoot);
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

  it("marks the badge as missing verified receipts when the latest persisted run is unsigned", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = makeLoopRecord();
      const loopDir = join(runsRoot, loop.loopId);
      await mkdir(loopDir, { recursive: true });
      await writeFile(join(loopDir, "loop-record.json"), JSON.stringify(loop, null, 2), "utf8");

      const result = await executeCli(["--json", "badge"]);
      const payload = JSON.parse(result.stdout) as {
        command: string;
        score: { missingReasons: string[]; points: number; grade: string };
      };

      expect(result.exitCode).toBe(0);
      expect(payload.command).toBe("badge");
      expect(payload.score.points).toBeLessThan(100);
      expect(payload.score.missingReasons).toContain(
        "Verified run receipts present: Latest persisted run receipt integrity is unsigned."
      );
    });
  });
});
