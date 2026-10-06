import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import type { MartinAdapterRequest } from "@martin/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSwarmVerifierExecutor,
  createVerifierOnlyAdapter
} from "../src/verifier-only.js";

const scratchRoots: string[] = [];

afterEach(async () => {
  await Promise.all(scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("verifier-only swarm execution facts", () => {
  it("forwards an already-aborted signal without launching a subprocess", async () => {
    const cwd = await scratch();
    const controller = new AbortController();
    controller.abort("parent_cancelled");
    let spawnCalls = 0;
    const adapter = createVerifierOnlyAdapter({
      workingDirectory: cwd,
      spawnImpl: () => {
        spawnCalls += 1;
        throw new Error("aborted verifier must not launch");
      }
    });

    const result = await adapter.execute(request(cwd, ["node --version"], controller.signal));

    expect(spawnCalls).toBe(0);
    expect(result.status).toBe("failed");
    expect(result.verification.binding).toEqual({
      runId: "swarm-parent-01",
      attemptId: "verifier-attempt-01",
      workspaceId: "verifier-workspace-01",
      cwd,
      commands: ["node --version"]
    });
    expect(result.verification.steps).toEqual([
      expect.objectContaining({ launched: false, completed: false, timedOut: false })
    ]);
  });

  it("returns truthful binding and successful subprocess facts", async () => {
    const cwd = await scratch();
    const command = `"${process.execPath}" -e "process.exit(0)"`;
    const adapter = createVerifierOnlyAdapter({ workingDirectory: cwd });

    const result = await adapter.execute(request(cwd, [command]));

    expect(result.status).toBe("completed");
    expect(result.verification.binding).toEqual({
      runId: "swarm-parent-01",
      attemptId: "verifier-attempt-01",
      workspaceId: "verifier-workspace-01",
      cwd,
      commands: [command]
    });
    expect(result.verification.steps).toEqual([
      expect.objectContaining({
        command,
        launched: true,
        completed: true,
        crashed: false,
        timedOut: false,
        exitCode: 0
      })
    ]);
  });
});

describe("createSwarmVerifierExecutor", () => {
  it("round-trips the full parent binding without trusting an injected tree-closure claim", async () => {
    const cwd = await scratch();
    const commands = [
      { command: "pnpm lint", type: "lint" },
      { command: "pnpm test", type: "test_full" }
    ];
    const timestamps = ["2026-10-03T01:00:00.000Z", "2026-10-03T01:00:01.000Z"];
    const executor = createSwarmVerifierExecutor({
      now: () => timestamps.shift()!,
      spawnImpl: scriptedSpawn([0, 0])
    });

    const result = await executor.execute(swarmRequest(cwd, commands));

    expect(result).toEqual({
      passed: false,
      processCloseState: "failed",
      binding: {
        swarmId: "swarm-parent-01",
        workspaceId: "verifier-workspace-01",
        cwd,
        parentPolicyVersion: "swarm-policy-v1",
        baselineCommit: "a".repeat(40),
        integratedTreeHash: "b".repeat(40),
        commands: ["pnpm lint", "pnpm test"]
      },
      subprocessResults: [{
        command: "pnpm lint",
        launched: true,
        completed: true,
        timedOut: false,
        exitCode: 0,
        startedAt: "2026-10-03T01:00:00.000Z",
        completedAt: "2026-10-03T01:00:01.000Z"
      }]
    });
  });

  it("forwards the parent AbortSignal and records a truthful nonlaunch", async () => {
    const cwd = await scratch();
    const controller = new AbortController();
    controller.abort("parent_cancelled");
    let spawnCalls = 0;
    const executor = createSwarmVerifierExecutor({
      now: sequenceClock(),
      spawnImpl: () => {
        spawnCalls += 1;
        throw new Error("aborted verifier must not launch");
      }
    });

    const result = await executor.execute(swarmRequest(
      cwd,
      [{ command: "pnpm test", type: "test_full" }],
      controller.signal
    ));

    expect(spawnCalls).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.subprocessResults).toEqual([{
      command: "pnpm test",
      launched: false,
      completed: false,
      timedOut: false,
      exitCode: 1,
      startedAt: "2026-10-03T02:00:00.000Z"
    }]);
  });

  it("distinguishes a completed non-zero verifier failure from nonlaunch", async () => {
    const cwd = await scratch();
    const executor = createSwarmVerifierExecutor({
      now: sequenceClock(),
      spawnImpl: scriptedSpawn([7])
    });

    const result = await executor.execute(swarmRequest(
      cwd,
      [{ command: "pnpm test", type: "test_full" }]
    ));

    expect(result.passed).toBe(false);
    expect(result.subprocessResults).toEqual([{
      command: "pnpm test",
      launched: true,
      completed: true,
      timedOut: false,
      exitCode: 7,
      startedAt: "2026-10-03T02:00:00.000Z",
      completedAt: "2026-10-03T02:00:01.000Z"
    }]);
  });

  it("records synchronous spawn failure as nonlaunch", async () => {
    const cwd = await scratch();
    const nonlaunch = createSwarmVerifierExecutor({
      now: sequenceClock(),
      spawnImpl: () => {
        throw new Error("spawn ENOENT");
      }
    });
    const command = [{ command: "missing-verifier", type: "test_full" }];

    const nonlaunchResult = await nonlaunch.execute(swarmRequest(cwd, command));

    expect(nonlaunchResult.passed).toBe(false);
    expect(nonlaunchResult.subprocessResults).toEqual([{
      command: "missing-verifier",
      launched: false,
      completed: false,
      timedOut: false,
      exitCode: 1,
      startedAt: "2026-10-03T02:00:00.000Z"
    }]);
  });

  it("records timeout without inventing completion", async () => {
    const cwd = await scratch();
    const timedOut = createSwarmVerifierExecutor({
      verifyTimeoutMs: 5,
      now: sequenceClock(),
      spawnImpl: () => createFakeChild()
    });
    const command = [{ command: "slow-verifier", type: "test_full" }];

    const timeoutResult = await timedOut.execute(swarmRequest(cwd, command));

    expect(timeoutResult.passed).toBe(false);
    expect(timeoutResult.subprocessResults).toEqual([{
      command: "slow-verifier",
      launched: true,
      completed: false,
      timedOut: true,
      exitCode: 1,
      startedAt: "2026-10-03T02:00:00.000Z"
    }]);
  });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "martin-verifier-only-"));
  scratchRoots.push(root);
  return root;
}

function request(cwd: string, commands: string[], signal?: AbortSignal): MartinAdapterRequest {
  return {
    loopId: "swarm-parent-01",
    workspaceId: "verifier-workspace-01",
    attemptId: "verifier-attempt-01",
    context: {
      taskTitle: "Swarm global verifier",
      objective: "Verify the exact integrated tree.",
      verificationPlan: commands,
      verificationStack: commands.map((command) => ({ command, type: "test_full" })),
      mutationMode: "verify_only",
      repoRoot: cwd,
      focus: "Do not mutate the verifier workspace.",
      remainingBudgetUsd: 0,
      remainingIterations: 1,
      remainingTokens: 0
    },
    previousAttempts: [],
    ...(signal ? { signal } : {})
  };
}

type SwarmVerifierRequest = Parameters<
  ReturnType<typeof createSwarmVerifierExecutor>["execute"]
>[0];

function swarmRequest(
  cwd: string,
  commands: SwarmVerifierRequest["commands"],
  signal = new AbortController().signal
): SwarmVerifierRequest {
  return {
    swarmId: "swarm-parent-01",
    workspaceId: "verifier-workspace-01",
    cwd,
    parentPolicyVersion: "swarm-policy-v1",
    baselineCommit: "a".repeat(40),
    integratedTreeHash: "b".repeat(40),
    commands,
    signal
  };
}

interface FakeChild extends ChildProcess {
  emitClose(code: number | null): void;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as Partial<FakeChild> & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: Writable;
    exitCode: number | null;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  child.exitCode = null;
  Object.defineProperty(child, "pid", { value: 4321, configurable: true });
  child.emitClose = (code) => {
    child.exitCode = code;
    child.emit("exit", code, null);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code, null);
  };
  child.kill = () => {
    process.nextTick(() => child.emitClose?.(1));
    return true;
  };
  return child as FakeChild;
}

function scriptedSpawn(exitCodes: number[]): () => ChildProcess {
  return () => {
    const child = createFakeChild();
    const exitCode = exitCodes.shift() ?? 0;
    process.nextTick(() => child.emitClose(exitCode));
    return child;
  };
}

function sequenceClock(): () => string {
  let tick = 0;
  return () => `2026-10-03T02:00:0${String(tick++)}.000Z`;
}
