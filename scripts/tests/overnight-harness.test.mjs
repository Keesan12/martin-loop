// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

import * as harness from "../overnight/harness.mjs";
import { resolveReleaseCommandExecution } from "../lib/release-command-runner.mjs";
import { runContinuousAcceptance } from "../overnight/acceptance-runner.mjs";
import {
  assertGitHubCliAuthenticated,
  assertGitHubCheckpointCadence,
  assertGitHubServerElapsed,
  canonicalGitHubAnchorBody,
  checkpointMaxGapMs,
  parseGitHubAnchorComment,
  parseGitHubRepositoryFromRemoteUrl,
  pendingGitHubCheckpointEvents,
  PRODUCTION_EXECUTION_TRUST_BOUNDARY,
  verifyGitHubAnchorRecord,
} from "../overnight/github-anchor.mjs";

// Keep duplicate invocations isolated. Release qualification runs suites sequentially,
// but a developer or agent may still start the same focused file concurrently.
const SCRATCH_ROOT = resolve(
  import.meta.dirname,
  "..",
  "..",
  ".release",
  "0.10.0",
  "overnight",
  "lane-c",
  `test-scratch-${process.pid}`,
);

after(() => rmSync(SCRATCH_ROOT, { recursive: true, force: true }));

function freshRoot(name) {
  const root = resolve(SCRATCH_ROOT, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}

function writeTestRuntimeDossier(root, runId, sourceSha) {
  const dossier = {
    schemaVersion: "martin.mission-runtime-dossier.v1",
    state: {
      bindings: { sourceSha: createHash("sha256").update(sourceSha).digest("hex") },
      queue: [{ phase: "integrated" }],
      verifications: { fixture: { passed: true } },
      settlement: { settlementIds: [runId], budget: { spentUsd: 0 } },
    },
    supervisor: {},
  };
  const directory = resolve(root, "integrated-runs", runId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, "runtime-dossier.json"), `${JSON.stringify(dossier, null, 2)}\n`);
  return createHash("sha256").update(JSON.stringify(dossier)).digest("hex");
}

test("scenario manifests bind deterministic boundaries and bounded mode duration", () => {
  const first = harness.createScenarioManifest({
    scenarioId: "receipt-restart",
    seed: "lane-c-seed",
    mode: "8h",
  });
  const second = harness.createScenarioManifest({
    scenarioId: "receipt-restart",
    seed: "lane-c-seed",
    mode: "8h",
  });

  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, "martin.overnight.scenario.v1");
  assert.equal(first.durationMs, 8 * 60 * 60 * 1_000);
  assert.deepEqual(first.boundaries, [
    "provider",
    "settlement",
    "receipt",
    "verifier",
    "checkpoint",
    "integration",
  ]);
  assert.equal(first.faults.length, first.boundaries.length);
  assert.deepEqual(first.faults.map((fault) => fault.boundary).sort(), [...first.boundaries].sort());
});

test("restart journal recovery preserves a hash chain and exactly-once authority", () => {
  const root = freshRoot("restart-journal");
  const manifest = harness.createScenarioManifest({ scenarioId: "restart", seed: "stable", mode: "24h" });
  harness.persistScenario(root, manifest);
  harness.appendJournalEvent(root, { type: "operation_started", operationId: "op-1" });
  harness.appendJournalEvent(root, { type: "operation_committed", operationId: "op-1", receiptId: "receipt-1" });

  const recovered = harness.recoverRestartJournal(root);
  assert.equal(recovered.events.length, 2);
  assert.equal(recovered.nextSequence, 3);
  assert.equal(recovered.pendingOperations.length, 0);
  assert.deepEqual(recovered.committedOperations, ["op-1"]);
  assert.doesNotThrow(() => harness.assertExactlyOnce(recovered.events));
  assert.throws(
    () => harness.assertExactlyOnce([...recovered.events, recovered.events[1]]),
    /exactly-once invariant/iu,
  );
});

test("resource policy fails closed for unbounded workers, resources, rate, or spend", () => {
  const policy = harness.createResourcePolicy();
  assert.equal(policy.schemaVersion, "martin.overnight.resource-policy.v1");
  assert.deepEqual(policy.concurrency, {
    workers: 2,
    providers: 1,
    tests: 1,
    observer: 1,
    broadTests: 1,
  });
  assert.equal(policy.limits.cpuPercent, 75);
  assert.equal(policy.limits.memoryMb, 1_024);
  assert.equal(policy.limits.diskMb, 2_048);
  assert.equal(policy.limits.operationsPerMinute, 60);
  assert.equal(policy.limits.spendUsd, 0);

  for (const overrides of [
    { concurrency: { workers: 0 } },
    { concurrency: { providers: 3 } },
    { concurrency: { tests: Number.POSITIVE_INFINITY } },
    { limits: { cpuPercent: 101 } },
    { limits: { memoryMb: 0 } },
    { limits: { diskMb: 0 } },
    { limits: { operationsPerMinute: 0 } },
    { limits: { spendUsd: -1 } },
  ]) {
    assert.throws(() => harness.createResourcePolicy(overrides), /bounded resource policy/iu);
  }
});

test("observer and broad-test leases are persistent single-flight semaphores", () => {
  const root = freshRoot("leases");
  const observer = harness.acquireSingleFlight(root, "observer", "observer-a");
  assert.throws(() => harness.acquireSingleFlight(root, "observer", "observer-b"), /single-flight.*observer/iu);
  const broadTest = harness.acquireSingleFlight(root, "broad-test", "test-a");
  assert.throws(() => harness.acquireSingleFlight(root, "broad-test", "test-b"), /single-flight.*broad-test/iu);
  harness.releaseSingleFlight(root, observer);
  harness.releaseSingleFlight(root, broadTest);
  assert.equal(harness.acquireSingleFlight(root, "observer", "observer-c").holderId, "observer-c");
});

test("artifact rotation removes only ephemeral overflow and preserves authority", () => {
  const root = freshRoot("rotation");
  for (const path of ["logs/001.log", "logs/002.log", "logs/003.log", "artifacts/001.json", "artifacts/002.json", "artifacts/003.json"]) {
    const target = resolve(root, path);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, path);
  }
  for (const path of ["authority/ledger.jsonl", "authority/receipts/receipt-1.json"]) {
    const target = resolve(root, path);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, path);
  }

  const result = harness.rotateEphemeralArtifacts(root, { maxFilesPerKind: 2 });
  assert.deepEqual(result.deleted.map((path) => path.replaceAll("\\", "/")).sort(), ["artifacts/001.json", "logs/001.log"]);
  assert.equal(readFileSync(resolve(root, "authority", "ledger.jsonl"), "utf8"), "authority/ledger.jsonl");
  assert.equal(readFileSync(resolve(root, "authority", "receipts", "receipt-1.json"), "utf8"), "authority/receipts/receipt-1.json");
});

test("smoke mode injects every boundary fault deterministically and writes a morning dossier", () => {
  const root = freshRoot("smoke");
  const manifest = harness.createScenarioManifest({ scenarioId: "smoke-all", seed: "smoke-seed", mode: "smoke" });
  const result = harness.runHarness({ root, manifest, policy: harness.createResourcePolicy(), maxTicks: 6, now: () => 1_000 });

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.providerCalls, 0);
  assert.equal(result.faultsInjected, 6);
  assert.equal(result.dossier.schemaVersion, "martin.overnight.morning-dossier.v1");
  assert.equal(result.dossier.smokeValidated, true);
  assert.equal(result.dossier.soakElapsedValidated, false);
  assert.equal(result.dossier.invariants.exactlyOnce, true);
  assert.equal(result.dossier.invariants.authoritativeParity, true);
  assert.deepEqual(result.dossier.boundariesExercised.sort(), [...manifest.boundaries].sort());
  const authority = harness.assertAuthoritativeExactlyOnce(root);
  assert.equal(authority.operationCount, 6);
  const events = harness.recoverRestartJournal(root).events;
  for (const injected of events.filter((event) => event.type === "fault_injected")) {
    const attempts = events.filter((event) => event.type === "boundary_reached" && event.operationId === injected.operationId);
    assert.equal(attempts.length, injected.triggerOrdinal, injected.boundary);
  }
  const ledgerPath = resolve(root, "authority", "ledger.jsonl");
  writeFileSync(ledgerPath, readFileSync(ledgerPath, "utf8").split("\n")[0] + "\n", { flag: "a" });
  assert.throws(() => harness.assertAuthoritativeExactlyOnce(root), /authoritative exactly-once/iu);
});

test("8h and 24h modes resume without claiming unelapsed soak time", () => {
  for (const mode of ["8h", "24h"]) {
    const root = freshRoot(`resume-${mode}`);
    const manifest = harness.createScenarioManifest({ scenarioId: `resume-${mode}`, seed: "resume-seed", mode });
    const first = harness.runHarness({ root, manifest, policy: harness.createResourcePolicy(), maxTicks: 2, now: () => 1_000 });
    const second = harness.runHarness({ root, manifest, policy: harness.createResourcePolicy(), maxTicks: 2, now: () => 2_000 });

    assert.equal(first.status, "PAUSED");
    assert.equal(second.status, "PAUSED");
    assert.equal(second.resumed, true);
    assert.equal(second.ticksCompleted, 4);
    assert.equal(second.dossier.soakElapsedValidated, false);
    assert.equal(second.dossier.elapsedMs, 1_000);
    assert.doesNotThrow(() => harness.assertExactlyOnce(harness.recoverRestartJournal(root).events));
  }
});

test("CLI smoke mode is short, deterministic, and repo-owned", () => {
  const root = freshRoot("cli-smoke");
  const script = resolve(import.meta.dirname, "..", "overnight-harness.mjs");
  const result = spawnSync(process.execPath, [
    script,
    "--mode", "smoke",
    "--root", root,
    "--scenario-id", "cli-smoke",
    "--seed", "cli-seed",
    "--max-ticks", "6",
    "--json",
  ], { cwd: resolve(import.meta.dirname, "..", ".."), encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "COMPLETED");
  assert.equal(output.dossier.smokeValidated, true);
  assert.equal(JSON.parse(readFileSync(resolve(root, "morning-dossier.json"), "utf8")).providerFree, true);
});

test("CLI smoke mode does not depend on import.meta.main availability", () => {
  const root = freshRoot("cli-smoke-imported-entry");
  const code = `process.argv.splice(1, process.argv.length - 1, "--mode", "smoke", "--root", ${JSON.stringify(root)}, "--scenario-id", "node20-compatible", "--max-ticks", "6", "--json"); await import("./scripts/overnight-harness.mjs?node20-compatible-entry");`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: resolve(import.meta.dirname, "..", ".."), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "COMPLETED");
});

test("CLI exits nonzero when a smoke run is resource-blocked", () => {
  const root = freshRoot("cli-blocked");
  const script = resolve(import.meta.dirname, "..", "overnight-harness.mjs");
  const result = spawnSync(process.execPath, [
    script,
    "--mode", "smoke",
    "--root", root,
    "--scenario-id", "cli-blocked",
    "--memory-mb", "1",
    "--json",
  ], { cwd: resolve(import.meta.dirname, "..", ".."), encoding: "utf8" });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "BLOCKED");
});

test("restart completes journal authority after interruption before receipt, ledger, or checkpoint", () => {
  for (const interruption of ["receipt", "ledger", "checkpoint"]) {
    const root = freshRoot(`interrupted-${interruption}`);
    const manifest = harness.createScenarioManifest({ scenarioId: "interrupt", seed: "restart", mode: "smoke" });
    harness.runHarness({ root, manifest, policy: harness.createResourcePolicy(), maxTicks: 1, now: () => 1000 });
    const receipt = JSON.parse(readFileSync(resolve(root, "authority/ledger.jsonl"), "utf8"));
    if (interruption === "receipt") rmSync(resolve(root, "authority/receipts", `${receipt.receiptId}.json`));
    if (interruption !== "checkpoint") rmSync(resolve(root, "authority/ledger.jsonl"));
    rmSync(resolve(root, "state.json"));
    const result = harness.runHarness({ root, manifest, policy: harness.createResourcePolicy(), maxTicks: 5, now: () => 2000 });
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.ticksCompleted, 6);
    assert.equal(harness.assertAuthoritativeExactlyOnce(root).operationCount, 6);
  }
});

test("paired receipt and ledger corruption cannot pass journal parity", () => {
  const root = freshRoot("paired-corruption");
  const manifest = harness.createScenarioManifest({ scenarioId: "parity", seed: "parity", mode: "smoke" });
  harness.runHarness({ root, manifest, policy: harness.createResourcePolicy(), maxTicks: 1 });
  const receipt = JSON.parse(readFileSync(resolve(root, "authority/ledger.jsonl"), "utf8"));
  receipt.journalHash = "forged";
  writeFileSync(resolve(root, "authority/ledger.jsonl"), `${JSON.stringify(receipt)}\n`);
  writeFileSync(resolve(root, "authority/receipts", `${receipt.receiptId}.json`), JSON.stringify(receipt));
  assert.throws(() => harness.assertAuthoritativeExactlyOnce(root), /journal parity/iu);
});

test("idle time across invocations never qualifies as an elapsed soak", () => {
  const root = freshRoot("idle-soak");
  const manifest = harness.createScenarioManifest({ scenarioId: "idle", seed: "idle", mode: "8h" });
  harness.runHarness({ root, manifest, policy: harness.createResourcePolicy(), maxTicks: 6, now: () => 1000 });
  const result = harness.runHarness({ root, manifest, policy: harness.createResourcePolicy(), maxTicks: 1, now: () => 1000 + manifest.durationMs });
  assert.equal(result.status, "PAUSED");
  assert.equal(result.dossier.soakElapsedValidated, false);
  assert.equal(result.dossier.activeElapsedMs, 0);
});

test("a released lease cannot release its successor with the same holder", () => {
  const root = freshRoot("lease-successor");
  const old = harness.acquireSingleFlight(root, "observer", "same-holder");
  harness.releaseSingleFlight(root, old);
  const current = harness.acquireSingleFlight(root, "observer", "same-holder");
  assert.throws(() => harness.releaseSingleFlight(root, old), /token mismatch/iu);
  harness.releaseSingleFlight(root, current);
});

test("pending boundary events resume without reinjecting the same fault", () => {
  const root = freshRoot("pending-boundary");
  const manifest = harness.createScenarioManifest({ scenarioId: "pending", seed: "pending", mode: "smoke" });
  harness.persistScenario(root, manifest);
  const operationId = "pending-tick-1";
  harness.appendJournalEvent(root, { type: "operation_started", operationId, boundary: "provider" });
  harness.appendJournalEvent(root, { type: "boundary_reached", operationId, boundary: "provider", ordinal: 1 });
  const result = harness.runHarness({ root, manifest, policy: harness.createResourcePolicy(), maxTicks: 6 });
  assert.equal(result.status, "COMPLETED");
  const events = harness.recoverRestartJournal(root).events;
  assert.equal(events.filter((event) => event.type === "operation_started" && event.operationId === operationId).length, 1);
  assert.equal(events.filter((event) => event.type === "fault_injected").length, 6);
});

test("rate policy persists across resumes and direct calls honor observer ownership", () => {
  const root = freshRoot("rate-policy");
  const manifest = harness.createScenarioManifest({ scenarioId: "rate", seed: "rate", mode: "smoke" });
  const policy = harness.createResourcePolicy({ limits: { operationsPerMinute: 1 } });
  const invoke = () => harness.runHarness({ root, manifest, policy, maxTicks: 6, now: () => 1000 });
  assert.equal(invoke().ticksCompleted, 1);
  assert.equal(invoke().ticksCompleted, 1);
  const lease = harness.acquireSingleFlight(root, "observer", "other");
  assert.throws(invoke, /single-flight/iu);
  harness.releaseSingleFlight(root, lease);
});

test("noncanonical manifests fail before scheduling work", () => {
  assert.throws(() => harness.createScenarioManifest({ scenarioId: "bad", seed: "bad", mode: "toString" }));
  const root = freshRoot("manifest-tamper");
  const manifest = harness.createScenarioManifest({ scenarioId: "bad", seed: "bad", mode: "8h" });
  manifest.durationMs = 0;
  assert.throws(() => harness.runHarness({ root, manifest, policy: harness.createResourcePolicy(), maxTicks: 6 }), /canonical/iu);
});

test("real process crashes recover idempotently at every durable write phase", () => {
  const moduleUrl = pathToFileURL(resolve(import.meta.dirname, "..", "overnight", "harness.mjs")).href;
  for (const phase of ["journal_commit", "receipt", "ledger", "state"]) {
    const root = freshRoot(`process-crash-${phase}`);
    const child = `import * as h from ${JSON.stringify(moduleUrl)};
const manifest=h.createScenarioManifest({scenarioId:${JSON.stringify(`crash-${phase}`)},seed:"crash",mode:"smoke"});
h.runHarness({root:${JSON.stringify(root)},manifest,policy:h.createResourcePolicy(),maxTicks:1,leaseStaleAfterMs:0,driver:{injectFault(c){throw h.createInjectedFault(c)},recoverFault(){},afterPhase(p){if(p.phase===${JSON.stringify(phase)})process.exit(73)}}});`;
    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", child], { encoding: "utf8" });
    assert.equal(crashed.status, 73, `${phase}: ${crashed.stderr}`);
    const manifest = harness.createScenarioManifest({ scenarioId: `crash-${phase}`, seed: "crash", mode: "smoke" });
    const resumed = harness.runHarness({ root, manifest, policy: harness.createResourcePolicy(), maxTicks: 6, leaseStaleAfterMs: 0 });
    assert.equal(resumed.status, "COMPLETED", phase);
    assert.equal(harness.assertAuthoritativeExactlyOnce(root).operationCount, 6, phase);
    const events = harness.recoverRestartJournal(root).events;
    assert.equal(events.filter((event) => event.type === "operation_committed").length, 6, phase);
    assert.ok(events.some((event) => event.type === "persistence_phase" && event.phase === phase), phase);
  }
});

test("resource counters, byte samples, rate, and spend reject over-limit work", () => {
  const root = freshRoot("enforced-resources");
  const policy = harness.createResourcePolicy({
    concurrency: { workers: 1, providers: 1, tests: 1 },
    limits: { cpuPercent: 50, memoryMb: 64, diskMb: 64, operationsPerMinute: 1, spendUsd: 1 },
  });
  const worker = harness.acquireResourceSlot(root, "workers", policy, "worker-a");
  assert.throws(() => harness.acquireResourceSlot(root, "workers", policy, "worker-b"), /workers.*limit/iu);
  harness.releaseResourceSlot(root, worker);
  assert.throws(() => harness.assertResourceSample(policy, { cpuPercent: 51, memoryMb: 1, diskMb: 1 }), /cpu/iu);
  assert.throws(() => harness.assertResourceSample(policy, { cpuPercent: 1, memoryMb: 65, diskMb: 1 }), /memory/iu);
  assert.throws(() => harness.assertResourceSample(policy, { cpuPercent: 1, memoryMb: 1, diskMb: 65 }), /disk/iu);
  assert.equal(harness.recordSpend(root, policy, { idempotencyKey: "charge-1", amountUsd: 0.6 }).spentUsd, 0.6);
  assert.equal(harness.recordSpend(root, policy, { idempotencyKey: "charge-1", amountUsd: 0.6 }).spentUsd, 0.6);
  assert.throws(() => harness.recordSpend(root, policy, { idempotencyKey: "charge-2", amountUsd: 0.5 }), /spend.*limit/iu);
});

test("single-flight ownership rejects a competing process and reclaims a dead stale owner", () => {
  const root = freshRoot("process-lease");
  const lease = harness.acquireSingleFlight(root, "observer", "parent", { staleAfterMs: 60_000 });
  const moduleUrl = pathToFileURL(resolve(import.meta.dirname, "..", "overnight", "harness.mjs")).href;
  const contender = spawnSync(process.execPath, ["--input-type=module", "-e", `import * as h from ${JSON.stringify(moduleUrl)}; try { h.acquireSingleFlight(${JSON.stringify(root)},"observer","child",{staleAfterMs:60000}); process.exit(0) } catch { process.exit(23) }`]);
  assert.equal(contender.status, 23);
  harness.releaseSingleFlight(root, lease);
});

test("fault drivers must throw at named boundaries and persisted state remains scenario-bound", () => {
  const root = freshRoot("driver-effects");
  const manifest = harness.createScenarioManifest({ scenarioId: "driver", seed: "driver", mode: "smoke" });
  const effects = [];
  const driver = {
    injectFault(context) { effects.push(`throw:${context.boundary}`); throw harness.createInjectedFault(context); },
    recoverFault(context) { effects.push(`recover:${context.boundary}`); },
  };
  harness.runHarness({ root, manifest, policy: harness.createResourcePolicy(), maxTicks: 1, driver });
  assert.deepEqual(effects, ["throw:provider", "recover:provider"]);
  const statePath = resolve(root, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.scenarioId = "other";
  writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  assert.throws(() => harness.runHarness({ root, manifest, policy: harness.createResourcePolicy(), maxTicks: 1 }), /state.*scenario/iu);
});

test("settlement idempotency is unique beyond one fault cycle and stable for operation retry", () => {
  const root = freshRoot("settlement-ids");
  const manifest = harness.createScenarioManifest({ scenarioId: "charges", seed: "charges", mode: "8h" });
  const policy = harness.createResourcePolicy({ limits: { spendUsd: 10 } });
  const settlements = [];
  const driver = {
    injectFault(context) {
      settlements.push(context.settlementId);
      const error = harness.createInjectedFault(context);
      error.spendUsd = 1;
      throw error;
    },
    recoverFault() {},
  };
  harness.runHarness({
    root,
    manifest,
    policy,
    maxTicks: 7,
    driver,
    now: () => 1_000,
    resourceSampler: () => ({ cpuPercent: 0, memoryMb: 1, diskMb: 0 }),
  });
  const spend = JSON.parse(readFileSync(resolve(root, "authority", "resource-spend.json"), "utf8"));
  assert.equal(spend.spentUsd, 7);
  assert.equal(Object.keys(spend.charges).length, 7);
  assert.equal(new Set(settlements).size, 7);
});

test("provider charge crash resumes with the same settlement id and settles spend once", () => {
  const root = freshRoot("charge-crash");
  const moduleUrl = pathToFileURL(resolve(import.meta.dirname, "..", "overnight", "harness.mjs")).href;
  const observedPath = resolve(root, "provider-settlement.txt");
  const child = `import * as h from ${JSON.stringify(moduleUrl)}; import {writeFileSync} from "node:fs";
const manifest=h.createScenarioManifest({scenarioId:"charge-crash",seed:"charge",mode:"smoke"});
const policy=h.createResourcePolicy({limits:{spendUsd:2}});
h.runHarness({root:${JSON.stringify(root)},manifest,policy,maxTicks:1,leaseStaleAfterMs:0,resourceSampler:()=>({cpuPercent:0,memoryMb:1,diskMb:0}),driver:{injectFault(c){writeFileSync(${JSON.stringify(observedPath)},c.settlementId);const e=h.createInjectedFault(c);e.spendUsd=1;throw e},recoverFault(){},afterPhase(p){if(p.phase==="provider_charge")process.exit(74)}}});`;
  const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", child], { encoding: "utf8" });
  assert.equal(crashed.status, 74, crashed.stderr);
  const firstSettlement = readFileSync(observedPath, "utf8");
  let resumedSettlement;
  const manifest = harness.createScenarioManifest({ scenarioId: "charge-crash", seed: "charge", mode: "smoke" });
  const policy = harness.createResourcePolicy({ limits: { spendUsd: 2 } });
  const resumed = harness.runHarness({
    root,
    manifest,
    policy,
    maxTicks: 1,
    leaseStaleAfterMs: 0,
    resourceSampler: () => ({ cpuPercent: 0, memoryMb: 1, diskMb: 0 }),
    driver: {
    injectFault(context) { resumedSettlement = context.settlementId; const error = harness.createInjectedFault(context); error.spendUsd = 1; throw error; },
    recoverFault() {},
    },
  });
  const spend = JSON.parse(readFileSync(resolve(root, "authority", "resource-spend.json"), "utf8"));
  assert.equal(resumed.status, "PAUSED");
  assert.equal(resumed.dossier.stopReason, null);
  assert.equal(resumedSettlement, firstSettlement);
  assert.equal(spend.spentUsd, 1);
  assert.equal(Object.keys(spend.charges).length, 1);
});

test("durable state writes do not reuse a fixed pending alias across restarts", () => {
  const root = freshRoot("unique-pending-state");
  mkdirSync(resolve(root, "state.json.pending"), { recursive: true });
  const manifest = harness.createScenarioManifest({ scenarioId: "unique-pending", seed: "pending", mode: "8h" });
  const policy = harness.createResourcePolicy();
  assert.doesNotThrow(() => harness.runHarness({ root, manifest, policy, maxTicks: 1, now: () => 1_000 }));
  assert.equal(JSON.parse(readFileSync(resolve(root, "state.json"), "utf8")).ticksCompleted, 1);
});

test("injectable CPU sampling rejects work and persists a typed blocker", () => {
  const root = freshRoot("cpu-blocker");
  const manifest = harness.createScenarioManifest({ scenarioId: "cpu", seed: "cpu", mode: "8h" });
  const policy = harness.createResourcePolicy({ limits: { cpuPercent: 50 } });
  const result = harness.runHarness({
    root,
    manifest,
    policy,
    maxTicks: 1,
    resourceSampler: () => ({ cpuPercent: 99, memoryMb: 1, diskMb: 1 }),
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.ticksCompleted, 0);
  assert.equal(result.dossier.stopReason.code, "RESOURCE_LIMIT_CPU");
  assert.equal(JSON.parse(readFileSync(resolve(root, "state.json"), "utf8")).stopReason.code, "RESOURCE_LIMIT_CPU");
});

test("process CPU sampling waits for a stable window while memory and disk remain immediate", () => {
  const root = freshRoot("stable-resource-window");
  writeFileSync(resolve(root, "disk-sample.bin"), Buffer.alloc(2 * 1024 * 1024));
  const cpuSamples = [
    { user: 0, system: 0 },
    { user: 90_000, system: 0 },
    { user: 120_000, system: 0 },
  ];
  const timeSamples = [0n, 50_000_000n, 100_000_000n];
  const sampler = harness.createProcessResourceSampler(root, {
    cpuUsage: () => cpuSamples.shift(),
    monotonicNow: () => timeSamples.shift(),
    memoryUsage: () => ({ rss: 2 * 1024 * 1024 * 1024 }),
    availableParallelism: () => 1,
    minimumCpuWindowMicros: 100_000,
  });

  const startup = sampler();
  assert.equal(startup.cpuPercent, 0);
  assert.equal(startup.memoryMb, 2_048);
  assert.ok(startup.diskMb > 0);
  assert.throws(
    () => harness.assertResourceSample(harness.createResourcePolicy(), startup),
    (error) => error.code === "RESOURCE_LIMIT_MEMORY",
  );
  assert.throws(
    () => harness.assertResourceSample(
      harness.createResourcePolicy({ limits: { memoryMb: 4_096, diskMb: 1 } }),
      startup,
    ),
    (error) => error.code === "RESOURCE_LIMIT_DISK",
  );

  const stable = sampler();
  assert.equal(stable.cpuPercent, 120);
  assert.throws(
    () => harness.assertResourceSample(
      harness.createResourcePolicy({ limits: { cpuPercent: 75, memoryMb: 4_096 } }),
      stable,
    ),
    (error) => error.code === "RESOURCE_LIMIT_CPU",
  );
});

test("scheduled work acquires provider, test, and broad-test capacity", () => {
  const policy = harness.createResourcePolicy({ concurrency: { workers: 1, providers: 1, tests: 1 } });
  const manifest = harness.createScenarioManifest({ scenarioId: "slots", seed: "slots", mode: "smoke" });
  for (const kind of ["providers", "tests"]) {
    const root = freshRoot(`scheduled-${kind}`);
    const held = harness.acquireResourceSlot(root, kind, policy, "held");
    assert.throws(() => harness.runHarness({ root, manifest, policy, maxTicks: 1 }), new RegExp(`${kind}.*limit`, "iu"));
    harness.releaseResourceSlot(root, held);
  }
  const root = freshRoot("scheduled-broad-test");
  const held = harness.acquireSingleFlight(root, "broad-test", "held");
  assert.throws(() => harness.runHarness({ root, manifest, policy, maxTicks: 1 }), /single-flight broad-test/iu);
  harness.releaseSingleFlight(root, held);
});

test("acceptance time is derived from fresh same-epoch heartbeats and excludes idle gaps", () => {
  const root = freshRoot("acceptance-heartbeats");
  const binding = harness.createAcceptanceBinding({
    scenarioId: "acceptance-heartbeats",
    mode: "8h",
    evidenceKind: "test",
    sourceSha: "a".repeat(40),
    runnerSha256: "b".repeat(64),
    policySha256: "c".repeat(64),
  });
  harness.persistAcceptanceBinding(root, binding);
  harness.appendJournalEvent(root, { type: "process_epoch_started", epochId: "epoch-a", ...binding.authority });
  harness.appendJournalEvent(root, { type: "heartbeat", epochId: "epoch-a", monotonicMs: 0, wallTimeMs: 1_000 });
  harness.appendJournalEvent(root, { type: "heartbeat", epochId: "epoch-a", monotonicMs: 10_000, wallTimeMs: 11_000 });
  // A sleep/stall-sized gap is evidence of lost observation, not active soak time.
  harness.appendJournalEvent(root, { type: "heartbeat", epochId: "epoch-a", monotonicMs: 80_000, wallTimeMs: 81_000 });
  harness.appendJournalEvent(root, { type: "process_epoch_started", epochId: "epoch-b", ...binding.authority });
  harness.appendJournalEvent(root, { type: "heartbeat", epochId: "epoch-b", monotonicMs: 0, wallTimeMs: 500_000 });
  harness.appendJournalEvent(root, { type: "heartbeat", epochId: "epoch-b", monotonicMs: 5_000, wallTimeMs: 505_000 });

  const evidence = harness.deriveAcceptanceEvidence(root, binding, { maxHeartbeatGapMs: 30_000 });
  assert.equal(evidence.activeElapsedMs, 15_000);
  assert.equal(evidence.excludedGapMs, 70_000);
  assert.equal(evidence.processEpochs, 2);
});

test("8h acceptance requires duration, one hundred real verified runs, and zero provider attempts", () => {
  const root = freshRoot("acceptance-gates");
  const binding = harness.createAcceptanceBinding({
    scenarioId: "acceptance-gates",
    mode: "8h", evidenceKind: "test",
    sourceSha: "d".repeat(40), runnerSha256: "e".repeat(64), policySha256: "f".repeat(64),
  });
  harness.persistAcceptanceBinding(root, binding);
  harness.appendJournalEvent(root, { type: "process_epoch_started", epochId: "epoch", ...binding.authority });
  harness.appendJournalEvent(root, { type: "heartbeat", epochId: "epoch", monotonicMs: 0, wallTimeMs: 1 });
  harness.appendJournalEvent(root, { type: "heartbeat", epochId: "epoch", monotonicMs: binding.requiredDurationMs, wallTimeMs: 1 + binding.requiredDurationMs });
  for (let index = 0; index < 99; index += 1) {
    const runId = `run-${index}`;
    harness.persistIntegratedRunReceipt(root, binding, {
      schemaVersion: "martin.overnight.integrated-run.v1", runId,
      missionId: `mission-${index}`, sourceSha: binding.authority.sourceSha,
      runtimeSourceBindingHash: createHash("sha256").update(binding.authority.sourceSha).digest("hex"),
      bindingAuthorityId: "overnight-exact-source-workspace-v1", executionModel: "in-process-governed-runtime",
      providerAdapterKind: "provider-free-fixture",
      providerAttempts: 0, providerCalls: 0, verified: true, integrated: true, settled: true,
      settlementIds: [runId], checkpointHeadHash: "1".repeat(64), verifierEvidenceHash: "2".repeat(64),
      integratedHash: "3".repeat(64), memoryHeadHash: "4".repeat(64), handoffManifestHash: "5".repeat(64),
      runtimeDossierSha256: writeTestRuntimeDossier(root, runId, binding.authority.sourceSha),
    });
  }
  assert.equal(harness.deriveAcceptanceEvidence(root, binding, { maxHeartbeatGapMs: binding.requiredDurationMs }).requirementsSatisfied, false);
  harness.persistIntegratedRunReceipt(root, binding, {
    schemaVersion: "martin.overnight.integrated-run.v1", runId: "run-99", missionId: "mission-99",
    sourceSha: binding.authority.sourceSha,
    runtimeSourceBindingHash: createHash("sha256").update(binding.authority.sourceSha).digest("hex"),
    bindingAuthorityId: "overnight-exact-source-workspace-v1", executionModel: "in-process-governed-runtime",
    providerAdapterKind: "provider-free-fixture",
    providerAttempts: 0, providerCalls: 0, verified: true, integrated: true, settled: true,
    settlementIds: ["run-99"], checkpointHeadHash: "1".repeat(64), verifierEvidenceHash: "2".repeat(64),
    integratedHash: "3".repeat(64), memoryHeadHash: "4".repeat(64), handoffManifestHash: "5".repeat(64),
    runtimeDossierSha256: writeTestRuntimeDossier(root, "run-99", binding.authority.sourceSha),
  });
  const requirements = harness.deriveAcceptanceEvidence(root, binding, { maxHeartbeatGapMs: binding.requiredDurationMs });
  assert.equal(requirements.requirementsSatisfied, true);
  assert.equal(Object.hasOwn(requirements, "qualified"), false, "library evidence can never assert production qualification");
  harness.appendJournalEvent(root, { type: "provider_attempted", provider: "forbidden", runId: "run-99" });
  assert.equal(Object.hasOwn(harness.deriveAcceptanceEvidence(root, binding, { maxHeartbeatGapMs: binding.requiredDurationMs }), "qualified"), false);
});

test("24h acceptance is bound to a verified 8h predecessor", () => {
  assert.throws(() => harness.createAcceptanceBinding({
    scenarioId: "missing-predecessor", mode: "24h", sourceSha: "1".repeat(40),
    runnerSha256: "2".repeat(64), policySha256: "3".repeat(64),
  }), /predecessor/iu);
  const binding = harness.createAcceptanceBinding({
    scenarioId: "has-predecessor", mode: "24h", evidenceKind: "test", sourceSha: "1".repeat(40),
    runnerSha256: "2".repeat(64), policySha256: "3".repeat(64),
    predecessor8hDossierSha256: "4".repeat(64),
  });
  assert.equal(binding.predecessor8hDossierSha256, "4".repeat(64));
});

test("acceptance ignores mutable state duration and fails authority mismatches", () => {
  const root = freshRoot("acceptance-authority");
  const binding = harness.createAcceptanceBinding({
    scenarioId: "authority", mode: "8h", evidenceKind: "test", sourceSha: "5".repeat(40),
    runnerSha256: "6".repeat(64), policySha256: "7".repeat(64),
  });
  harness.persistAcceptanceBinding(root, binding);
  writeFileSync(resolve(root, "state.json"), JSON.stringify({ activeElapsedMs: binding.requiredDurationMs }));
  assert.equal(harness.deriveAcceptanceEvidence(root, binding).activeElapsedMs, 0);
  const changed = structuredClone(binding);
  changed.authority.sourceSha = "8".repeat(40);
  assert.throws(() => harness.deriveAcceptanceEvidence(root, changed), /binding/iu);
});

test("an incomplete journal tail is quarantined while complete corruption fails closed", () => {
  const root = freshRoot("journal-tail");
  harness.appendJournalEvent(root, { type: "operation_started", operationId: "one" });
  appendFileSync(resolve(root, "restart-journal.jsonl"), '{"type":"operation_started"');
  const recovered = harness.recoverRestartJournal(root);
  assert.equal(recovered.events.length, 1);
  assert.equal(recovered.recoveredIncompleteTail, true);
  appendFileSync(resolve(root, "restart-journal.jsonl"), "not-json\n");
  assert.throws(() => harness.recoverRestartJournal(root), /journal.*json/iu);
});

test("repo-owned evidence roots reject symlink or junction escapes", (t) => {
  const repositoryRoot = freshRoot("repo-root");
  const outside = freshRoot("outside-root");
  const link = resolve(repositoryRoot, "escaped");
  try {
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`host cannot create link fixture: ${error.message}`);
    return;
  }
  assert.throws(() => harness.assertRepoOwnedEvidenceRoot(repositoryRoot, link), /repo-owned|symbolic|junction/iu);
});

test("production acceptance authority is unavailable to imported library callers", () => {
  assert.equal(harness.openDirectCliAcceptanceAuthority, undefined);
  const originalEntrypoint = process.argv[1];
  try {
    process.argv[1] = resolve(import.meta.dirname, "..", "overnight-harness.mjs");
    assert.equal(harness.openDirectCliAcceptanceAuthority, undefined, "mutating process.argv cannot reveal production authority");
  } finally {
    process.argv[1] = originalEntrypoint;
  }
});

test("pre-import process.argv spoof cannot acquire production acceptance authority", () => {
  const probe = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    "import {resolve} from 'node:path'; process.argv[1]=resolve('scripts/overnight-harness.mjs'); const h=await import('./scripts/overnight/harness.mjs?preimport-spoof'); console.log(Boolean(h.openDirectCliAcceptanceAuthority()))",
  ], { cwd: resolve(import.meta.dirname, "..", ".."), encoding: "utf8" });
  assert.notEqual(probe.status, 0);
  assert.doesNotMatch(probe.stdout, /true/iu);
});

test("imported helpers cannot mint or synthesize production acceptance authority", () => {
  const input = {
    scenarioId: "forged-acceptance", mode: "8h", sourceSha: "a".repeat(40),
    runnerSha256: "b".repeat(64), policySha256: "c".repeat(64),
  };
  assert.throws(
    () => harness.createAcceptanceBinding({ ...input, evidenceKind: "acceptance" }),
    /test-only|direct CLI/iu,
  );

  const root = freshRoot("forged-acceptance");
  assert.equal(PRODUCTION_EXECUTION_TRUST_BOUNDARY, "trusted-local-host-with-github-time-anchors-v1");
  assert.equal(Object.hasOwn(harness.createAcceptanceBinding({ ...input, evidenceKind: "test" }), "executionTrustBoundary"), false);
  const forged = {
    ...harness.createAcceptanceBinding({ ...input, evidenceKind: "test" }),
    evidenceKind: "acceptance",
    requiredDurationMs: 30_000,
    minimumBoundedRuns: 1,
    executionTrustBoundary: PRODUCTION_EXECUTION_TRUST_BOUNDARY,
  };
  harness.persistAcceptanceBinding(root, forged);
  harness.appendJournalEvent(root, { type: "process_epoch_started", epochId: "forged", ...forged.authority });
  harness.appendJournalEvent(root, { type: "heartbeat", epochId: "forged", monotonicMs: 0, wallTimeMs: 0 });
  harness.appendJournalEvent(root, { type: "heartbeat", epochId: "forged", monotonicMs: 30_000, wallTimeMs: 30_000 });
  const runId = "forged-run";
  harness.persistIntegratedRunReceipt(root, forged, {
    schemaVersion: "martin.overnight.integrated-run.v1", runId, missionId: "forged-mission",
    sourceSha: forged.authority.sourceSha,
    runtimeSourceBindingHash: createHash("sha256").update(forged.authority.sourceSha).digest("hex"),
    bindingAuthorityId: "overnight-exact-source-workspace-v1", executionModel: "in-process-governed-runtime",
    providerAdapterKind: "provider-free-fixture", providerAttempts: 0, providerCalls: 0,
    verified: true, integrated: true, settled: true, settlementIds: [runId],
    checkpointHeadHash: "1".repeat(64), verifierEvidenceHash: "2".repeat(64),
    integratedHash: "3".repeat(64), memoryHeadHash: "4".repeat(64), handoffManifestHash: "5".repeat(64),
    runtimeDossierSha256: writeTestRuntimeDossier(root, runId, forged.authority.sourceSha),
  });
  const forgedEvidence = harness.deriveAcceptanceEvidence(root, forged);
  assert.equal(forgedEvidence.requirementsSatisfied, true, "old structural evidence is sufficient absent private authority");
  assert.equal(Object.hasOwn(forgedEvidence, "qualified"), false);
  assert.throws(
    () => harness.writeAcceptanceDossier(root, forged, { ...forgedEvidence, qualified: true }, "COMPLETED"),
    /direct CLI entry|qualified evidence/iu,
  );
});

test("core runtime build authority rejects stale or tampered dist bytes", () => {
  const dist = freshRoot("core-runtime-build-authority");
  mkdirSync(resolve(dist, "mission"), { recursive: true });
  mkdirSync(resolve(dist, "persistence"), { recursive: true });
  writeFileSync(resolve(dist, "mission", "index.js"), "export const mission = true;\n");
  writeFileSync(resolve(dist, "persistence", "index.js"), "export const persistence = true;\n");
  const expected = harness.computeCoreRuntimeSha256(dist);
  assert.doesNotThrow(() => harness.assertCoreRuntimeBuildAuthority(dist, expected));
  writeFileSync(resolve(dist, "mission", "index.js"), "export const mission = false;\n");
  assert.throws(() => harness.assertCoreRuntimeBuildAuthority(dist, expected), /runtime build authority mismatch/iu);
});

test("GitHub anchor verification rejects local fabrication, edits, mismatches, and insufficient server elapsed", () => {
  assert.throws(
    () => assertGitHubCliAuthenticated({ status: null, error: new Error("spawn gh ENOENT") }),
    /authenticated GitHub CLI.*ENOENT/iu,
  );
  assert.throws(
    () => assertGitHubCliAuthenticated({ status: 1, stderr: "not logged into any GitHub hosts" }),
    /authenticated GitHub CLI.*not logged/iu,
  );
  const repository = "private-owner/private-repo";
  const issue = 347;
  const actor = { login: "Keesan", association: "MEMBER" };
  const expectedBody = canonicalGitHubAnchorBody({ kind: "start", bindingSha256: "a".repeat(64) });
  const comment = {
    id: 123, html_url: "https://github.com/private-owner/private-repo/issues/347#issuecomment-123",
    issue_url: "https://api.github.com/repos/private-owner/private-repo/issues/347",
    body: expectedBody, created_at: "2026-11-04T00:00:00Z", updated_at: "2026-11-04T00:00:00Z",
    user: { login: "Keesan" }, author_association: "MEMBER",
  };
  const record = parseGitHubAnchorComment({ repository, issue, actor, expectedBody, comment });
  assert.deepEqual(verifyGitHubAnchorRecord({ record, repository, issue, actor, expectedBody, comment }), record);
  assert.throws(() => verifyGitHubAnchorRecord({
    record: { ...record, createdAt: "2026-11-03T00:00:00Z" }, repository, issue, actor, expectedBody, comment,
  }), /persisted GitHub anchor/iu);
  assert.throws(() => parseGitHubAnchorComment({
    repository, issue, actor, expectedBody, comment: { ...comment, updated_at: "2026-11-04T00:01:00Z" },
  }), /edited/iu);
  assert.throws(() => parseGitHubAnchorComment({
    repository, issue, actor, expectedBody, comment: { ...comment, body: `${expectedBody}\nforged=true` },
  }), /does not match/iu);
  assert.throws(() => assertGitHubServerElapsed(
    record,
    { ...record, createdAt: "2026-11-04T07:59:59Z" },
    8 * 60 * 60 * 1_000,
  ), /shorter/iu);
  assert.throws(() => parseGitHubAnchorComment({
    repository, issue, actor, expectedBody, comment: { ...comment, issue_url: `${comment.issue_url}/wrong` },
  }), /missing|does not match/iu);
  assert.throws(() => parseGitHubAnchorComment({
    repository, issue, actor, expectedBody, comment: { ...comment, author_association: "NONE" },
  }), /missing|does not match/iu);
  assert.throws(() => assertGitHubCheckpointCadence({
    start: record,
    checkpoints: [{ ...record, createdAt: "2026-11-04T08:00:00Z" }],
    end: { ...record, createdAt: "2026-11-04T08:00:01Z" },
    minimumCount: 1,
    maxGapMs: 5 * 60_000,
  }), /cadence gap/iu);
});

test("GitHub anchor repository is derived from origin and cadence tolerance scales without allowing batching", () => {
  const expected = "private-owner/private-repo";
  assert.equal(parseGitHubRepositoryFromRemoteUrl("https://github.com/private-owner/private-repo.git", expected), expected);
  assert.equal(parseGitHubRepositoryFromRemoteUrl("git@github.com:private-owner/private-repo.git", expected), expected);
  assert.throws(() => parseGitHubRepositoryFromRemoteUrl("https://github.com/attacker/other.git", expected), /expected repository/iu);
  assert.throws(() => parseGitHubRepositoryFromRemoteUrl("https://example.com/private-owner/private-repo.git", expected), /GitHub origin/iu);
  assert.equal(checkpointMaxGapMs(8 * 60 * 60 * 1_000, 100), 588_000);
  assert.equal(checkpointMaxGapMs(24 * 60 * 60 * 1_000, 100), 1_296_000);
});

test("resume reconciliation selects a run committed before its checkpoint anchor", () => {
  const events = [
    { type: "bounded_run_committed", runId: "run-1", hash: "1".repeat(64) },
    { type: "heartbeat", hash: "2".repeat(64) },
    { type: "bounded_run_committed", runId: "run-2", hash: "3".repeat(64) },
  ];
  assert.deepEqual(pendingGitHubCheckpointEvents(events, 1).map((event) => event.runId), ["run-2"]);
  assert.deepEqual(pendingGitHubCheckpointEvents(events, 0).map((event) => event.runId), ["run-1", "run-2"]);
  assert.throws(() => pendingGitHubCheckpointEvents(events, 3), /exceeds local run evidence/iu);
});

test("acceptance schedules the first bounded run from relative zero with a nonzero monotonic baseline", async () => {
  const root = freshRoot("relative-monotonic-schedule");
  const base = harness.createAcceptanceBinding({
    scenarioId: "relative-monotonic", mode: "8h", evidenceKind: "test",
    sourceSha: "a".repeat(40), runnerSha256: "b".repeat(64), policySha256: "c".repeat(64),
  });
  const binding = { ...base, requiredDurationMs: 1_000, minimumBoundedRuns: 1 };
  let monotonic = 500_000;
  let committed = 0;
  const result = await runContinuousAcceptance({
    root,
    binding,
    policy: harness.createResourcePolicy(),
    monotonicNow: () => monotonic,
    wallNow: () => monotonic - 500_000,
    sleep: async () => { monotonic += 1_000; },
    resourceSampler: () => ({ cpuPercent: 0, memoryMb: 0, diskMb: 0 }),
    fixture: async ({ runId, sourceSha }) => ({
      schemaVersion: "martin.overnight.integrated-run.v1", runId, missionId: "relative-monotonic",
      sourceSha, runtimeSourceBindingHash: createHash("sha256").update(sourceSha).digest("hex"),
      bindingAuthorityId: "overnight-exact-source-workspace-v1", executionModel: "in-process-governed-runtime",
      providerAdapterKind: "provider-free-fixture", providerAttempts: 0, providerCalls: 0,
      verified: true, integrated: true, settled: true, settlementIds: [runId],
      checkpointHeadHash: "1".repeat(64), verifierEvidenceHash: "2".repeat(64), integratedHash: "3".repeat(64),
      memoryHeadHash: "4".repeat(64), handoffManifestHash: "5".repeat(64),
      runtimeDossierSha256: writeTestRuntimeDossier(root, runId, sourceSha),
    }),
    onBoundedRunCommitted: async () => { committed += 1; },
  });
  assert.equal(result.status, "REQUIREMENTS_SATISFIED");
  assert.equal(committed, 1);
});

test("continuous acceptance releases partial capacity when acquisition fails", async () => {
  const root = freshRoot("partial-capacity-acquisition");
  const binding = harness.createAcceptanceBinding({
    scenarioId: "partial-capacity-acquisition", mode: "8h", evidenceKind: "test",
    sourceSha: "a".repeat(40), runnerSha256: "b".repeat(64), policySha256: "c".repeat(64),
  });
  const policy = harness.createResourcePolicy({ concurrency: { workers: 1, providers: 1, tests: 1 } });
  const heldProvider = harness.acquireResourceSlot(root, "providers", policy, "held-provider");
  try {
    await assert.rejects(
      runContinuousAcceptance({ root, binding, policy }),
      /providers.*limit/iu,
    );
    const observer = harness.acquireSingleFlight(root, "observer", "post-failure-observer");
    const worker = harness.acquireResourceSlot(root, "workers", policy, "post-failure-worker");
    harness.releaseResourceSlot(root, worker);
    harness.releaseSingleFlight(root, observer);
  } finally {
    harness.releaseResourceSlot(root, heldProvider);
  }
});

test("continuous acceptance releases every remaining lease when one release fails", async () => {
  const root = freshRoot("release-failure-cleanup");
  const base = harness.createAcceptanceBinding({
    scenarioId: "release-failure-cleanup", mode: "8h", evidenceKind: "test",
    sourceSha: "a".repeat(40), runnerSha256: "b".repeat(64), policySha256: "c".repeat(64),
  });
  const binding = { ...base, requiredDurationMs: 1_000, minimumBoundedRuns: 1 };
  const policy = harness.createResourcePolicy({ concurrency: { workers: 1, providers: 1, tests: 1 } });
  let monotonic = 0;
  await assert.rejects(runContinuousAcceptance({
    root,
    binding,
    policy,
    monotonicNow: () => monotonic,
    wallNow: () => monotonic,
    sleep: async () => { monotonic += 1_000; },
    resourceSampler: () => ({ cpuPercent: 0, memoryMb: 0, diskMb: 0 }),
    fixture: async ({ runId, sourceSha }) => ({
      schemaVersion: "martin.overnight.integrated-run.v1", runId, missionId: "release-failure-cleanup",
      sourceSha, runtimeSourceBindingHash: createHash("sha256").update(sourceSha).digest("hex"),
      bindingAuthorityId: "overnight-exact-source-workspace-v1", executionModel: "in-process-governed-runtime",
      providerAdapterKind: "provider-free-fixture", providerAttempts: 0, providerCalls: 0,
      verified: true, integrated: true, settled: true, settlementIds: [runId],
      checkpointHeadHash: "1".repeat(64), verifierEvidenceHash: "2".repeat(64), integratedHash: "3".repeat(64),
      memoryHeadHash: "4".repeat(64), handoffManifestHash: "5".repeat(64),
      runtimeDossierSha256: writeTestRuntimeDossier(root, runId, sourceSha),
    }),
    onBoundedRunCommitted: async () => {
      const ownerPath = resolve(root, "coordination", "resources", "tests", "slot-0", "owner.json");
      const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
      writeFileSync(ownerPath, JSON.stringify({ ...owner, token: "tampered" }));
    },
  }), /tests resource slot ownership mismatch/iu);

  const observer = harness.acquireSingleFlight(root, "observer", "post-release-failure-observer");
  const worker = harness.acquireResourceSlot(root, "workers", policy, "post-release-failure-worker");
  const provider = harness.acquireResourceSlot(root, "providers", policy, "post-release-failure-provider");
  harness.releaseResourceSlot(root, provider);
  harness.releaseResourceSlot(root, worker);
  harness.releaseSingleFlight(root, observer);
});

test("wall and monotonic divergence earns no active acceptance time", () => {
  const root = freshRoot("clock-divergence");
  const binding = harness.createAcceptanceBinding({
    scenarioId: "clock-divergence", mode: "8h", evidenceKind: "test", sourceSha: "a".repeat(40),
    runnerSha256: "b".repeat(64), policySha256: "c".repeat(64),
  });
  harness.persistAcceptanceBinding(root, binding);
  harness.appendJournalEvent(root, { type: "process_epoch_started", epochId: "epoch", ...binding.authority });
  harness.appendJournalEvent(root, { type: "heartbeat", epochId: "epoch", monotonicMs: 0, wallTimeMs: 1_000 });
  harness.appendJournalEvent(root, { type: "heartbeat", epochId: "epoch", monotonicMs: 10_000, wallTimeMs: 1_001 });
  const evidence = harness.deriveAcceptanceEvidence(root, binding);
  assert.equal(evidence.activeElapsedMs, 0);
  assert.equal(evidence.clockDivergenceMs, 10_000);
});

test("caller-asserted run booleans cannot substitute for a MissionRuntime dossier", () => {
  const root = freshRoot("forged-run-booleans");
  const binding = harness.createAcceptanceBinding({
    scenarioId: "forged-run", mode: "8h", evidenceKind: "test", sourceSha: "a".repeat(40),
    runnerSha256: "b".repeat(64), policySha256: "c".repeat(64),
  });
  harness.persistAcceptanceBinding(root, binding);
  harness.appendJournalEvent(root, {
    type: "bounded_run_committed", runId: "forged", fixture: "mission-runtime-v1",
    verified: true, integrated: true, settled: true, providerCalls: 0,
  });
  const evidence = harness.deriveAcceptanceEvidence(root, binding);
  assert.equal(evidence.boundedRuns, 0);
  assert.equal(evidence.nonqualifyingRuns, 1);
});

test("acceptance core build is launched through the Windows-safe command resolver", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "overnight-harness.mjs"), "utf8");
  assert.match(source, /resolveReleaseCommandExecution\(\["pnpm", "--filter", "@martin\/core", "build"\]\)/u);
  assert.doesNotMatch(source, /execFileSync\([^)]*"pnpm\.cmd"/u);
  const resolved = resolveReleaseCommandExecution(["pnpm", "--filter", "@martin/core", "build"], "win32", "cmd.exe");
  assert.equal(resolved.command, "cmd.exe");
  assert.deepEqual(resolved.args.slice(0, 2), ["/d", "/c"]);
  assert.match(resolved.args[2], /pnpm(\.cmd)?$/iu);
});
