import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  resolveReleaseStageTimeoutMs,
  runReleaseCommand,
} from "../lib/release-command-runner.mjs";

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "martin-release-command-runner-test-"));
}

function nodeStep(label, source, ...args) {
  return {
    label,
    command: [process.execPath, "-e", source, ...args],
  };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilProcessStops(pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isProcessAlive(pid);
}

test("resolveReleaseStageTimeoutMs uses an explicit positive option or environment contract", () => {
  assert.equal(resolveReleaseStageTimeoutMs({ timeoutMs: 123 }), 123);
  assert.equal(resolveReleaseStageTimeoutMs({ env: { MARTIN_RELEASE_STAGE_TIMEOUT_MS: "456" } }), 456);
  assert.throws(
    () => resolveReleaseStageTimeoutMs({ env: { MARTIN_RELEASE_STAGE_TIMEOUT_MS: "not-a-number" } }),
    /positive integer/u,
  );
});

test("runReleaseCommand returns a complete structured result and exact durable output on success", async () => {
  const logDir = await temporaryDirectory();
  const result = await runReleaseCommand(
    nodeStep("quick success", "process.stdout.write('stdout-line\\n'); process.stderr.write('stderr-line\\n')"),
    { cwd: process.cwd(), env: process.env, logDir, index: 1, timeoutMs: 5_000 },
  );

  assert.equal(result.status, "passed");
  assert.equal(result.failureKind, null);
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.command.slice(0, 2), [process.execPath, "-e"]);
  assert.match(result.startedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.match(result.completedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0);
  assert.equal(path.isAbsolute(result.logPath), true);
  assert.equal(result.termination.requested, false);

  const log = await readFile(result.logPath, "utf8");
  assert.match(log, /^> quick success\n/u);
  assert.match(log, /stdout-line/u);
  assert.match(log, /stderr-line/u);
});

test("runReleaseCommand preserves a nonzero exit and output without retrying", async () => {
  const logDir = await temporaryDirectory();
  const counterPath = path.join(logDir, "counter.txt");
  const source = [
    "const fs = require('node:fs');",
    "const p = process.argv[1];",
    "const n = fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf8')) : 0;",
    "fs.writeFileSync(p, String(n + 1));",
    "process.stderr.write('intentional failure\\n');",
    "process.exit(7);",
  ].join("");
  const result = await runReleaseCommand(nodeStep("nonzero", source, counterPath), {
    cwd: process.cwd(), env: process.env, logDir, index: 1, timeoutMs: 5_000,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failureKind, "nonzero_exit");
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, false);
  assert.equal(await readFile(counterPath, "utf8"), "1");
  assert.match(await readFile(result.logPath, "utf8"), /intentional failure/u);
});

test("runReleaseCommand records a spawn error as a structured failed result", async () => {
  const logDir = await temporaryDirectory();
  const result = await runReleaseCommand(
    { label: "missing executable", command: [path.join(logDir, "does-not-exist")] },
    { cwd: process.cwd(), env: process.env, logDir, index: 1, timeoutMs: 5_000 },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.failureKind, "spawn_error");
  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, false);
  assert.match(result.spawnError ?? "", /ENOENT|not found|cannot find/iu);
  assert.match(await readFile(result.logPath, "utf8"), /spawn-error/u);
});

test("runReleaseCommand times out once, terminates the owned descendant tree, and records termination", async () => {
  const logDir = await temporaryDirectory();
  const pidPath = path.join(logDir, "descendant.pid");
  await writeFile(pidPath, "", "utf8");
  const childSource = "setInterval(() => {}, 1000)";
  const parentSource = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', process.argv[2]], { stdio: 'ignore' });",
    "fs.writeFileSync(process.argv[1], String(child.pid));",
    "setInterval(() => {}, 1000);",
  ].join("");

  const result = await runReleaseCommand(nodeStep("owned timeout", parentSource, pidPath, childSource), {
    cwd: process.cwd(),
    env: process.env,
    logDir,
    index: 1,
    timeoutMs: 300,
    terminationGraceMs: 3_000,
  });
  const descendantPid = Number(await readFile(pidPath, "utf8"));

  assert.equal(result.status, "failed");
  assert.equal(result.failureKind, "repository_stage_timeout");
  assert.equal(result.timedOut, true);
  assert.equal(result.termination.requested, true);
  assert.equal(result.termination.attempted, true);
  assert.equal(result.termination.observed, true);
  assert.equal(Number.isSafeInteger(descendantPid), true);
  assert.equal(await waitUntilProcessStops(descendantPid), true, `descendant ${descendantPid} remained alive`);
});

test("runReleaseCommand remains bounded when a terminated child never emits close", async () => {
  const logDir = await temporaryDirectory();
  const fakeChild = new EventEmitter();
  fakeChild.pid = 12345;
  fakeChild.exitCode = null;
  fakeChild.signalCode = null;
  fakeChild.stdout = new PassThrough();
  fakeChild.stderr = new PassThrough();
  const started = Date.now();

  const result = await runReleaseCommand(
    { label: "missing close event", command: ["fake"] },
    {
      cwd: process.cwd(),
      env: process.env,
      logDir,
      index: 1,
      timeoutMs: 20,
      spawnProcess: () => fakeChild,
      terminateTree: async () => ({
        attempted: true,
        observed: false,
        escalated: true,
        helperExitCode: null,
        helperTimedOut: true,
      }),
    },
  );

  assert.equal(result.failureKind, "repository_stage_timeout");
  assert.equal(result.termination.observed, false);
  assert.ok(Date.now() - started < 1_000, "runner waited indefinitely for a missing close event");
});
