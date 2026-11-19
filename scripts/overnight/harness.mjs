// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, relative } from "node:path";

export const OVERNIGHT_BOUNDARIES = Object.freeze([
  "provider",
  "settlement",
  "receipt",
  "verifier",
  "checkpoint",
  "integration",
]);

const MODE_DURATION_MS = Object.freeze({
  smoke: 0,
  "8h": 8 * 60 * 60 * 1_000,
  "24h": 24 * 60 * 60 * 1_000,
});

const DEFAULT_RESOURCE_POLICY = Object.freeze({
  concurrency: Object.freeze({ workers: 2, providers: 1, tests: 1, observer: 1, broadTests: 1 }),
  limits: Object.freeze({
    cpuPercent: 75,
    memoryMb: 1_024,
    diskMb: 2_048,
    operationsPerMinute: 60,
    spendUsd: 0,
  }),
});

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function computeCoreRuntimeSha256(coreRuntimeRoot) {
  const root = realpathSync.native(coreRuntimeRoot);
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("core runtime build must not contain symbolic links or junctions");
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  for (const required of [join(root, "mission", "index.js"), join(root, "persistence", "index.js")]) {
    if (!files.includes(required)) throw new Error("core runtime build is incomplete");
  }
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(relative(root, path).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function assertCoreRuntimeBuildAuthority(coreRuntimeRoot, expectedSha256) {
  assertHex(expectedSha256, 64, "coreRuntimeSha256");
  const actual = computeCoreRuntimeSha256(coreRuntimeRoot);
  if (actual !== expectedSha256) throw new Error("core runtime build authority mismatch");
  return actual;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function paths(root) {
  return {
    manifest: join(root, "scenario.json"),
    journal: join(root, "restart-journal.jsonl"),
    policy: join(root, "resource-policy.json"),
    state: join(root, "state.json"),
    ledger: join(root, "authority", "ledger.jsonl"),
    receipts: join(root, "authority", "receipts"),
    dossier: join(root, "morning-dossier.json"),
    spend: join(root, "authority", "resource-spend.json"),
    acceptanceBinding: join(root, "acceptance-binding.json"),
    acceptanceDossier: join(root, "acceptance-dossier.json"),
  };
}

function readJsonIfPresent(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function writeTextDurable(path, text, flag = "w") {
  const handle = openSync(path, flag);
  try {
    writeSync(handle, text, null, "utf8");
    fsyncSync(handle);
  } finally { closeSync(handle); }
}

function appendTextDurable(path, text) {
  writeTextDurable(path, text, "a");
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const pending = `${path}.pending.${process.pid}.${randomUUID()}`;
  try {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    writeTextDurable(pending, text, "wx");
    try {
      renameSync(pending, path);
    } catch (error) {
      // Some Windows synchronized filesystems deny replacement rename while
      // allowing creation and durable in-place projection writes. Authority is
      // held by immutable/hash-chained records; these mutable JSON files are
      // rebuildable projections and malformed crash remnants fail JSON parsing.
      if (error?.code !== "EPERM" || !existsSync(path)) throw error;
      writeTextDurable(path, text, "w");
    }
  } finally {
    try { unlinkSync(pending); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

export function createScenarioManifest({ scenarioId, seed, mode }) {
  if (!scenarioId || !seed || !Object.hasOwn(MODE_DURATION_MS, mode)) {
    throw new Error("scenarioId, seed, and mode (smoke, 8h, or 24h) are required");
  }
  return {
    schemaVersion: "martin.overnight.scenario.v1",
    scenarioId,
    seed,
    mode,
    durationMs: MODE_DURATION_MS[mode],
    boundaries: [...OVERNIGHT_BOUNDARIES],
    faults: OVERNIGHT_BOUNDARIES.map((boundary, index) => ({
      boundary,
      triggerOrdinal: 1 + (Number.parseInt(digest(`${seed}\0${boundary}`).slice(0, 8), 16) % 3),
      faultId: digest(`${scenarioId}\0${seed}\0${boundary}\0${index}`).slice(0, 24),
    })),
  };
}

export function createResourcePolicy(overrides = {}) {
  const policy = {
    schemaVersion: "martin.overnight.resource-policy.v1",
    concurrency: { ...DEFAULT_RESOURCE_POLICY.concurrency, ...overrides.concurrency },
    limits: { ...DEFAULT_RESOURCE_POLICY.limits, ...overrides.limits },
  };
  const { concurrency, limits } = policy;
  const positiveIntegers = [
    concurrency.workers,
    concurrency.providers,
    concurrency.tests,
    limits.memoryMb,
    limits.diskMb,
    limits.operationsPerMinute,
  ];
  const valid = positiveIntegers.every((value) => Number.isSafeInteger(value) && value > 0)
    && concurrency.workers <= 64
    && concurrency.providers <= concurrency.workers
    && concurrency.tests <= concurrency.workers
    && concurrency.observer === 1
    && concurrency.broadTests === 1
    && Number.isFinite(limits.cpuPercent)
    && limits.cpuPercent > 0
    && limits.cpuPercent <= 95
    && Number.isFinite(limits.spendUsd)
    && limits.spendUsd >= 0;
  if (!valid) throw new Error("bounded resource policy validation failed");
  return policy;
}

export function persistScenario(root, manifest) {
  mkdirSync(root, { recursive: true });
  writeJsonAtomic(paths(root).manifest, manifest);
  return paths(root).manifest;
}

export function recoverRestartJournal(root) {
  let contents = "";
  try {
    contents = readFileSync(paths(root).journal, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let recoveredIncompleteTail = false;
  let lines = contents ? contents.split("\n") : [];
  if (lines.at(-1) === "") lines = lines.slice(0, -1);
  const events = [];
  for (const [index, line] of lines.entries()) {
    if (!line && index === lines.length - 1) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      const isIncompleteTail = index === lines.length - 1 && !contents.endsWith("\n");
      if (!isIncompleteTail) throw new Error(`restart journal invalid JSON at sequence ${index + 1}`, { cause: error });
      const quarantine = join(root, `restart-journal.incomplete-${digest(line).slice(0, 16)}.txt`);
      if (!existsSync(quarantine)) writeTextDurable(quarantine, line, "wx");
      writeTextDurable(paths(root).journal, events.length ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n` : "");
      recoveredIncompleteTail = true;
    }
  }
  let previousHash = "0".repeat(64);
  const started = new Set();
  const committed = new Set();
  for (const [index, event] of events.entries()) {
    const { hash, ...unsigned } = event;
    const expectedSequence = index + 1;
    const expectedHash = digest(`${previousHash}\0${canonicalJson(unsigned)}`);
    if (event.sequence !== expectedSequence || event.previousHash !== previousHash || hash !== expectedHash) {
      throw new Error(`restart journal integrity failure at sequence ${expectedSequence}`);
    }
    if (event.type === "operation_started") started.add(event.operationId);
    if (event.type === "operation_committed") committed.add(event.operationId);
    previousHash = hash;
  }
  return {
    events,
    nextSequence: events.length + 1,
    headHash: previousHash,
    pendingOperations: [...started].filter((operationId) => !committed.has(operationId)).sort(),
    committedOperations: [...committed].sort(),
    recoveredIncompleteTail,
  };
}

function assertHex(value, length, name) {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value)) {
    throw new Error(`${name} must be a ${length}-character lowercase hexadecimal digest`);
  }
}

function buildAcceptanceBinding({
  scenarioId, mode, sourceSha, runnerSha256, policySha256, coreRuntimeSha256 = null,
  predecessor8hDossierSha256 = null,
  evidenceKind,
}) {
  if (!scenarioId || !new Set(["8h", "24h"]).has(mode)) throw new Error("acceptance mode must be 8h or 24h");
  if (!new Set(["acceptance", "test"]).has(evidenceKind)) throw new Error("evidenceKind must be acceptance or test");
  assertHex(sourceSha, 40, "sourceSha");
  assertHex(runnerSha256, 64, "runnerSha256");
  assertHex(policySha256, 64, "policySha256");
  if (coreRuntimeSha256 === null && evidenceKind === "acceptance") {
    throw new Error("production acceptance requires a trusted core runtime build digest");
  }
  coreRuntimeSha256 ??= "0".repeat(64);
  assertHex(coreRuntimeSha256, 64, "coreRuntimeSha256");
  if (mode === "24h" && predecessor8hDossierSha256 === null) {
    throw new Error("24h acceptance requires a verified 8h predecessor dossier digest");
  }
  if (predecessor8hDossierSha256 !== null) assertHex(predecessor8hDossierSha256, 64, "predecessor8hDossierSha256");
  const authority = { sourceSha, runnerSha256, policySha256, coreRuntimeSha256 };
  return {
    schemaVersion: "martin.overnight.acceptance-binding.v1",
    scenarioId,
    mode,
    requiredDurationMs: MODE_DURATION_MS[mode],
    minimumBoundedRuns: 100,
    evidenceKind,
    predecessor8hDossierSha256,
    authority,
  };
}

export function createAcceptanceBinding(input) {
  if (input?.evidenceKind !== undefined && input.evidenceKind !== "test") {
    throw new Error("exported acceptance binding helpers are test-only; production authority requires the direct CLI");
  }
  return buildAcceptanceBinding({ ...input, evidenceKind: "test" });
}

export function persistIntegratedRunReceipt(root, binding, receipt) {
  if (receipt?.schemaVersion !== "martin.overnight.integrated-run.v1"
    || typeof receipt.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(receipt.runId)
    || typeof receipt.missionId !== "string" || receipt.sourceSha !== binding.authority.sourceSha
    || receipt.runtimeSourceBindingHash !== digest(receipt.sourceSha)
    || receipt.bindingAuthorityId !== "overnight-exact-source-workspace-v1"
    || receipt.executionModel !== "in-process-governed-runtime"
    || receipt.providerAdapterKind !== "provider-free-fixture"
    || receipt.providerAttempts !== 0 || receipt.providerCalls !== 0
    || !Array.isArray(receipt.settlementIds) || receipt.settlementIds.length < 1
    || receipt.verified !== true || receipt.integrated !== true || receipt.settled !== true) {
    throw new Error("integrated MissionRuntime receipt is incomplete or does not match acceptance authority");
  }
  assertHex(receipt.runtimeDossierSha256, 64, "runtimeDossierSha256");
  for (const [name, value] of [["checkpointHeadHash", receipt.checkpointHeadHash],
    ["verifierEvidenceHash", receipt.verifierEvidenceHash], ["integratedHash", receipt.integratedHash],
    ["memoryHeadHash", receipt.memoryHeadHash], ["handoffManifestHash", receipt.handoffManifestHash]]) {
    assertHex(value, 64, name);
  }
  const runtimeDossier = readJsonIfPresent(join(root, "integrated-runs", receipt.runId, "runtime-dossier.json"));
  if (runtimeDossier === null || digest(JSON.stringify(runtimeDossier)) !== receipt.runtimeDossierSha256) {
    throw new Error("integrated MissionRuntime dossier is missing or does not match its receipt");
  }
  const relativeReceiptPath = `authority/runs/${receipt.runId}/acceptance-receipt.json`;
  const target = join(root, ...relativeReceiptPath.split("/"));
  const existing = readJsonIfPresent(target);
  if (existing !== null && canonicalJson(existing) !== canonicalJson(receipt)) {
    throw new Error("integrated MissionRuntime receipt conflict");
  }
  if (existing === null) writeJsonAtomic(target, receipt);
  const receiptSha256 = digest(canonicalJson(receipt));
  const prior = recoverRestartJournal(root).events.find((event) => event.type === "bounded_run_committed" && event.runId === receipt.runId);
  const event = { type: "bounded_run_committed", runId: receipt.runId, receiptPath: relativeReceiptPath, receiptSha256 };
  if (prior) {
    const { sequence, previousHash, hash, ...payload } = prior;
    if (canonicalJson(payload) !== canonicalJson(event)) throw new Error("bounded run journal conflict");
  } else appendJournalEvent(root, event);
  return { receiptPath: target, receiptSha256 };
}

export function persistAcceptanceBinding(root, binding) {
  mkdirSync(root, { recursive: true });
  const target = paths(root).acceptanceBinding;
  const existing = readJsonIfPresent(target);
  if (existing !== null && canonicalJson(existing) !== canonicalJson(binding)) {
    throw new Error("persisted acceptance binding does not match requested binding");
  }
  if (existing === null) writeJsonAtomic(target, binding);
  return target;
}

export function deriveAcceptanceEvidence(root, binding, { maxHeartbeatGapMs = 30_000, clockToleranceMs = 2_000 } = {}) {
  if (!Number.isFinite(maxHeartbeatGapMs) || maxHeartbeatGapMs <= 0) throw new Error("invalid heartbeat gap policy");
  if (!Number.isFinite(clockToleranceMs) || clockToleranceMs < 0) throw new Error("invalid heartbeat clock tolerance");
  const persisted = readJsonIfPresent(paths(root).acceptanceBinding);
  if (persisted === null || canonicalJson(persisted) !== canonicalJson(binding)) {
    throw new Error("acceptance binding mismatch");
  }
  const events = recoverRestartJournal(root).events;
  const epochAuthority = new Map();
  const lastHeartbeat = new Map();
  const runIds = new Set();
  let activeElapsedMs = 0;
  let excludedGapMs = 0;
  let clockDivergenceMs = 0;
  let providerAttempts = 0;
  let boundedRuns = 0;
  let nonqualifyingRuns = 0;
  const boundariesExercised = new Set();
  for (const event of events) {
    if (event.type === "process_epoch_started") {
      if (!event.epochId || epochAuthority.has(event.epochId)) throw new Error("duplicate or invalid process epoch");
      const authority = {
        sourceSha: event.sourceSha,
        runnerSha256: event.runnerSha256,
        policySha256: event.policySha256,
        coreRuntimeSha256: event.coreRuntimeSha256,
      };
      if (canonicalJson(authority) !== canonicalJson(binding.authority)) throw new Error("process epoch authority binding mismatch");
      epochAuthority.set(event.epochId, authority);
    } else if (event.type === "heartbeat") {
      if (!epochAuthority.has(event.epochId) || !Number.isFinite(event.monotonicMs) || event.monotonicMs < 0) {
        throw new Error("heartbeat has no valid process epoch authority");
      }
      if (!Number.isFinite(event.wallTimeMs) || event.wallTimeMs < 0) throw new Error("heartbeat wall time is invalid");
      const previous = lastHeartbeat.get(event.epochId);
      if (previous !== undefined) {
        const monotonicDelta = event.monotonicMs - previous.monotonicMs;
        const wallDelta = event.wallTimeMs - previous.wallTimeMs;
        if (monotonicDelta < 0) throw new Error("heartbeat monotonic time regressed");
        if (wallDelta < 0) throw new Error("heartbeat wall time regressed");
        if (Math.abs(monotonicDelta - wallDelta) > clockToleranceMs) {
          clockDivergenceMs += Math.max(monotonicDelta, wallDelta);
        } else if (monotonicDelta <= maxHeartbeatGapMs) activeElapsedMs += monotonicDelta;
        else excludedGapMs += monotonicDelta;
      }
      lastHeartbeat.set(event.epochId, { monotonicMs: event.monotonicMs, wallTimeMs: event.wallTimeMs });
    } else if (event.type === "provider_attempted") {
      providerAttempts += 1;
    } else if (event.type === "bounded_run_committed") {
      if (!event.runId || runIds.has(event.runId)) throw new Error("duplicate bounded run evidence");
      runIds.add(event.runId);
      const safeRelative = typeof event.receiptPath === "string" && event.receiptPath === `authority/runs/${event.runId}/acceptance-receipt.json`;
      const receipt = safeRelative ? readJsonIfPresent(join(root, ...event.receiptPath.split("/"))) : null;
      const receiptHash = receipt === null ? null : digest(canonicalJson(receipt));
      const runtimeDossier = receipt === null ? null : readJsonIfPresent(join(root, "integrated-runs", event.runId, "runtime-dossier.json"));
      const runtimeState = runtimeDossier?.state;
      const runtimeVerified = runtimeDossier?.schemaVersion === "martin.mission-runtime-dossier.v1"
        && runtimeState?.bindings?.sourceSha === receipt?.runtimeSourceBindingHash
        && Array.isArray(runtimeState?.queue) && runtimeState.queue.length > 0
        && runtimeState.queue.every((item) => item.phase === "integrated")
        && Object.values(runtimeState?.verifications ?? {}).length > 0
        && Object.values(runtimeState?.verifications ?? {}).every((item) => item?.passed === true)
        && Array.isArray(runtimeState?.settlement?.settlementIds) && runtimeState.settlement.settlementIds.length > 0
        && runtimeState?.settlement?.budget?.spentUsd === 0
        && digest(JSON.stringify(runtimeDossier)) === receipt?.runtimeDossierSha256;
      const qualifying = receipt?.schemaVersion === "martin.overnight.integrated-run.v1"
        && receipt.runId === event.runId && receipt.sourceSha === binding.authority.sourceSha
        && receipt.runtimeSourceBindingHash === digest(receipt.sourceSha)
        && receipt.bindingAuthorityId === "overnight-exact-source-workspace-v1"
        && receipt.executionModel === "in-process-governed-runtime"
        && receipt.providerAdapterKind === "provider-free-fixture" && receipt.providerAttempts === 0
        && /^[a-f0-9]{64}$/u.test(receipt.checkpointHeadHash ?? "")
        && /^[a-f0-9]{64}$/u.test(receipt.verifierEvidenceHash ?? "")
        && /^[a-f0-9]{64}$/u.test(receipt.integratedHash ?? "")
        && /^[a-f0-9]{64}$/u.test(receipt.memoryHeadHash ?? "")
        && /^[a-f0-9]{64}$/u.test(receipt.handoffManifestHash ?? "")
        && Array.isArray(receipt.settlementIds)
        && canonicalJson(receipt.settlementIds) === canonicalJson(runtimeState?.settlement?.settlementIds)
        && runtimeVerified
        && receipt.verified === true && receipt.integrated === true && receipt.settled === true
        && receipt.providerCalls === 0 && receiptHash === event.receiptSha256;
      if (qualifying) boundedRuns += 1;
      else nonqualifyingRuns += 1;
      if (qualifying) for (const boundary of OVERNIGHT_BOUNDARIES) boundariesExercised.add(boundary);
      providerAttempts += Number.isSafeInteger(receipt?.providerCalls) && receipt.providerCalls > 0 ? receipt.providerCalls : 0;
      providerAttempts += Number.isSafeInteger(receipt?.providerAttempts) && receipt.providerAttempts > 0 ? receipt.providerAttempts : 0;
    }
  }
  const requirementsSatisfied = activeElapsedMs >= binding.requiredDurationMs
    && boundedRuns >= binding.minimumBoundedRuns
    && nonqualifyingRuns === 0
    && providerAttempts === 0
    && clockDivergenceMs === 0
    && boundariesExercised.size === OVERNIGHT_BOUNDARIES.length
    && epochAuthority.size > 0;
  return {
    activeElapsedMs,
    excludedGapMs,
    clockDivergenceMs,
    processEpochs: epochAuthority.size,
    boundedRuns,
    nonqualifyingRuns,
    boundariesExercised: [...boundariesExercised].sort(),
    providerAttempts,
    providerFree: providerAttempts === 0,
    requirementsSatisfied,
    journalHeadHash: recoverRestartJournal(root).headHash,
  };
}

export function writeAcceptanceDossier(root, binding, evidence, status) {
  if (!new Set(["RUNNING", "PAUSED"]).has(status)) {
    throw new Error("completed acceptance dossiers can only be written by the direct CLI entry module");
  }
  if (Object.hasOwn(evidence, "qualified")) {
    throw new Error("library evidence is structural and cannot assert acceptance qualification");
  }
  const dossier = {
    schemaVersion: "martin.overnight.acceptance-dossier.v1",
    scenarioId: binding.scenarioId,
    mode: binding.mode,
    evidenceKind: binding.evidenceKind,
    status,
    authority: binding.authority,
    predecessor8hDossierSha256: binding.predecessor8hDossierSha256,
    requiredDurationMs: binding.requiredDurationMs,
    minimumBoundedRuns: binding.minimumBoundedRuns,
    evidence,
  };
  const sha256 = digest(canonicalJson(dossier));
  const generationPath = join(root, "dossiers", `${evidence.journalHeadHash}-${status.toLowerCase()}.json`);
  const generation = readJsonIfPresent(generationPath);
  if (generation !== null && canonicalJson(generation) !== canonicalJson(dossier)) {
    throw new Error("acceptance dossier generation conflict");
  }
  if (generation === null) writeJsonAtomic(generationPath, dossier);
  return { dossier, sha256, path: generationPath };
}

export function assertRepoOwnedEvidenceRoot(repositoryRoot, targetRoot) {
  const repositoryReal = realpathSync.native(repositoryRoot);
  let cursor = targetRoot;
  const missing = [];
  while (!existsSync(cursor)) {
    missing.unshift(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error("evidence root is not repo-owned");
    cursor = parent;
  }
  if (lstatSync(cursor).isSymbolicLink()) throw new Error("evidence root symbolic link or junction is forbidden");
  const existingReal = realpathSync.native(cursor);
  const candidateReal = missing.reduce((parent, item) => join(parent, item.slice(dirname(item).length + 1)), existingReal);
  const relativeRoot = relative(repositoryReal, candidateReal);
  if (!relativeRoot || relativeRoot.startsWith("..") || isAbsolutePath(relativeRoot)) {
    throw new Error("evidence root must be a repo-owned child path");
  }
  return candidateReal;
}

function isAbsolutePath(value) {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("/");
}

export function appendJournalEvent(root, event) {
  mkdirSync(root, { recursive: true });
  const recovered = recoverRestartJournal(root);
  const unsigned = {
    ...event,
    sequence: recovered.nextSequence,
    previousHash: recovered.headHash,
  };
  const record = { ...unsigned, hash: digest(`${recovered.headHash}\0${canonicalJson(unsigned)}`) };
  appendTextDurable(paths(root).journal, `${JSON.stringify(record)}\n`);
  return record;
}

export function assertExactlyOnce(events) {
  const operations = new Set();
  const receipts = new Set();
  for (const event of events) {
    if (event.type !== "operation_committed") continue;
    if (operations.has(event.operationId) || receipts.has(event.receiptId)) {
      throw new Error(`exactly-once invariant violated by ${event.operationId}/${event.receiptId}`);
    }
    operations.add(event.operationId);
    receipts.add(event.receiptId);
  }
  return { operationCount: operations.size, receiptCount: receipts.size };
}

export function assertAuthoritativeExactlyOnce(root) {
  const runPaths = paths(root);
  let ledgerText;
  try {
    ledgerText = readFileSync(runPaths.ledger, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") ledgerText = "";
    else throw error;
  }
  const ledger = ledgerText.trim() ? ledgerText.trimEnd().split("\n").map((line) => JSON.parse(line)) : [];
  const operationIds = new Set();
  const receiptIds = new Set();
  for (const entry of ledger) {
    if (operationIds.has(entry.operationId) || receiptIds.has(entry.receiptId)) {
      throw new Error(`authoritative exactly-once invariant violated by ${entry.operationId}/${entry.receiptId}`);
    }
    operationIds.add(entry.operationId);
    receiptIds.add(entry.receiptId);
    const receiptPath = join(runPaths.receipts, `${entry.receiptId}.json`);
    const receipt = readJsonIfPresent(receiptPath);
    if (!receipt || canonicalJson(receipt) !== canonicalJson(entry)) {
      throw new Error(`authoritative exactly-once receipt mismatch for ${entry.receiptId}`);
    }
  }
  const commits = recoverRestartJournal(root).events.filter((event) => event.type === "operation_committed");
  assertExactlyOnce(commits);
  if (commits.length !== ledger.length || commits.some((commit) => !ledger.some((entry) =>
    entry.operationId === commit.operationId && entry.receiptId === commit.receiptId
    && entry.boundary === commit.boundary && entry.journalHash === commit.hash))) {
    throw new Error("authoritative exactly-once journal parity mismatch");
  }
  const receiptFiles = listFiles(runPaths.receipts);
  if (receiptFiles.length !== ledger.length) {
    throw new Error(`authoritative exactly-once count mismatch: ledger=${ledger.length} receipts=${receiptFiles.length}`);
  }
  return { operationCount: operationIds.size, receiptCount: receiptIds.size };
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function acquireNamedLease(root, name, holderId, { staleAfterMs = 30_000, now = Date.now } = {}) {
  if (!holderId || !Number.isFinite(staleAfterMs) || staleAfterMs < 0) throw new Error("invalid lease options");
  const coordination = join(root, "coordination");
  const leaseDirectory = join(coordination, `${name}.lease`);
  mkdirSync(coordination, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID();
    try {
      mkdirSync(leaseDirectory);
      const lease = { schemaVersion: "martin.overnight.single-flight.v2", name, holderId, token, pid: process.pid, heartbeatMs: now() };
      writeJsonAtomic(join(leaseDirectory, "owner.json"), lease);
      return lease;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = readJsonIfPresent(join(leaseDirectory, "owner.json"));
      const lastHeartbeatMs = owner?.heartbeatMs ?? statSync(leaseDirectory).mtimeMs;
      const stale = now() - lastHeartbeatMs >= staleAfterMs && !processIsAlive(owner?.pid);
      if (!stale) throw new Error(`single-flight ${name} lease is already held`);
      const quarantine = `${leaseDirectory}.stale-${owner?.token ?? "ownerless"}-${randomUUID()}`;
      try {
        renameSync(leaseDirectory, quarantine);
        rmSync(quarantine, { recursive: true, force: true });
      } catch (reclaimError) {
        if (reclaimError?.code !== "ENOENT") throw new Error(`single-flight ${name} stale reclaim failed`);
      }
    }
  }
  throw new Error(`single-flight ${name} lease acquisition exhausted`);
}

export function acquireSingleFlight(root, name, holderId, options) {
  if (!new Set(["observer", "broad-test"]).has(name) || !holderId) {
    throw new Error("single-flight lease requires observer or broad-test and a holderId");
  }
  return acquireNamedLease(root, name, holderId, options);
}

export function releaseSingleFlight(root, lease) {
  const leaseDirectory = join(root, "coordination", `${lease.name}.lease`);
  const current = JSON.parse(readFileSync(join(leaseDirectory, "owner.json"), "utf8"));
  if (current.token !== lease.token || current.holderId !== lease.holderId) {
    throw new Error(`single-flight ${lease.name} lease token mismatch`);
  }
  rmSync(leaseDirectory, { recursive: true });
}

export function heartbeatSingleFlight(root, lease, now = Date.now) {
  const ownerPath = join(root, "coordination", `${lease.name}.lease`, "owner.json");
  const current = JSON.parse(readFileSync(ownerPath, "utf8"));
  if (current.token !== lease.token || current.pid !== process.pid) throw new Error(`single-flight ${lease.name} heartbeat ownership mismatch`);
  const refreshed = { ...current, heartbeatMs: now() };
  writeJsonAtomic(ownerPath, refreshed);
  return refreshed;
}

export function acquireResourceSlot(root, kind, policy, holderId) {
  if (!new Set(["workers", "providers", "tests"]).has(kind)) throw new Error(`unknown resource slot ${kind}`);
  const limit = policy.concurrency[kind];
  const base = join(root, "coordination", "resources", kind);
  mkdirSync(base, { recursive: true });
  for (let slot = 0; slot < limit; slot += 1) {
    const directory = join(base, `slot-${slot}`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        mkdirSync(directory);
        const lease = { kind, slot, holderId, token: randomUUID(), pid: process.pid };
        writeJsonAtomic(join(directory, "owner.json"), lease);
        return lease;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const owner = readJsonIfPresent(join(directory, "owner.json"));
        if (!owner || processIsAlive(owner.pid)) break;
        const quarantine = `${directory}.stale-${randomUUID()}`;
        try { renameSync(directory, quarantine); rmSync(quarantine, { recursive: true, force: true }); }
        catch (reclaimError) { if (reclaimError?.code !== "ENOENT") break; }
      }
    }
  }
  throw new Error(`${kind} concurrency limit ${limit} reached`);
}

export function releaseResourceSlot(root, lease) {
  const directory = join(root, "coordination", "resources", lease.kind, `slot-${lease.slot}`);
  const owner = readJsonIfPresent(join(directory, "owner.json"));
  if (!owner || owner.token !== lease.token) throw new Error(`${lease.kind} resource slot ownership mismatch`);
  rmSync(directory, { recursive: true });
}

export function assertResourceSample(policy, sample) {
  if (!sample) throw new Error("resource sample is required");
  const fail = (resource, observed, limit) => {
    const error = new Error(`${resource} resource limit exceeded`);
    error.code = `RESOURCE_LIMIT_${resource.toUpperCase()}`;
    error.resource = resource;
    error.observed = observed;
    error.limit = limit;
    throw error;
  };
  if (sample.cpuPercent > policy.limits.cpuPercent) fail("cpu", sample.cpuPercent, policy.limits.cpuPercent);
  if (sample.memoryMb > policy.limits.memoryMb) fail("memory", sample.memoryMb, policy.limits.memoryMb);
  if (sample.diskMb > policy.limits.diskMb) fail("disk", sample.diskMb, policy.limits.diskMb);
  return sample;
}

export function createProcessResourceSampler(root, dependencies = {}) {
  const cpuUsage = dependencies.cpuUsage ?? (() => process.cpuUsage());
  const monotonicNow = dependencies.monotonicNow ?? (() => process.hrtime.bigint());
  const memoryUsage = dependencies.memoryUsage ?? (() => process.memoryUsage());
  const parallelism = dependencies.availableParallelism ?? (() => availableParallelism());
  const minimumCpuWindowMicros = dependencies.minimumCpuWindowMicros ?? 100_000;
  if (!Number.isSafeInteger(minimumCpuWindowMicros) || minimumCpuWindowMicros < 1) {
    throw new Error("minimum CPU observation window must be a positive integer");
  }
  let priorCpu = cpuUsage();
  let priorTime = monotonicNow();
  return () => {
    const currentCpu = cpuUsage();
    const currentTime = monotonicNow();
    const elapsedMicros = Math.max(1, Number(currentTime - priorTime) / 1_000);
    const usedMicros = (currentCpu.user - priorCpu.user) + (currentCpu.system - priorCpu.system);
    const cpuWindowReady = elapsedMicros >= minimumCpuWindowMicros;
    if (cpuWindowReady) {
      priorCpu = currentCpu;
      priorTime = currentTime;
    }
    const diskBytes = listFiles(root).reduce((total, file) => total + statSync(file).size, 0);
    return {
      // A sub-window CPU ratio is startup noise, not a durable resource signal.
      // Keep accumulating from the original baseline until the window is valid;
      // memory and disk remain enforceable on every sample.
      cpuPercent: cpuWindowReady
        ? (Math.max(0, usedMicros) / elapsedMicros / Math.max(1, parallelism())) * 100
        : 0,
      memoryMb: memoryUsage().rss / 1024 / 1024,
      diskMb: diskBytes / 1024 / 1024,
    };
  };
}

export function recordSpend(root, policy, { idempotencyKey, amountUsd }) {
  if (!idempotencyKey || !Number.isFinite(amountUsd) || amountUsd < 0) throw new Error("invalid spend record");
  const lock = acquireNamedLease(root, "spend", `pid-${process.pid}`, { staleAfterMs: 30_000 });
  try {
    const spendPath = paths(root).spend;
    const state = readJsonIfPresent(spendPath) ?? { schemaVersion: "martin.overnight.spend.v1", spentUsd: 0, charges: {} };
    if (Object.hasOwn(state.charges, idempotencyKey)) return state;
    const next = state.spentUsd + amountUsd;
    if (next > policy.limits.spendUsd) throw new Error(`spend limit ${policy.limits.spendUsd} exceeded`);
    const updated = { ...state, spentUsd: next, charges: { ...state.charges, [idempotencyKey]: amountUsd } };
    writeJsonAtomic(spendPath, updated);
    return updated;
  } finally { releaseSingleFlight(root, lock); }
}

function listFiles(directory) {
  const files = [];
  let entries = [];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export function rotateEphemeralArtifacts(root, { maxFilesPerKind }) {
  if (!Number.isSafeInteger(maxFilesPerKind) || maxFilesPerKind < 1) {
    throw new Error("rotation maxFilesPerKind must be a positive integer");
  }
  const deleted = [];
  for (const kind of ["logs", "artifacts"]) {
    const directory = join(root, kind);
    try {
      if (lstatSync(directory).isSymbolicLink()) throw new Error("rotation refuses symbolic link directories");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const files = listFiles(directory).sort((left, right) => relative(directory, left).localeCompare(relative(directory, right)));
    for (const path of files.slice(0, Math.max(0, files.length - maxFilesPerKind))) {
      unlinkSync(path);
      deleted.push(relative(root, path));
    }
  }
  return { deleted, preservedAuthority: ["authority/ledger.jsonl", "authority/receipts/"] };
}

export function createInjectedFault(context) {
  const error = new Error(`injected ${context.boundary} fault`);
  error.code = "MARTIN_OVERNIGHT_INJECTED_FAULT";
  error.boundary = context.boundary;
  error.faultId = context.faultId;
  error.attemptId = context.attemptId;
  error.settlementId = context.settlementId;
  return error;
}

const DEFAULT_FAULT_DRIVER = Object.freeze({
  injectFault(context) { throw createInjectedFault(context); },
  recoverFault() {},
  afterPhase() {},
});

export function runHarness(options) {
  const lease = acquireSingleFlight(options.root, "observer", `pid-${process.pid}`, { staleAfterMs: options.leaseStaleAfterMs ?? 30_000 });
  let broadTest;
  let worker;
  let provider;
  let testSlot;
  try {
    broadTest = acquireSingleFlight(options.root, "broad-test", `pid-${process.pid}`, { staleAfterMs: options.leaseStaleAfterMs ?? 30_000 });
    worker = acquireResourceSlot(options.root, "workers", options.policy, `pid-${process.pid}`);
    provider = acquireResourceSlot(options.root, "providers", options.policy, `pid-${process.pid}`);
    testSlot = acquireResourceSlot(options.root, "tests", options.policy, `pid-${process.pid}`);
    return runHarnessExclusive(options);
  } finally {
    if (testSlot) releaseResourceSlot(options.root, testSlot);
    if (provider) releaseResourceSlot(options.root, provider);
    if (worker) releaseResourceSlot(options.root, worker);
    if (broadTest) releaseSingleFlight(options.root, broadTest);
    releaseSingleFlight(options.root, lease);
  }
}

function runHarnessExclusive({ root, manifest, policy, maxTicks, now = Date.now, driver = DEFAULT_FAULT_DRIVER, resourceSampler }) {
  if (!Number.isSafeInteger(maxTicks) || maxTicks < 1 || maxTicks > 10_000) {
    throw new Error("maxTicks must be a bounded positive integer");
  }
  const expectedPolicy = createResourcePolicy({ concurrency: policy?.concurrency, limits: policy?.limits });
  if (canonicalJson(expectedPolicy) !== canonicalJson(policy)) {
    throw new Error("resource policy must be canonical and bounded");
  }
  const canonicalManifest = createScenarioManifest(manifest);
  if (canonicalJson(canonicalManifest) !== canonicalJson(manifest)) {
    throw new Error("scenario manifest must be canonical");
  }
  mkdirSync(root, { recursive: true });
  const runPaths = paths(root);
  const existingManifest = readJsonIfPresent(runPaths.manifest);
  if (existingManifest && canonicalJson(existingManifest) !== canonicalJson(manifest)) {
    throw new Error("persisted scenario manifest does not match resume request");
  }
  if (!existingManifest) persistScenario(root, manifest);
  const existingPolicy = readJsonIfPresent(runPaths.policy);
  if (existingPolicy && canonicalJson(existingPolicy) !== canonicalJson(policy)) {
    throw new Error("persisted resource policy does not match resume request");
  }
  if (!existingPolicy) writeJsonAtomic(runPaths.policy, policy);

  const currentTimeMs = now();
  const previousState = readJsonIfPresent(runPaths.state);
  const resumed = previousState !== null;
  const manifestHash = digest(canonicalJson(manifest));
  if (previousState && (previousState.schemaVersion !== "martin.overnight.state.v1"
    || previousState.scenarioId !== manifest.scenarioId || previousState.manifestHash !== manifestHash)) {
    throw new Error("persisted state scenario/manifest binding mismatch");
  }
  const state = previousState ?? {
    schemaVersion: "martin.overnight.state.v1",
    scenarioId: manifest.scenarioId,
    manifestHash,
    startedAtMs: currentTimeMs,
    ticksCompleted: 0,
  };
  delete state.stopReason;
  state.blockers ??= [];
  mkdirSync(runPaths.receipts, { recursive: true });
  mkdirSync(join(root, "logs"), { recursive: true });
  mkdirSync(join(root, "artifacts"), { recursive: true });
  const sampleResources = resourceSampler ?? createProcessResourceSampler(root);

  // The journal is the commit authority. Finish interrupted materialization before
  // scheduling another operation; never replay an already committed tick.
  const restart = recoverRestartJournal(root);
  assertExactlyOnce(restart.events);
  const commits = restart.events.filter((event) => event.type === "operation_committed");
  let initialLedgerText = "";
  try { initialLedgerText = readFileSync(runPaths.ledger, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const initialLedgerCount = initialLedgerText.trim() ? initialLedgerText.trimEnd().split("\n").length : 0;
  if (initialLedgerCount > commits.length) throw new Error("authoritative exactly-once extra ledger entries");
  const phaseExists = (operationId, phase) => recoverRestartJournal(root).events.some((event) =>
    event.type === "persistence_phase" && event.operationId === operationId && event.phase === phase);
  const markPhase = (commit, phase) => {
    if (!phaseExists(commit.operationId, phase)) appendJournalEvent(root, {
      type: "persistence_phase", operationId: commit.operationId, receiptId: commit.receiptId, phase,
    });
  };
  const materialize = (commit, index, invokeHooks) => {
    const receipt = {
      schemaVersion: "martin.overnight.receipt.v1", scenarioId: manifest.scenarioId,
      operationId: commit.operationId, receiptId: commit.receiptId,
      boundary: commit.boundary, journalHash: commit.hash,
    };
    markPhase(commit, "journal_commit");
    const target = join(runPaths.receipts, `${commit.receiptId}.json`);
    const existing = readJsonIfPresent(target);
    if (existing && canonicalJson(existing) !== canonicalJson(receipt)) throw new Error("authoritative exactly-once receipt mismatch");
    if (!existing) {
      writeJsonAtomic(target, receipt);
      if (invokeHooks) driver.afterPhase?.({ phase: "receipt", commit, receipt });
    }
    markPhase(commit, "receipt");
    let ledgerText = "";
    try { ledgerText = readFileSync(runPaths.ledger, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const ledger = ledgerText.trim() ? ledgerText.trimEnd().split("\n").map(JSON.parse) : [];
    if (ledger[index]) {
      if (canonicalJson(ledger[index]) !== canonicalJson(receipt)) throw new Error("authoritative exactly-once ledger mismatch");
    } else {
      appendTextDurable(runPaths.ledger, `${JSON.stringify(receipt)}\n`);
      if (invokeHooks) driver.afterPhase?.({ phase: "ledger", commit, receipt });
    }
    markPhase(commit, "ledger");
    if (state.ticksCompleted < index + 1) {
      state.ticksCompleted = index + 1;
      writeJsonAtomic(runPaths.state, state);
      if (invokeHooks) driver.afterPhase?.({ phase: "state", commit, receipt });
    }
    markPhase(commit, "state");
  };
  for (const [index, commit] of commits.entries()) {
    const fault = manifest.faults[index % manifest.faults.length];
    if (commit.operationId !== `${manifest.scenarioId}-tick-${index + 1}`
      || commit.receiptId !== `receipt-${fault.faultId}-${index + 1}` || commit.boundary !== fault.boundary) {
      throw new Error("restart journal operation order mismatch");
    }
    materialize(commit, index, false);
  }
  if (state.ticksCompleted > commits.length) throw new Error("persisted state checkpoint exceeds journal authority");
  state.ticksCompleted = commits.length;
  assertAuthoritativeExactlyOnce(root);
  // Materialization already checkpoints every recovered commit. Only a brand-new
  // empty journal needs an initial state write; avoiding a redundant immediate
  // replacement is important when a crashed Windows child has just released the
  // same synchronized-filesystem target.
  if (previousState === null && commits.length === 0) writeJsonAtomic(runPaths.state, state);

  for (let offset = 0; offset < maxTicks; offset += 1) {
    if (manifest.mode === "smoke" && state.ticksCompleted >= manifest.boundaries.length) break;
    const sampleTime = now();
    try {
      assertResourceSample(policy, sampleResources());
    } catch (error) {
      if (!String(error?.code).startsWith("RESOURCE_LIMIT_")) throw error;
      state.stopReason = { code: error.code, resource: error.resource, observed: error.observed, limit: error.limit, atMs: sampleTime };
      state.blockers.push(state.stopReason);
      writeJsonAtomic(runPaths.state, state);
      break;
    }
    const window = (state.operationTimesMs ?? []).filter((time) => sampleTime - time < 60_000);
    if (window.length >= policy.limits.operationsPerMinute) {
      state.stopReason = {
        code: "RESOURCE_LIMIT_RATE",
        resource: "operationsPerMinute",
        observed: window.length,
        limit: policy.limits.operationsPerMinute,
        atMs: sampleTime,
      };
      state.blockers.push(state.stopReason);
      writeJsonAtomic(runPaths.state, state);
      break;
    }
    state.operationTimesMs = [...window, sampleTime];
    const tick = state.ticksCompleted + 1;
    const fault = manifest.faults[(tick - 1) % manifest.faults.length];
    const operationId = `${manifest.scenarioId}-tick-${tick}`;
    const attemptId = `${operationId}:attempt-1`;
    const settlementId = digest(`${attemptId}\0${fault.boundary}`).slice(0, 32);
    const receiptId = `receipt-${fault.faultId}-${tick}`;
    const partial = recoverRestartJournal(root).events.filter((event) => event.operationId === operationId);
    let eventIndex = 0;
    const emit = (event) => {
      const existing = partial[eventIndex++];
      if (!existing) return { record: appendJournalEvent(root, event), created: true };
      const { sequence, previousHash, hash, ...payload } = existing;
      if (canonicalJson(payload) !== canonicalJson(event)) throw new Error("restart journal pending operation mismatch");
      return { record: existing, created: false };
    };
    emit({ type: "operation_started", operationId, boundary: fault.boundary });
    for (let ordinal = 1; ordinal <= fault.triggerOrdinal; ordinal += 1) {
      emit({ type: "boundary_reached", operationId, boundary: fault.boundary, ordinal });
    }
    const faultContext = { operationId, attemptId, settlementId, boundary: fault.boundary, faultId: fault.faultId, triggerOrdinal: fault.triggerOrdinal };
    const faultEvent = { type: "fault_injected", ...faultContext };
    if (!partial[eventIndex]) {
      try {
        driver.injectFault?.(faultContext);
        throw new Error(`fault driver did not throw at ${fault.boundary}`);
      } catch (error) {
        if (error?.code !== "MARTIN_OVERNIGHT_INJECTED_FAULT" || error.boundary !== fault.boundary) throw error;
        driver.afterPhase?.({ phase: "provider_charge", context: faultContext, error });
        if (error.spendUsd) recordSpend(root, policy, { idempotencyKey: settlementId, amountUsd: error.spendUsd });
      }
    }
    emit(faultEvent);
    const recoveredEvent = { type: "fault_recovered", operationId, attemptId, settlementId, boundary: fault.boundary, faultId: fault.faultId };
    if (!partial[eventIndex]) driver.recoverFault?.(faultContext);
    emit(recoveredEvent);
    const committed = emit({ type: "operation_committed", operationId, receiptId, boundary: fault.boundary });
    if (committed.created) driver.afterPhase?.({ phase: "journal_commit", commit: committed.record });
    materialize(committed.record, tick - 1, true);
  }

  const endedAtMs = now();
  const elapsedMs = Math.max(0, endedAtMs - state.startedAtMs);
  const recovered = recoverRestartJournal(root);
  const invariantCounts = assertExactlyOnce(recovered.events);
  const authorityCounts = assertAuthoritativeExactlyOnce(root);
  const faults = recovered.events.filter((event) => event.type === "fault_injected");
  const boundariesExercised = [...new Set(faults.map((event) => event.boundary))].sort();
  const smokeValidated = manifest.mode === "smoke" && boundariesExercised.length === manifest.boundaries.length;
  // A paused invocation is not an elapsed soak. Only observed execution time
  // contributes to the duration gate; wall time remains useful dossier context.
  state.activeElapsedMs = (state.activeElapsedMs ?? 0) + Math.max(0, endedAtMs - currentTimeMs);
  writeJsonAtomic(runPaths.state, state);
  const soakElapsedValidated = manifest.mode !== "smoke"
    && state.activeElapsedMs >= manifest.durationMs
    && boundariesExercised.length === manifest.boundaries.length;
  const status = state.stopReason ? "BLOCKED" : smokeValidated || soakElapsedValidated ? "COMPLETED" : "PAUSED";
  const dossier = {
    schemaVersion: "martin.overnight.morning-dossier.v1",
    scenarioId: manifest.scenarioId,
    mode: manifest.mode,
    status,
    startedAtMs: state.startedAtMs,
    endedAtMs,
    elapsedMs,
    requiredDurationMs: manifest.durationMs,
    activeElapsedMs: state.activeElapsedMs,
    stopReason: state.stopReason ?? null,
    blockers: state.blockers,
    smokeValidated,
    soakElapsedValidated,
    providerFree: true,
    providerCalls: 0,
    ticksCompleted: state.ticksCompleted,
    faultsInjected: faults.length,
    boundariesExercised,
    invariants: {
      exactlyOnce: invariantCounts.operationCount === invariantCounts.receiptCount,
      authoritativeParity: authorityCounts.operationCount === invariantCounts.operationCount
        && authorityCounts.receiptCount === invariantCounts.receiptCount,
      operationCount: invariantCounts.operationCount,
      receiptCount: invariantCounts.receiptCount,
      journalHeadHash: recovered.headHash,
    },
    authoritativeArtifacts: ["authority/ledger.jsonl", "authority/receipts/", "restart-journal.jsonl", "scenario.json"],
  };
  writeJsonAtomic(runPaths.dossier, dossier);
  return {
    status,
    resumed,
    ticksCompleted: state.ticksCompleted,
    providerCalls: 0,
    faultsInjected: faults.length,
    dossier,
  };
}
