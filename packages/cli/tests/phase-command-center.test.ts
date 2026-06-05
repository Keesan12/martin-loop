import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { executeCli, parseCliArguments } from "../src/index.js";
import { createNativePhaseCommandCenterSnapshot } from "../src/phase-command-center.js";

async function createPhaseFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "martin-phase-cli-"));
  const runsDir = join(rootDir, "runs");

  await mkdir(join(rootDir, ".gsd"), { recursive: true });
  await mkdir(join(runsDir, "loop_complete"), { recursive: true });
  await mkdir(join(runsDir, "loop_needs_triage"), { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      scripts: {
        test: "vitest run",
        lint: "tsc -p tsconfig.json --noEmit"
      }
    }),
    "utf8"
  );
  await writeFile(join(rootDir, ".gsd", "PLAN.md"), "# Local Command Center\n\nBuild the native flow.\n", "utf8");
  await writeFile(
    join(rootDir, ".gsd", "state.json"),
    JSON.stringify({
      activePhase: "phase-command-center",
      state: "ready_for_preflight"
    }),
    "utf8"
  );
  await writeFile(
    join(rootDir, ".gsd", "martin-contract.json"),
    JSON.stringify({
      objective: "Build the local command center",
      allowedPaths: ["packages/cli/src/**", "packages/cli/tests/**"],
      blockedPaths: ["public/**"],
      verifiers: ["pnpm --filter @martin/cli test"],
      budget: {
        maxUsd: 5,
        maxIterations: 2
      }
    }),
    "utf8"
  );
  await writeFile(join(rootDir, ".gsd", "session-start.json"), JSON.stringify({ enabled: true }), "utf8");
  await writeFile(
    join(runsDir, "loop_complete", "loop-record.json"),
    JSON.stringify({
      loopId: "loop_complete",
      status: "completed",
      lifecycleState: "completed",
      task: { title: "Finished run" },
      cost: { actualUsd: 0.25 },
      events: [{ type: "verification.completed", payload: { passed: true } }],
      createdAt: "2026-05-30T10:00:00.000Z",
      updatedAt: "2026-05-30T10:00:00.000Z"
    }),
    "utf8"
  );
  await writeFile(
    join(runsDir, "loop_needs_triage", "loop-record.json"),
    JSON.stringify({
      loopId: "loop_needs_triage",
      status: "exited",
      lifecycleState: "human_escalation",
      task: { title: "Needs triage" },
      cost: { actualUsd: 0 },
      events: [{ type: "verification.completed", payload: { passed: false } }],
      createdAt: "2026-05-30T11:00:00.000Z",
      updatedAt: "2026-05-30T11:00:00.000Z"
    }),
    "utf8"
  );
  await mkdir(join(runsDir, "loop_invalid_dates"), { recursive: true });
  await writeFile(
    join(runsDir, "loop_invalid_dates", "loop-record.json"),
    JSON.stringify({
      loopId: "loop_invalid_dates",
      status: "completed",
      lifecycleState: "completed",
      task: { title: "Invalid timestamp run" },
      cost: { actualUsd: 0.05 },
      events: [{ type: "verification.completed", payload: { passed: true } }],
      createdAt: "not-a-date",
      updatedAt: "still-not-a-date"
    }),
    "utf8"
  );

  return { rootDir, runsDir };
}

describe("native phase command center", () => {
  it("parses session-start and phase commands", () => {
    expect(parseCliArguments(["session-start", "--host", "claude"])).toEqual({
      command: "native_phase",
      subcommand: "session-start",
      host: "claude",
      execute: false
    });
    expect(parseCliArguments(["phase", "run", "--execute", "--run-scan-limit", "5"])).toEqual({
      command: "native_phase",
      subcommand: "run",
      runScanLimit: 5,
      execute: true
    });
  });

  it("keeps gsd as a compatibility command alias", () => {
    expect(parseCliArguments(["gsd", "run", "--execute", "--run-scan-limit", "5"])).toEqual({
      command: "native_phase",
      subcommand: "run",
      runScanLimit: 5,
      execute: true
    });
  });

  it("builds a local phase contract from repo state and run receipts", async () => {
    const { rootDir, runsDir } = await createPhaseFixture();

    try {
      const snapshot = await createNativePhaseCommandCenterSnapshot({ rootDir, runsDir, host: "claude" });

      expect(snapshot.phaseWorkspace.available).toBe(true);
      expect(snapshot.phaseWorkspace.activePhase).toBe("phase-command-center");
      expect(snapshot.contract.requiresApproval).toBe(false);
      expect(snapshot.contract.objective).toBe("Build the local command center");
      expect(snapshot.contract.allowedPaths).toEqual(["packages/cli/src/**", "packages/cli/tests/**"]);
      expect(snapshot.runStore.latestRun?.loopId).toBe("loop_needs_triage");
      expect(snapshot.runStore.runsNeedingTriage.map((run) => run.loopId)).toEqual(["loop_needs_triage"]);
      expect(snapshot.runStore.totalRuns).toBe(3);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("emits dry-run preflight and run invocations by default", async () => {
    const { rootDir, runsDir } = await createPhaseFixture();

    try {
      const preflight = await executeCli([
        "--json",
        "phase",
        "preflight",
        "--cwd",
        rootDir,
        "--runs-dir",
        runsDir
      ]);
      const run = await executeCli(["--json", "phase", "run", "--cwd", rootDir, "--runs-dir", runsDir]);

      expect(preflight.exitCode).toBe(0);
      expect(run.exitCode).toBe(0);

      const preflightPayload = JSON.parse(preflight.stdout);
      const runPayload = JSON.parse(run.stdout);

      expect(preflightPayload.ok).toBe(true);
      expect(preflightPayload.invocation.executed).toBe(false);
      expect(preflightPayload.invocation.command.slice(0, 3)).toEqual([
        "martin-loop",
        "preflight",
        "Build the local command center"
      ]);
      expect(runPayload.ok).toBe(true);
      expect(runPayload.invocation.command.slice(0, 2)).toEqual(["martin-loop", "run"]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("fails closed when phase safeguards are missing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "martin-phase-cli-missing-"));

    try {
      const result = await executeCli(["--json", "phase", "run", "--cwd", rootDir, "--runs-dir", join(rootDir, "runs")]);
      const payload = JSON.parse(result.stdout);

      expect(result.exitCode).toBe(0);
      expect(payload.ok).toBe(false);
      expect(payload.blocked).toBe(true);
      expect(payload.reason).toBe("contract_requires_approval");
      expect(payload.missingSafeguards).toContain("missing_phase_workspace");
      expect(payload.invocation.executed).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("executes generated preflight when explicitly requested and safe", async () => {
    const { rootDir, runsDir } = await createPhaseFixture();
    const previousLive = process.env.MARTIN_LIVE;
    process.env.MARTIN_LIVE = "false";

    try {
      const result = await executeCli([
        "--json",
        "phase",
        "preflight",
        "--cwd",
        rootDir,
        "--runs-dir",
        runsDir,
        "--execute"
      ]);
      const payload = JSON.parse(result.stdout);

      expect(result.exitCode).toBe(0);
      expect(payload.command).toBe("preflight");
      expect(payload.ready).toBe(true);
      expect(payload.request.objective).toBe("Build the local command center");
      expect(payload.request.allowedPaths).toEqual(["packages/cli/src/**", "packages/cli/tests/**"]);
    } finally {
      if (previousLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = previousLive;
      }
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
