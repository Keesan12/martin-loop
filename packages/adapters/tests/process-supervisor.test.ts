import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  spawnSupervisedProcess,
  spawnSupervisedProcessForTest,
  type ProcessSpawnLike,
  type SpawnSupervisedProcessOptions
} from "../src/process-supervisor.js";

interface FakeChild extends ChildProcess {
  emitClose(code: number | null): void;
}

function createFakeChild(pid = 4321): FakeChild {
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
  Object.defineProperty(child, "pid", { value: pid, configurable: true });
  child.emitClose = (code) => {
    child.exitCode = code;
    child.emit("exit", code, null);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code, null);
  };
  return child as FakeChild;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("condition did not become true before timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("spawnSupervisedProcess", () => {
  it("preserves normal stdout, stderr, exit, and close semantics", async () => {
    const child = createFakeChild();
    const spawnImpl: ProcessSpawnLike = () => {
      process.nextTick(() => {
        child.stdout.write("hello");
        child.stderr.write("warning");
        child.emitClose(0);
      });
      return child;
    };

    const result = await spawnSupervisedProcess("tool", ["arg"], {
      cwd: process.cwd(),
      timeoutMs: 1_000,
      spawnImpl
    });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "hello",
      stderr: "warning",
      launched: true,
      completed: true,
      timedOut: false,
      cleanup: { state: "not_required" }
    });
  });

  it("refuses an already-aborted launch before spawn", async () => {
    const controller = new AbortController();
    controller.abort("stop");
    let spawnCalls = 0;

    const result = await spawnSupervisedProcess("tool", [], {
      cwd: process.cwd(),
      timeoutMs: 1_000,
      signal: controller.signal,
      spawnImpl: () => {
        spawnCalls += 1;
        return createFakeChild();
      }
    });

    expect(spawnCalls).toBe(0);
    expect(result).toMatchObject({
      launched: false,
      completed: false,
      cleanup: { state: "not_required" }
    });
  });

  it("catches an abort raised synchronously inside the injected spawn", async () => {
    const controller = new AbortController();
    const child = createFakeChild(9021);
    let killCalls = 0;
    let closed = false;
    Object.defineProperty(child, "kill", {
      value: () => {
        killCalls += 1;
        process.nextTick(() => {
          if (!closed) {
            closed = true;
            child.emitClose(1);
          }
        });
        return true;
      }
    });

    const pending = spawnSupervisedProcess("tool", [], {
      cwd: process.cwd(),
      timeoutMs: 1_000,
      signal: controller.signal,
      spawnImpl: () => {
        controller.abort("spawn-time cancellation");
        setImmediate(() => {
          if (!closed) {
            closed = true;
            child.emitClose(0);
          }
        });
        return child;
      }
    });

    await expect(pending).resolves.toMatchObject({
      completed: false,
      cleanup: { state: "closed" }
    });
    expect(killCalls).toBe(1);
  });

  it("uses exact Windows taskkill tree arguments for the owned PID", async () => {
    const child = createFakeChild(9123);
    const taskkillCalls: Array<{ command: string; args: readonly string[]; options?: SpawnOptions }> = [];
    const controller = new AbortController();
    const taskkillSpawnImpl: ProcessSpawnLike = (command, args = [], options) => {
      taskkillCalls.push({ command, args, options });
      const taskkill = createFakeChild(7001);
      process.nextTick(() => {
        taskkill.emitClose(0);
        child.emitClose(1);
      });
      return taskkill;
    };

    const pending = spawnSupervisedProcessForTest("tool", [], {
      cwd: process.cwd(),
      timeoutMs: 1_000,
      signal: controller.signal,
      spawnImpl: () => child
    }, {
      platform: "win32",
      taskkillSpawnImpl,
      wait: () => new Promise<void>(() => undefined)
    });
    controller.abort("cancelled");
    const result = await pending;

    expect(taskkillCalls).toEqual([{
      command: "taskkill.exe",
      args: ["/PID", "9123", "/T", "/F"],
      options: expect.objectContaining({ windowsHide: true })
    }]);
    expect(result.cleanup).toEqual({ state: "closed" });
  });

  it("returns a typed cleanup failure when taskkill never exits", async () => {
    const child = createFakeChild(9124);
    const controller = new AbortController();
    const pending = spawnSupervisedProcessForTest("tool", [], {
      cwd: process.cwd(),
      timeoutMs: 100,
      signal: controller.signal,
      terminationGraceMs: 5,
      spawnImpl: () => child
    }, {
      platform: "win32",
      taskkillSpawnImpl: () => createFakeChild(7003),
      wait: async () => undefined
    });
    controller.abort("cancelled");

    const result = await Promise.race([
      pending,
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 25))
    ]);
    expect(result).not.toBe("hung");
    expect(result).toMatchObject({
      cleanup: { state: "failed", code: "termination_failed" }
    });
  });

  it("never gives an injected spawn real Windows PID termination authority", async () => {
    const child = createFakeChild(9125);
    const controller = new AbortController();
    let childKillCalls = 0;
    let taskkillCalls = 0;
    Object.defineProperty(child, "kill", {
      value: () => {
        childKillCalls += 1;
        process.nextTick(() => child.emitClose(1));
        return true;
      }
    });

    const forgedAuthority = {
      cwd: process.cwd(),
      timeoutMs: 100,
      signal: controller.signal,
      platform: "win32",
      spawnImpl: () => child,
      taskkillSpawnImpl: () => {
        taskkillCalls += 1;
        const taskkill = createFakeChild(7004);
        process.nextTick(() => {
          taskkill.emitClose(0);
          child.emitClose(1);
        });
        return taskkill;
      }
    } as unknown as SpawnSupervisedProcessOptions;
    const pending = spawnSupervisedProcess("tool", [], forgedAuthority);
    controller.abort("cancelled");
    const result = await pending;

    expect(taskkillCalls).toBe(0);
    expect(childKillCalls).toBe(1);
    expect(result.cleanup).toEqual({ state: "closed" });
  });

  it.each(["win32", "linux"] as const)(
    "fails closed before spawn when the deep %s test helper omits termination seams",
    async (platform) => {
      let spawnCalls = 0;

      const result = await spawnSupervisedProcessForTest("tool", [], {
        cwd: process.cwd(),
        timeoutMs: 100,
        spawnImpl: () => {
          spawnCalls += 1;
          const child = createFakeChild(9931);
          process.nextTick(() => child.emitClose(0));
          return child;
        }
      }, { platform } as never);

      expect(spawnCalls).toBe(0);
      expect(result).toMatchObject({
        launched: false,
        cleanup: { state: "failed", code: "missing_test_termination_seam" }
      });
    }
  );

  it("targets only the negative owned POSIX PID and escalates after bounded grace", async () => {
    const child = createFakeChild(8123);
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const waits: number[] = [];
    const controller = new AbortController();

    const pending = spawnSupervisedProcessForTest("tool", [], {
      cwd: process.cwd(),
      timeoutMs: 1_000,
      signal: controller.signal,
      terminationGraceMs: 25,
      spawnImpl: (_command, _args, options) => {
        expect(options?.detached).toBe(true);
        return child;
      }
    }, {
      platform: "linux",
      killProcessGroup: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === "SIGKILL") child.emitClose(1);
      },
      wait: async (durationMs) => { waits.push(durationMs); }
    });
    controller.abort("cancelled");
    const result = await pending;

    expect(signals).toEqual([[-8123, "SIGTERM"], [-8123, "SIGKILL"]]);
    expect(waits).toEqual([25, 25]);
    expect(result.cleanup).toEqual({ state: "closed" });
  });

  it("does not resolve cancellation before the owned child reports close", async () => {
    const child = createFakeChild(6123);
    const controller = new AbortController();
    let taskkillFinished = false;
    const pending = spawnSupervisedProcessForTest("tool", [], {
      cwd: process.cwd(),
      timeoutMs: 1_000,
      signal: controller.signal,
      spawnImpl: () => child
    }, {
      platform: "win32",
      taskkillSpawnImpl: () => {
        const taskkill = createFakeChild(7002);
        process.nextTick(() => {
          taskkillFinished = true;
          taskkill.emitClose(0);
        });
        return taskkill;
      },
      wait: () => new Promise<void>(() => undefined)
    });
    controller.abort("cancelled");
    await waitUntil(() => taskkillFinished);

    const state = await Promise.race([
      pending.then(() => "resolved"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 20))
    ]);
    expect(state).toBe("pending");

    child.emitClose(1);
    await expect(pending).resolves.toMatchObject({ cleanup: { state: "closed" } });
  });

  it.each([undefined, 0, -1])("refuses invalid or missing owned PID %j", async (pid) => {
    const child = createFakeChild(5001);
    Object.defineProperty(child, "pid", { value: pid, configurable: true });
    const controller = new AbortController();
    let terminationCalls = 0;
    const pending = spawnSupervisedProcessForTest("tool", [], {
      cwd: process.cwd(),
      timeoutMs: 1_000,
      signal: controller.signal,
      spawnImpl: () => child
    }, {
      platform: "win32",
      taskkillSpawnImpl: () => {
        terminationCalls += 1;
        return createFakeChild();
      },
      wait: () => new Promise<void>(() => undefined)
    });
    controller.abort("cancelled");

    await expect(pending).resolves.toMatchObject({
      cleanup: { state: "failed", code: "invalid_owned_pid" }
    });
    expect(terminationCalls).toBe(0);
  });

  it("stops both the real host fixture child and grandchild after cancellation", { timeout: 15_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-process-tree-"));
    const statePath = join(directory, "state.jsonl");
    const fixturePath = join(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "process-tree-child.cjs"
    );
    const controller = new AbortController();

    try {
      const pending = spawnSupervisedProcess(process.execPath, [fixturePath, "child", statePath], {
        cwd: process.cwd(),
        timeoutMs: 10_000,
        signal: controller.signal,
        terminationGraceMs: 200
      });
      await waitUntil(async () => {
        try {
          return (await readFile(statePath, "utf8")).trim().split(/\r?\n/u).length >= 2;
        } catch {
          return false;
        }
      });
      const records = (await readFile(statePath, "utf8"))
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as { kind: string; pid: number; grandchildPid?: number });
      const childRecord = records.find((record) => record.kind === "child");
      const grandchildRecord = records.find((record) => record.kind === "grandchild");
      expect(childRecord?.pid).toBeTypeOf("number");
      expect(grandchildRecord?.pid).toBeTypeOf("number");

      controller.abort("cancelled");
      const result = await pending;
      expect(result.cleanup).toEqual({ state: "closed" });
      await waitUntil(() => !isAlive(childRecord!.pid) && !isAlive(grandchildRecord!.pid));
      expect(isAlive(childRecord!.pid)).toBe(false);
      expect(isAlive(grandchildRecord!.pid)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("proves the owned tree closed when a successful parent exits before its descendant", { timeout: 15_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-process-tree-natural-"));
    const statePath = join(directory, "state.jsonl");
    const fixturePath = join(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "process-tree-child.cjs"
    );

    try {
      const result = await spawnSupervisedProcess(process.execPath, [fixturePath, "natural-parent", statePath], {
        cwd: process.cwd(),
        timeoutMs: 10_000,
        terminationGraceMs: 500,
        requireTreeClosureOnSuccess: true
      });
      const records = (await readFile(statePath, "utf8"))
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as { kind: string; pid: number; grandchildPid?: number });
      const record = records.find((entry) => entry.kind === "child");
      expect(record?.grandchildPid).toBeTypeOf("number");
      expect(result).toMatchObject({ completed: true, exitCode: 0, cleanup: { state: "closed" } });
      await waitUntil(() => !isAlive(record!.pid) && !isAlive(record!.grandchildPid!));
      expect(isAlive(record!.grandchildPid!)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
