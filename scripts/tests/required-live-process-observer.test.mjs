import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  bindProviderProcessObservations,
  readProviderProcessObservations,
} from "../lib/required-live-process-observer.mjs";

const moduleUrl = new URL("../lib/required-live-process-observer.mjs", import.meta.url).href;

function fixtureGit(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2024-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2024-01-01T00:00:00Z" },
  }).trim();
}

async function runLauncher({ workspace, useShim, authority, releaseFile }) {
  const launcher = join(workspace, "launcher.mjs");
  const worker = join(workspace, "worker.mjs");
  await writeFile(worker, `
    import { existsSync } from "node:fs";
    import { setTimeout } from "node:timers/promises";
    for (let i = 0; i < 500 && !existsSync(process.env.OBSERVER_FIXTURE_RELEASE); i++) await setTimeout(10);
    if (!existsSync(process.env.OBSERVER_FIXTURE_RELEASE)) process.exit(2);
    console.log(JSON.stringify({ type: "thread.started", thread_id: process.env.OBSERVER_FIXTURE_SESSION }));
    console.log(JSON.stringify({ type: "fixture.pid", pid: process.pid, ppid: process.ppid }));
  `);
  await writeFile(launcher, `
    import { launchObservedProvider } from ${JSON.stringify(moduleUrl)};
    process.exitCode = await launchObservedProvider({
      ...JSON.parse(process.env.OBSERVER_FIXTURE_AUTHORITY),
      cwd: process.cwd(),
      args: ["worker.mjs"],
    });
  `);
  if (useShim) {
    await writeFile(join(workspace, "observer.cmd"), '@echo off\r\n"%OBSERVER_FIXTURE_NODE%" "%~dp0launcher.mjs"\r\n');
  }
  const child = spawn(
    useShim ? process.env.ComSpec ?? "cmd.exe" : process.execPath,
    useShim ? ["/d", "/c", "observer.cmd"] : [launcher],
    {
      cwd: workspace,
      windowsHide: true,
      env: {
        ...process.env,
        OBSERVER_FIXTURE_NODE: process.execPath,
        OBSERVER_FIXTURE_AUTHORITY: JSON.stringify(authority),
        OBSERVER_FIXTURE_RELEASE: releaseFile,
        OBSERVER_FIXTURE_SESSION: releaseFile,
      },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (value) => { stdout += value; });
  child.stderr.setEncoding("utf8").on("data", (value) => { stderr += value; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(`fixture child failed (${code}): ${stderr}`));
      resolve(stdout.trim().split("\n").map((line) => JSON.parse(line)));
    });
  });
}

test("attributes concurrent native and command-shim provider launches with exact process identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "martin-process-observer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const traceDir = join(root, "traces");
  await mkdir(traceDir);
  const attempts = await Promise.all([0, 1, 2].map(async (index) => {
    const workspace = join(root, `workspace ${index}`);
    await mkdir(workspace);
    fixtureGit(workspace, "init", "--quiet");
    fixtureGit(workspace, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "--quiet", "-m", "fixture");
    return {
      attemptId: `attempt-${index}`,
      childRunId: `child-${index}`,
      cwd: workspace,
      sourceSha: fixtureGit(workspace, "rev-parse", "HEAD"),
      sessionId: join(root, `release-${index}`),
    };
  }));
  const authority = {
    traceDir,
    captureId: randomUUID(),
    sourceSha: attempts[0].sourceSha,
    executablePath: process.execPath,
  };
  const startedAt = new Date().toISOString();
  const executions = attempts.map((attempt, index) => runLauncher({
    workspace: attempt.cwd,
    useShim: process.platform === "win32" && index !== 1,
    authority,
    releaseFile: attempt.sessionId,
  }));
  // Release all three short-lived providers only after all OS process starts are journaled.
  let starts = [];
  for (let i = 0; i < 200 && starts.length !== 3; i++) {
    starts = await readProviderProcessObservations(authority, { allowRunning: true });
    if (starts.length !== 3) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await Promise.all(attempts.map((attempt) => writeFile(attempt.sessionId, "")));
  const outputs = await Promise.all(executions);
  assert.equal(starts.length, 3);
  assert.ok(starts.every((record) => record.completedAt === undefined));
  const completedAt = new Date().toISOString();
  const references = attempts.map((attempt) => ({ ...attempt, startedAt, completedAt }));
  const records = await readProviderProcessObservations(authority);
  const bound = bindProviderProcessObservations(records, references, authority);
  assert.equal(new Set(bound.map((record) => record.providerProcessId)).size, 3);
  bound.forEach((record, index) => {
    assert.equal(record.childRunId, references[index].childRunId);
    assert.equal(record.attemptId, references[index].attemptId);
    assert.equal(record.sessionId, references[index].sessionId);
    assert.equal(record.providerProcessId, outputs[index][1].pid);
    assert.equal(record.parentProcessId, outputs[index][1].ppid);
    assert.ok(Date.parse(record.completedAt) >= Date.parse(record.launchedAt));
  });
  assert.throws(() => bindProviderProcessObservations(records.slice(1), references, authority), /missing or ambiguous/i);
  assert.throws(() => bindProviderProcessObservations(records, [
    { ...references[0], sessionId: references[1].sessionId }, ...references.slice(1),
  ], authority), /missing or ambiguous/i);
  assert.throws(() => bindProviderProcessObservations([
    records[0], { ...records[1], providerProcessId: records[0].providerProcessId }, records[2],
  ], references, authority), /PID reused/i);
  assert.throws(() => bindProviderProcessObservations(records, [
    { ...references[0], startedAt: completedAt }, ...references.slice(1),
  ], authority), /missing or ambiguous/i);
  assert.throws(() => bindProviderProcessObservations(records, [
    references[0], { ...references[0], childRunId: "another-child", attemptId: "another-attempt" },
  ], authority), /missing or ambiguous/i);
});

test("records a nonzero exit from a native provider that immediately exits", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "martin-process-exit-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const traceDir = join(cwd, "traces");
  await mkdir(traceDir);
  fixtureGit(cwd, "init", "--quiet");
  fixtureGit(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "--quiet", "-m", "fixture");
  const authority = { traceDir, captureId: randomUUID(), executablePath: process.execPath, sourceSha: fixtureGit(cwd, "rev-parse", "HEAD") };
  const { launchObservedProvider } = await import(moduleUrl);
  assert.equal(await launchObservedProvider({ ...authority, cwd, args: ["-e", "process.exit(7)"] }), 7);
  const [record] = await readProviderProcessObservations(authority);
  assert.equal(record.exitCode, 7);
  assert.ok(record.providerProcessId > 0);
  assert.ok(record.completedAt);
});

test("refuses to launch a process from another source", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "martin-process-source-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const traceDir = join(cwd, "traces");
  await mkdir(traceDir);
  fixtureGit(cwd, "init", "--quiet");
  fixtureGit(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "--quiet", "-m", "fixture");
  const authority = { traceDir, captureId: randomUUID(), executablePath: process.execPath, sourceSha: "a".repeat(40) };
  const { launchObservedProvider } = await import(moduleUrl);
  await assert.rejects(() => launchObservedProvider({ ...authority, cwd, args: ["-e", "process.exit(7)"] }), /workspace source/u);
  assert.deepEqual(await readProviderProcessObservations(authority), []);
});
