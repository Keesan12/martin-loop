// SPDX-FileCopyrightText: MartinLoop contributors
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  SWARM_CHILD_MAX_WALL_CLOCK_MS,
  resolveSwarmDeadlineMs,
} from "../../packages/contracts/dist/index.js";

const execFileAsync = promisify(execFile);
const HEX40 = /^[0-9a-f]{40}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const ISO = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const REQUIRED_ARTIFACT_KINDS = Object.freeze(["receipt", "ledger", "dossier", "integrity", "verifier", "budget"]);
export const EXPECTED_RUNS = Object.freeze([
  expectedRun({ name: "canary", agents: 3, maxConcurrency: 3, budgetUsd: 3 }),
  expectedRun({ name: "full", agents: 15, maxConcurrency: 5, budgetUsd: 12 }),
]);
export const TRUSTED_FILES = Object.freeze({
  authorization: "live-swarm-authorization.json",
  buildManifest: "candidate-build-manifest.json",
  canary: "live-swarm-canary-capture.json",
  full: "live-swarm-full-capture.json",
});

function expectedRun(run) {
  return Object.freeze({
    ...run,
    maxWallClockMs: resolveSwarmDeadlineMs(run),
  });
}

// Trust boundary: required-live qualification is an independent operational
// decision made inside a trusted release runner. Candidate workspace files are
// untrusted inputs; the runner supplies a disjoint review root containing its
// approval, observed process captures, integrity keys, and build manifest. This
// reconciler does not claim to resist an attacker who controls that runner, the
// capture code, and every external trust root.

export function validateQualificationStructure(receipt, currentHead) {
  const errors = [];
  const expect = (condition, message) => { if (!condition) errors.push(message); };
  expect(record(receipt), "qualification receipt must be a JSON object");
  if (!record(receipt)) return errors;
  expect(receipt.schemaVersion === "martin.live-swarm.qualification.v1", "qualification schemaVersion is invalid");
  expect(["BLOCKED_PENDING_APPROVAL", "PASS", "FAIL", "BLOCKED", "UNKNOWN"].includes(receipt.status), "qualification status is invalid");
  expect(ISO(receipt.generatedAt), "qualification generatedAt must be an ISO timestamp");
  expect(HEX40.test(receipt.source?.sha ?? ""), "qualification source.sha must be a full Git SHA");
  if (currentHead) expect(receipt.source?.sha === currentHead, "qualification source.sha must equal the candidate HEAD");
  expect(typeof receipt.binary?.path === "string" && isAbsolute(receipt.binary.path), "qualification binary.path must be absolute");
  expect(HEX64.test(receipt.binary?.sha256 ?? ""), "qualification binary.sha256 must be lowercase SHA-256");
  expect(typeof receipt.binary?.version === "string" && receipt.binary.version.length > 0, "qualification binary.version is required");
  expect(["PASS", "BLOCKED", "UNKNOWN"].includes(receipt.capability?.authStatus), "qualification authStatus is invalid");
  expect(["PASS", "BLOCKED", "UNKNOWN"].includes(receipt.capability?.preflightStatus), "qualification preflightStatus is invalid");
  expect(typeof receipt.approval?.approved === "boolean", "qualification approval.approved must be boolean");
  expect(receipt.approval?.maxCombinedUsd === 15, "qualification maxCombinedUsd must remain exactly 15");
  expect(Array.isArray(receipt.runs) && receipt.runs.length === 2, "qualification must contain exactly canary and full runs");
  expect(receipt.zeroFallbackPolicy === "live failures exit nonzero; simulation is never invoked", "qualification zero-fallback policy is invalid");
  for (const spec of EXPECTED_RUNS) {
    const matches = Array.isArray(receipt.runs) ? receipt.runs.filter((run) => run?.name === spec.name) : [];
    expect(matches.length === 1, `qualification must contain one ${spec.name} run`);
    const run = matches[0];
    if (!run) continue;
    expect(run.agents === spec.agents, `${spec.name}.agents must be ${spec.agents}`);
    expect(run.maxConcurrency === spec.maxConcurrency, `${spec.name}.maxConcurrency must be ${spec.maxConcurrency}`);
    expect(run.budgetUsd === spec.budgetUsd, `${spec.name}.budgetUsd must be ${spec.budgetUsd}`);
    expect(run.maxWallClockMs === spec.maxWallClockMs, `${spec.name}.maxWallClockMs must be ${spec.maxWallClockMs}`);
    expect(run.simulationFallbackCalls === 0, `${spec.name}.simulationFallbackCalls must be zero`);
    expect(exactArgv(run.argv, spec), `${spec.name}.argv must be the exact authorized structured argv without duplicates or conflicts`);
    if (receipt.status === "PASS") {
      expect(run.exitCode === 0, `${spec.name}.exitCode must be zero for a submitted PASS`);
      expect(typeof run.swarmId === "string" && run.swarmId.length > 0, `${spec.name}.swarmId is required for a submitted PASS`);
      expect(record(run.evidence), `${spec.name}.evidence is required for a submitted PASS`);
    }
  }
  return errors;
}

export async function validateArtifactIntegrity(receipt, options) {
  const errors = [];
  const snapshots = options.snapshots ?? [];
  const repositoryRoot = await canonicalDirectory(options.repositoryRoot, "candidate repository");
  try {
    const binary = await snapshotFile(receipt.binary?.path, { root: repositoryRoot, label: "submitted binary", snapshots });
    if (binary.sha256 !== receipt.binary?.sha256) errors.push("submitted binary hash does not match retained bytes");
  } catch (error) { errors.push(message(error)); }
  for (const spec of EXPECTED_RUNS) {
    const run = receipt.runs?.find((candidate) => candidate?.name === spec.name);
    if (!run || !record(run.evidence)) continue;
    const artifacts = Array.isArray(run.evidence.artifacts) ? run.evidence.artifacts : [];
    for (const kind of REQUIRED_ARTIFACT_KINDS) {
      const matches = artifacts.filter((artifact) => artifact?.kind === kind);
      if (matches.length !== 1) { errors.push(`${spec.name} must retain exactly one ${kind} artifact`); continue; }
      try {
        const file = await snapshotFile(matches[0].path, { root: repositoryRoot, label: `${spec.name} ${kind} artifact`, snapshots });
        if (file.sha256 !== matches[0].sha256) errors.push(`${spec.name} ${kind} artifact hash mismatch`);
        validateArtifactSchema(kind, parseJson(file.bytes, `${spec.name} ${kind} artifact`), spec.name, errors);
      } catch (error) { errors.push(message(error)); }
    }
    if (new Set(artifacts.map((artifact) => artifact?.path)).size !== artifacts.length) errors.push(`${spec.name} artifact paths must be unique`);
  }
  try { await verifyImmutableFileSnapshots(snapshots); }
  catch (error) { errors.push(message(error)); }
  return errors;
}

export async function validateRequiredLiveQualification(receipt, options) {
  const errors = [];
  const snapshots = [];
  const repositoryRoot = await canonicalDirectory(options.repositoryRoot, "candidate repository");
  const trustRoot = await canonicalDirectory(options.trustRoot, "external trusted review root");
  if (contains(repositoryRoot, trustRoot) || contains(trustRoot, repositoryRoot)) errors.push("external trusted review root must be disjoint from the candidate repository");
  const trusted = {};
  for (const [key, name] of Object.entries(TRUSTED_FILES)) {
    try {
      const file = await snapshotFile(join(trustRoot, name), { root: trustRoot, expected: join(trustRoot, name), label: `trusted ${key}`, snapshots });
      trusted[key] = { ...file, value: parseJson(file.bytes, `trusted ${key}`) };
    } catch (error) { errors.push(message(error)); }
  }
  if (errors.length > 0) return { errors, decision: "UNKNOWN" };

  const { stdout: headOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot });
  const { stdout: treeOutput } = await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repositoryRoot });
  const { stdout: trackedStatus } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repositoryRoot });
  if (trackedStatus.trim().length > 0) errors.push("candidate tracked source must be clean so approved build bytes correspond to the exact candidate commit");
  const context = { repositoryRoot, head: headOutput.trim().toLowerCase(), tree: treeOutput.trim().toLowerCase() };
  validateBuildAuthority(trusted, receipt, context, errors);
  let core;
  if (errors.length === 0) {
    try { core = await loadAuthorizedCore(trusted.buildManifest.value, repositoryRoot, snapshots); }
    catch (error) { errors.push(message(error)); }
  }
  const runResults = [];
  if (core) {
    for (const spec of EXPECTED_RUNS) {
      const run = receipt.runs.find((candidate) => candidate.name === spec.name);
      const result = await validatePersistedRun({ run, spec, capture: trusted[spec.name].value, receipt, authorization: trusted.authorization.value, build: trusted.buildManifest.value, core, repositoryRoot, trustRoot, snapshots });
      errors.push(...result.errors);
      runResults.push(result);
    }
  }
  if (runResults.length === 2) {
    const [canary, full] = runResults;
    if (receipt.runs[0]?.swarmId === receipt.runs[1]?.swarmId) errors.push("canary and full qualifications must use distinct parent swarm IDs");
    if (canary.runsRoot && full.runsRoot && samePath(canary.runsRoot, full.runsRoot)) errors.push("canary and full runs must use distinct persisted stores");
    if (canary.workspaceIds?.some((id) => full.workspaceIds?.includes(id))) errors.push("canary and full runs must use distinct workspaces");
    if (canary.childRunIds?.some((id) => full.childRunIds?.includes(id))) errors.push("canary and full runs must use distinct child runs");
    if (canary.processId === full.processId) errors.push("canary and full trusted process observations must be distinct");
    const combinedUsd = runResults.reduce((sum, result) => sum + (result.settledUsd ?? Number.NaN), 0);
    if (!finiteNonnegative(combinedUsd) || combinedUsd > 15) errors.push("canonical combined provider spend must be finite, nonnegative, and within the $15 cap");
  }
  try { await verifyUnchangedSnapshots(snapshots); }
  catch (error) { errors.push(message(error)); }
  return { errors, decision: errors.length === 0 ? "LIVE_QUALIFIED" : "FAIL", runResults };
}

async function validatePersistedRun(input) {
  const { run, spec, capture, receipt, authorization, build, core, repositoryRoot, trustRoot, snapshots } = input;
  const errors = [];
  const expect = (condition, messageText) => { if (!condition) errors.push(`${spec.name}: ${messageText}`); };
  expect(capture.schemaVersion === "martin.live-swarm.trusted-capture.v1", "trusted capture schema is invalid");
  expect(capture.approvalId === authorization.approvalId, "trusted capture approval identity mismatch");
  expect(capture.runName === spec.name && capture.sourceSha === receipt.source.sha && capture.sourceTree === authorization.sourceTree, "trusted capture run/source identity mismatch");
  expect(HEX40.test(capture.workspaceSourceSha ?? ""), "trusted capture workspace source must be a full Git SHA");
  expect(capture.executionMode === "governed", "trusted capture executionMode must be governed");
  expect(capture.exitCode === 0 && ISO(capture.startedAt) && ISO(capture.completedAt) && Date.parse(capture.completedAt) >= Date.parse(capture.startedAt), "trusted process lifecycle must be a completed zero exit");
  expect(ISO(capture.startedAt) && ISO(capture.completedAt) && Date.parse(capture.completedAt) - Date.parse(capture.startedAt) <= spec.maxWallClockMs, "trusted process lifecycle exceeds the authorized wall-clock limit");
  expect(capture.process?.launched === true && capture.process?.completed === true && Number.isSafeInteger(capture.process?.pid) && capture.process.pid > 0 && HEX64.test(capture.process?.stdoutSha256 ?? "") && HEX64.test(capture.process?.stderrSha256 ?? ""), "trusted capture must contain an externally observed process launch/completion boundary");
  expect(exactArgv(capture.argv, spec), "trusted capture argv must exactly match the authorized invocation");
  expect(samePath(capture.executable?.path, build.cliEntrypoint?.path) && capture.executable?.sha256 === build.cliEntrypoint?.sha256 && capture.executable?.version === authorization.packageVersion, "trusted capture executable must be the approved package build");
  if (errors.length > 0) return { errors };
  let runsRoot;
  try {
    runsRoot = await canonicalDirectory(capture.runsRoot, `${spec.name} persisted store`);
    if (contains(repositoryRoot, runsRoot) || contains(runsRoot, repositoryRoot) || contains(trustRoot, runsRoot) || contains(runsRoot, trustRoot)) errors.push(`${spec.name}: persisted store must be disjoint from candidate and trusted roots`);
    expect(run.evidence?.runsRoot === capture.runsRoot, "submitted runsRoot must match trusted capture");
    expect(run.swarmId === capture.swarmId && run.evidence?.swarmId === capture.swarmId, "submitted and trusted swarm identities must match");
  } catch (error) { errors.push(message(error)); }
  if (!runsRoot) return { errors };
  const evidenceRoot = join(runsRoot, "_swarms", capture.swarmId, "evidence");
  let persistedPlan;
  try {
    const planFile = await snapshotFile(join(runsRoot, "_swarms", capture.swarmId, "plan.json"), { root: runsRoot, label: `${spec.name} canonical plan`, snapshots });
    persistedPlan = parseJson(planFile.bytes, `${spec.name} canonical plan`);
  } catch (error) { errors.push(message(error)); }
  for (const name of ["parent-receipt.json", "evidence-index.json", "swarm-receipt-integrity.json", "swarm-receipt-seal.json"]) {
    try { await snapshotFile(join(evidenceRoot, name), { root: runsRoot, label: `${spec.name} canonical ${name}`, snapshots }); }
    catch (error) { errors.push(message(error)); }
  }
  const integrityKeyRoot = await canonicalDirectory(join(trustRoot, "integrity-keys"), "external integrity key root");
  const keyCount = await snapshotTrustedKeyTree(integrityKeyRoot, snapshots);
  expect(keyCount > 0, "external integrity key root must contain trusted key material");
  const previousIntegrityRoot = process.env.MARTIN_INTEGRITY_KEY_DIR;
  process.env.MARTIN_INTEGRITY_KEY_DIR = integrityKeyRoot;
  let projection; let dossier; let verification;
  try {
    [projection, dossier, verification] = await Promise.all([
      core.readSwarmReceiptProjection({ runsRoot, swarmId: capture.swarmId }),
      core.readSwarmDossier({ runsRoot, swarmId: capture.swarmId }),
      core.verifySwarmEvidence({ runsRoot, swarmId: capture.swarmId }),
    ]);
  } catch (error) { errors.push(`${spec.name}: canonical Core authority rejected persisted evidence: ${message(error)}`); }
  finally {
    if (previousIntegrityRoot === undefined) delete process.env.MARTIN_INTEGRITY_KEY_DIR;
    else process.env.MARTIN_INTEGRITY_KEY_DIR = previousIntegrityRoot;
  }
  const parent = projection?.receipt;
  expect(persistedPlan?.swarmId === capture.swarmId && persistedPlan?.planHash === parent?.planHash, "persisted plan must bind the canonical parent receipt");
  expect(persistedPlan?.engine?.engine === "codex" && persistedPlan?.engine?.model === capture.model, "persisted plan provider/model must match the trusted capture");
  expect(persistedPlan?.parentContract?.maxConcurrency === spec.maxConcurrency && persistedPlan?.parentContract?.maxWallClockMs === spec.maxWallClockMs && persistedPlan?.parentContract?.budget?.maxUsd === spec.budgetUsd, "persisted plan must match authorized concurrency, wall-clock, and budget limits");
  expect(persistedPlan?.agents?.length === spec.agents && persistedPlan?.tasks?.length === spec.agents, "persisted plan must match the authorized agent/task count");
  expect(
    persistedPlan?.agents?.every(
      (agent) => agent?.contract?.maxWallClockMs === SWARM_CHILD_MAX_WALL_CLOCK_MS,
    ),
    "persisted plan child wall-clock limits must match the shared Swarm timing contract",
  );
  expect(projection?.integrity?.state === "verified", "signed parent receipt chain/integrity must verify");
  expect(verification?.verified === true && verification?.integrityState === "verified", "canonical runs verify must report verified integrity");
  expect(verification?.taskVerificationState === "passed" && verification?.parentOutcomeState === "verified", "canonical runs verify must report verified parent and tasks");
  expect(parent?.swarmId === capture.swarmId && verification?.swarmId === capture.swarmId && dossier?.swarmId === capture.swarmId, "run/swarm identities must reconcile across authorities");
  expect(parent?.baselineCommit === capture.workspaceSourceSha, "canonical baseline must match the externally observed workspace source");
  expect(parent?.engine?.engine === "codex" && parent?.engine?.model === capture.model, "canonical provider/model must match trusted capture");
  expect(parent?.parentOutcome?.state === "verified" && parent?.taskVerificationState === "passed", "canonical terminal lifecycle must be verified");
  expect(dossier?.receiptSha256 === parent?.receiptSha256, "dossier must bind the canonical receipt");
  const events = Array.isArray(parent?.events) ? parent.events : [];
  const terminal = events.filter((event) => ["SWARM_VERIFIED", "SWARM_STOPPED", "SWARM_NEEDS_REVIEW"].includes(event?.type));
  expect(terminal.length === 1 && terminal[0] === events.at(-1) && terminal[0]?.type === "SWARM_VERIFIED", "requires one final SWARM_VERIFIED event");
  const verifierEvents = events.filter((event) => ["GLOBAL_VERIFIER_PASSED", "GLOBAL_VERIFIER_FAILED"].includes(event?.type));
  expect(verifierEvents.length === 1 && verifierEvents[0]?.type === "GLOBAL_VERIFIER_PASSED" && verifierEvents[0]?.payload?.verificationId === parent?.globalVerificationId, "requires one receipt-bound passed verifier event");
  const children = Array.isArray(parent?.childReceipts) ? parent.childReceipts : [];
  expect(Array.isArray(parent?.tasks) && parent.tasks.length === spec.agents && parent.tasks.every((task) => task.status === "accepted"), "all canonical tasks must be uniquely accepted");
  expect(Array.isArray(parent?.agents) && parent.agents.length === spec.agents && parent.agents.every((agent) => agent.status === "verified"), "all canonical agents must be uniquely verified");
  expect(new Set(parent?.tasks?.map((task) => task.taskId)).size === spec.agents, "canonical task identities must be unique");
  expect(new Set(parent?.agents?.map((agent) => agent.agentId)).size === spec.agents, "canonical agent identities must be unique");
  expect(children.length === spec.agents, `requires ${spec.agents} canonical child receipts`);
  const childIds = children.map((child) => child.childRunId);
  expect(new Set(childIds).size === childIds.length, "child run identities must be unique");
  const observationList = Array.isArray(capture.children) ? capture.children : [];
  expect(observationList.length === spec.agents, `trusted capture requires ${spec.agents} child observations`);
  expect(new Set(observationList.map((item) => item?.childRunId)).size === observationList.length, "trusted child observations must be unique");
  const workspaceIds = []; const leaseIds = [];
  let childUsd = 0; let childTokens = 0;
  for (const child of children) {
    const started = events.filter((event) => event?.type === "CHILD_STARTED" && event.childRunId === child.childRunId);
    const finished = events.filter((event) => event?.type === "CHILD_VERIFIED" && event.childRunId === child.childRunId);
    expect(started.length === 1 && finished.length === 1, `child ${child.childRunId} requires one started and verified lifecycle`);
    const start = started[0]; const finish = finished[0];
    const observation = observationList.find((candidate) => candidate?.childRunId === child.childRunId);
    expect(Boolean(observation), `child ${child.childRunId} must be externally observed`);
    let loop;
    try {
      const loopFile = await snapshotFile(join(runsRoot, child.childRunId, "loop-record.json"), { root: runsRoot, label: `${spec.name} child ${child.childRunId} LoopRecord`, snapshots });
      const indexed = parent?.evidenceFiles?.find((file) => file.path === `${child.childRunId}/loop-record.json`);
      expect(indexed?.sha256 === loopFile.sha256, `child ${child.childRunId} LoopRecord must bind the sealed evidence index`);
      loop = parseJson(loopFile.bytes, `${spec.name} child ${child.childRunId} LoopRecord`);
      const integrityFile = await snapshotFile(join(runsRoot, child.childRunId, "receipt-integrity.json"), { root: runsRoot, label: `${spec.name} child ${child.childRunId} integrity`, snapshots });
      expect(integrityFile.sha256 === child.receiptIntegritySha256, `child ${child.childRunId} integrity hash must bind the parent receipt`);
      await snapshotFile(join(runsRoot, child.childRunId, "ledger.jsonl"), { root: runsRoot, label: `${spec.name} child ${child.childRunId} ledger`, snapshots });
    } catch (error) { errors.push(message(error)); continue; }
    const link = loop.receiptScope?.swarmChild;
    const attempt = Array.isArray(loop.attempts) ? loop.attempts.at(-1) : undefined;
    const launch = loop.events?.find((event) => event.type === "run.started")?.payload;
    const settlement = loop.cost?.providerSettlement;
    const tokens = Number(loop.cost?.tokensIn) + Number(loop.cost?.tokensOut);
    expect(loop.loopId === child.childRunId && link?.parentSwarmId === capture.swarmId, `child ${child.childRunId} run/swarm identity mismatch`);
    expect(link?.agentId === child.agentId && start?.agentId === child.agentId && finish?.agentId === child.agentId, `child ${child.childRunId} agent identity mismatch`);
    expect(link?.attemptId === child.attemptId && start?.payload?.attemptId === child.attemptId, `child ${child.childRunId} attempt identity mismatch`);
    expect(sameStrings(link?.taskIds, child.taskIds), `child ${child.childRunId} task identity mismatch`);
    expect(loop.metadata?.executionMode === "governed", `child ${child.childRunId} executionMode must explicitly be governed`);
    expect(loop.metadata?.["swarm.baselineCommit"] === capture.workspaceSourceSha, `child ${child.childRunId} workspace source identity mismatch`);
    expect(loop.metadata?.["swarm.engine"] === "codex" && loop.metadata?.["swarm.model"] === capture.model, `child ${child.childRunId} engine/model metadata mismatch`);
    expect(loop.status === "completed" && loop.lifecycleState === "completed" && loop.attempts?.length === 1 && attempt?.completedAt && attempt?.failureClass === undefined, `child ${child.childRunId} lifecycle must be one terminal completed attempt`);
    expect(attempt?.adapterId === "agent-cli:codex" && launch?.adapterId === "agent-cli:codex", `child ${child.childRunId} adapter identity mismatch`);
    expect(attempt?.model === capture.model, `child ${child.childRunId} attempt model mismatch`);
    expect(launch?.providerId === "codex" && launch?.model === capture.model && launch?.transport === "cli", `child ${child.childRunId} provider launch is not authentic`);
    expect(settlement?.providerId === "codex" && settlement?.model === capture.model && settlement?.transport === "cli" && settlement?.source === "codex_jsonl" && settlement?.rawUsageAvailable === true, `child ${child.childRunId} provider settlement is unverifiable`);
    expect(settlement?.inputTokens === loop.cost?.tokensIn && settlement?.outputTokens === loop.cost?.tokensOut, `child ${child.childRunId} provider settlement tokens do not reconcile`);
    expect(finiteNonnegative(loop.cost?.actualUsd) && Number.isFinite(tokens) && tokens > 0, `child ${child.childRunId} accounting is invalid`);
    expect(finish?.payload?.actualUsd === loop.cost?.actualUsd && finish?.payload?.actualTokens === tokens, `child ${child.childRunId} event and LoopRecord accounting mismatch`);
    if (observation) {
      expect(observation.agentId === child.agentId && observation.attemptId === child.attemptId && sameStrings(observation.taskIds, child.taskIds), `child ${child.childRunId} external identity observation mismatch`);
      expect(observation.workspaceId === start?.payload?.workspaceId && observation.workingDirectory === loop.receiptScope?.workingDirectory, `child ${child.childRunId} workspace observation mismatch`);
      expect(observation.candidateSourceSha === receipt.source.sha && observation.workspaceSourceSha === capture.workspaceSourceSha && observation.adapterId === "agent-cli:codex" && observation.providerId === "codex" && observation.model === capture.model && observation.transport === "cli", `child ${child.childRunId} external provider/source observation mismatch`);
      expect(Number.isSafeInteger(observation.providerProcessId) && observation.providerProcessId > 0 && ISO(observation.launchedAt) && ISO(observation.completedAt) && Date.parse(observation.completedAt) >= Date.parse(observation.launchedAt), `child ${child.childRunId} external provider process lifecycle is missing`);
      expect(observation.verificationId === parent.globalVerificationId && observation.receiptIntegritySha256 === child.receiptIntegritySha256, `child ${child.childRunId} external verifier/receipt observation mismatch`);
      expect(observation.actualUsd === loop.cost?.actualUsd && observation.actualTokens === tokens, `child ${child.childRunId} external accounting observation mismatch`);
    }
    workspaceIds.push(start?.payload?.workspaceId); leaseIds.push(start?.payload?.leaseId);
    childUsd += Number(loop.cost?.actualUsd); childTokens += tokens;
  }
  expect(new Set(workspaceIds).size === workspaceIds.length && workspaceIds.every(Boolean), "child workspaces must be unique and present");
  expect(new Set(leaseIds).size === leaseIds.length && leaseIds.every(Boolean), "child budget lease identities must be unique and present");
  const ledger = parent?.budgetLedger;
  const leases = Array.isArray(ledger?.leases) ? ledger.leases : [];
  expect(ledger?.capUsd === spec.budgetUsd, `canonical budget cap must equal $${spec.budgetUsd}`);
  expect(leases.length === spec.agents && leases.every((lease) => lease?.status === "settled"), "requires exactly one settled lease per child");
  expect(new Set(leases.map((lease) => lease?.leaseId)).size === leases.length, "duplicate budget lease identity is forbidden");
  expect(new Set(leases.map((lease) => `${lease?.agentId}:${lease?.taskId}`)).size === leases.length, "duplicate agent/task settlement is forbidden");
  const ledgerUsd = leases.reduce((sum, lease) => sum + Number(lease?.actualUsage?.usd), 0);
  const ledgerTokens = leases.reduce((sum, lease) => sum + Number(lease?.actualUsage?.tokens), 0);
  expect(leases.every((lease) => finiteNonnegative(lease?.actualUsage?.usd) && finiteNonnegative(lease?.actualUsage?.tokens)), "lease accounting must be finite and nonnegative");
  expect(equalUsd(ledgerUsd, ledger?.settledUsd) && ledgerTokens === ledger?.settledTokens, "ledger settlements and totals must reconcile exactly");
  expect(equalUsd(ledgerUsd, childUsd) && ledgerTokens === childTokens, "child provider accounting and ledger must reconcile exactly");
  expect(finiteNonnegative(ledgerUsd) && ledgerUsd <= spec.budgetUsd, "settled provider spend exceeds the authorized cap");
  expect(equalUsd(dossier?.budget?.capUsd, ledger?.capUsd) && equalUsd(dossier?.budget?.settledUsd, ledger?.settledUsd) && dossier?.budget?.settledTokens === ledger?.settledTokens, "dossier and canonical ledger accounting mismatch");
  expect(equalUsd(capture.accounting?.settledUsd, ledger?.settledUsd) && capture.accounting?.settledTokens === ledger?.settledTokens, "trusted capture and canonical accounting mismatch");
  return { errors, runsRoot, workspaceIds, childRunIds: childIds, processId: capture.process?.pid, settledUsd: ledger?.settledUsd };
}

function validateBuildAuthority(trusted, receipt, context, errors) {
  const authorization = trusted.authorization.value; const build = trusted.buildManifest.value;
  const expect = (condition, text) => { if (!condition) errors.push(text); };
  expect(authorization.schemaVersion === "martin.live-swarm.external-authorization.v1" && authorization.decision === "AUTHORIZED", "external authorization must be an AUTHORIZED live-swarm document");
  expect(typeof authorization.approvalId === "string" && authorization.approvalId.length > 0 && typeof authorization.approvedBy === "string" && authorization.approvedBy.length > 0 && ISO(authorization.approvedAt), "external authorization must identify reviewer and approval time");
  expect(authorization.sourceSha === context.head && authorization.sourceSha === receipt.source.sha && authorization.sourceTree === context.tree, "external authorization source identity must equal candidate HEAD/tree and receipt");
  expect(authorization.maxCombinedUsd === 15 && stableJson(authorization.runs) === stableJson(EXPECTED_RUNS), "external authorization must bind exact 3/$3 and 15/$12 limits with a $15 combined cap");
  expect(authorization.buildManifestSha256 === trusted.buildManifest.sha256, "external authorization must bind the trusted build manifest bytes");
  expect(build.schemaVersion === "martin.candidate-build.v1" && build.sourceSha === context.head && build.sourceTree === context.tree, "candidate build manifest source identity mismatch");
  expect(build.generatedBy === "pnpm build" && ISO(build.generatedAt), "candidate build manifest must be produced by the canonical build command");
  expect(build.packageVersion === authorization.packageVersion, "candidate build and external authorization version mismatch");
  expect(samePath(build.packageJson?.path, resolve(context.repositoryRoot, "package.json")), "build manifest must bind root package.json");
  expect(samePath(build.cliEntrypoint?.path, resolve(context.repositoryRoot, "dist/bin/martin-loop.js")), "build manifest must bind built CLI entrypoint");
  expect(samePath(build.coreEntrypoint?.path, resolve(context.repositoryRoot, "dist/vendor/core/index.js")), "build manifest must bind the packaged Core entrypoint");
  expect(Array.isArray(build.packageFiles) && build.packageFiles.length > 2, "build manifest must bind the complete built package tree");
  expect(authorization.cliEntrypointPath === build.cliEntrypoint?.path && authorization.cliEntrypointSha256 === build.cliEntrypoint?.sha256, "external authorization must bind exact CLI build bytes");
  expect(samePath(receipt.binary?.path, build.cliEntrypoint?.path) && receipt.binary?.sha256 === build.cliEntrypoint?.sha256 && receipt.binary?.version === build.packageVersion, "submitted binary/version must equal the externally approved package build");
}

async function loadAuthorizedCore(build, repositoryRoot, snapshots) {
  const packageFile = await snapshotFile(build.packageJson?.path, { root: repositoryRoot, expected: join(repositoryRoot, "package.json"), label: "candidate package manifest", snapshots });
  const cliFile = await snapshotFile(build.cliEntrypoint?.path, { root: repositoryRoot, expected: join(repositoryRoot, "dist/bin/martin-loop.js"), label: "candidate CLI entrypoint", snapshots });
  const coreFile = await snapshotFile(build.coreEntrypoint?.path, { root: repositoryRoot, expected: join(repositoryRoot, "dist/vendor/core/index.js"), label: "candidate packaged Core entrypoint", snapshots });
  if (packageFile.sha256 !== build.packageJson?.sha256 || cliFile.sha256 !== build.cliEntrypoint?.sha256 || coreFile.sha256 !== build.coreEntrypoint?.sha256) throw new Error("candidate source/build manifest hashes do not match imported package bytes");
  const actualPackageFiles = await snapshotPackageTree(join(repositoryRoot, "dist"), snapshots);
  if (stableJson(actualPackageFiles) !== stableJson(build.packageFiles)) throw new Error("candidate build manifest does not bind the complete built package tree");
  const packageJson = parseJson(packageFile.bytes, "candidate package manifest");
  if (packageJson.version !== build.packageVersion) throw new Error("candidate package version does not match approved build manifest");
  const core = await import(`${pathToFileURL(coreFile.path).href}?live-swarm=${coreFile.sha256}`);
  for (const name of ["readSwarmReceiptProjection", "readSwarmDossier", "verifySwarmEvidence"]) if (typeof core[name] !== "function") throw new Error(`candidate Core build is missing ${name}`);
  return core;
}

function validateArtifactSchema(kind, value, runName, errors) {
  if (!record(value)) { errors.push(`${runName} ${kind} artifact must contain a JSON object`); return; }
  if (kind === "receipt" && value.schemaVersion !== "martin.swarm-receipt.v1") errors.push(`${runName} receipt artifact schema is invalid`);
  if (kind === "ledger" && (!Array.isArray(value.leases) || !finiteNonnegative(value.capUsd))) errors.push(`${runName} ledger artifact schema is invalid`);
  if (kind === "dossier" && (typeof value.swarmId !== "string" || !record(value.budget))) errors.push(`${runName} dossier artifact schema is invalid`);
  if (kind === "integrity" && value.state !== "verified") errors.push(`${runName} integrity artifact is not verified`);
  if (kind === "verifier" && value.verified !== true) errors.push(`${runName} verifier artifact is not verified`);
  if (kind === "budget" && (!finiteNonnegative(value.capUsd) || !finiteNonnegative(value.settledUsd) || !finiteNonnegative(value.settledTokens))) errors.push(`${runName} budget artifact schema is invalid`);
}
function exactArgv(argv, spec) {
  const expected = ["demo", "--swarm", "--live", "--engine", "codex", "--agents", String(spec.agents), "--max-concurrency", String(spec.maxConcurrency), "--budget-usd", String(spec.budgetUsd)];
  return Array.isArray(argv) && argv.length === expected.length && argv.every((value, index) => value === expected[index]);
}
export async function captureImmutableFileSnapshot(inputPath, options) {
  if (typeof inputPath !== "string" || !isAbsolute(inputPath)) throw new Error(`${options.label} path must be absolute`);
  const requested = resolve(inputPath); const root = await canonicalDirectory(options.root, `${options.label} root`); const info = await lstat(requested);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${options.label} must be a regular non-link file`);
  if (typeof info.nlink === "number" && info.nlink !== 1) throw new Error(`${options.label} must not be a hard-link alias`);
  const canonical = await realpath(requested);
  if (!samePath(requested, canonical)) throw new Error(`${options.label} must use its canonical path without link aliases`);
  if (!contains(root, canonical)) throw new Error(`${options.label} escapes its authorized root`);
  if (options.expected && !samePath(canonical, options.expected)) throw new Error(`${options.label} path is not the fixed trusted path`);
  const bytes = await readFile(canonical); const current = await stat(canonical);
  const snapshot = { path: canonical, bytes, sha256: hash(bytes), size: current.size, mtimeMs: current.mtimeMs, ino: current.ino, dev: current.dev };
  options.snapshots.push(snapshot); return snapshot;
}
export async function verifyImmutableFileSnapshots(snapshots) {
  for (const snapshot of snapshots) {
    const current = await lstat(snapshot.path);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.size !== snapshot.size || current.mtimeMs !== snapshot.mtimeMs || current.ino !== snapshot.ino || current.dev !== snapshot.dev) throw new Error(`post-validation mutation or alias detected: ${snapshot.path}`);
    if (hash(await readFile(snapshot.path)) !== snapshot.sha256) throw new Error(`post-validation byte mutation detected: ${snapshot.path}`);
  }
}
const snapshotFile = captureImmutableFileSnapshot;
const verifyUnchangedSnapshots = verifyImmutableFileSnapshots;
async function snapshotTrustedKeyTree(root, snapshots) {
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`external integrity key tree contains a link alias: ${path}`);
    if (entry.isDirectory()) count += await snapshotTrustedKeyTree(path, snapshots);
    else if (entry.isFile()) { await snapshotFile(path, { root, label: "external integrity key", snapshots }); count += 1; }
    else throw new Error(`external integrity key tree contains a non-file entry: ${path}`);
  }
  return count;
}
async function snapshotPackageTree(root, snapshots, base = root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`candidate package tree contains a link alias: ${path}`);
    if (entry.isDirectory()) files.push(...await snapshotPackageTree(path, snapshots, base));
    else if (entry.isFile()) {
      const file = await snapshotFile(path, { root: base, label: "candidate package file", snapshots });
      files.push({ path: relative(base, file.path).replaceAll("\\", "/"), sha256: file.sha256 });
    } else throw new Error(`candidate package tree contains a non-file entry: ${path}`);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
async function canonicalDirectory(inputPath, label) {
  if (typeof inputPath !== "string" || !isAbsolute(inputPath)) throw new Error(`${label} must be an absolute directory`);
  const requested = resolve(inputPath); const info = await lstat(requested);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a non-link directory`);
  const canonical = await realpath(requested);
  if (!samePath(requested, canonical)) throw new Error(`${label} must use its canonical path without link aliases`);
  return canonical;
}
function contains(root, candidate) { const rel = relative(root, candidate); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }
function samePath(left, right) { if (typeof left !== "string" || typeof right !== "string") return false; const a = resolve(left); const b = resolve(right); return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }
function parseJson(bytes, label) { try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} must contain valid JSON`); } }
function finiteNonnegative(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
export function equalUsd(left, right) {
  if (!finiteNonnegative(left) || !finiteNonnegative(right)) return false;
  const micros = (value) => Math.round(value * 1_000_000);
  return micros(left) === micros(right);
}
function sameStrings(left, right) { return Array.isArray(left) && Array.isArray(right) && stableJson([...left].sort()) === stableJson([...right].sort()); }
function stableJson(value) { return JSON.stringify(canonicalize(value)); }
function canonicalize(value) { if (Array.isArray(value)) return value.map(canonicalize); if (!record(value)) return value; return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])); }
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function message(error) { return error instanceof Error ? error.message : String(error); }
