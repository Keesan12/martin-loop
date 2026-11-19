#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  assertRepoOwnedEvidenceRoot,
  computeCoreRuntimeSha256,
  createAcceptanceBinding,
  createResourcePolicy,
  createScenarioManifest,
  deriveAcceptanceEvidence,
  recoverRestartJournal,
  runHarness,
} from "./overnight/harness.mjs";
import { resolveReleaseCommandExecution } from "./lib/release-command-runner.mjs";
import { runContinuousAcceptance } from "./overnight/acceptance-runner.mjs";
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
} from "./overnight/github-anchor.mjs";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const pending = `${path}.pending.${process.pid}`;
  const handle = openSync(pending, "wx");
  try {
    writeSync(handle, `${JSON.stringify(value, null, 2)}\n`, null, "utf8");
    fsyncSync(handle);
  } finally { closeSync(handle); }
  try { renameSync(pending, path); }
  catch (error) { rmSync(pending, { force: true }); throw error; }
}

function ghJson(args, cwd) {
  try {
    return JSON.parse(execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim();
    throw new Error(`authenticated GitHub CLI access is required for production acceptance anchors: ${detail}`);
  }
}

function assertPrivateAnchorRepository(repository, cwd) {
  const auth = spawnSync("gh", ["auth", "status"], { cwd, encoding: "utf8" });
  assertGitHubCliAuthenticated(auth);
  const originUrl = execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" }).trim();
  parseGitHubRepositoryFromRemoteUrl(originUrl, repository);
  const current = ghJson(["repo", "view", repository, "--json", "nameWithOwner,isPrivate"], cwd);
  if (current?.isPrivate !== true || current?.nameWithOwner?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error("acceptance anchor repository must equal the current private origin repository");
  }
  const metadata = ghJson(["api", `repos/${repository}`], cwd);
  const login = ghJson(["api", "user"], cwd)?.login;
  if (typeof login !== "string" || !login) throw new Error("authenticated GitHub actor identity is unavailable");
  let association;
  if (metadata?.owner?.login?.toLowerCase() === login.toLowerCase()) association = "OWNER";
  else if (metadata?.owner?.type === "Organization"
    && spawnSync("gh", ["api", `orgs/${metadata.owner.login}/members/${login}`, "--silent"], { cwd }).status === 0) association = "MEMBER";
  else if (metadata?.permissions?.admin === true || metadata?.permissions?.maintain === true || metadata?.permissions?.push === true) association = "COLLABORATOR";
  else throw new Error("authenticated GitHub actor lacks trusted repository association");
  return { repository: current.nameWithOwner, actor: { login, association } };
}

function fetchAnchorComment(repository, commentId, cwd) {
  return ghJson(["api", `repos/${repository}/issues/comments/${commentId}`], cwd);
}

function ensureLiveAnchor({ root, kind, repository, issue, actor, expectedBody, cwd, path: explicitPath }) {
  const path = explicitPath ?? resolve(root, `github-anchor-${kind}.json`);
  if (existsSync(path)) {
    const record = JSON.parse(readFileSync(path, "utf8"));
    return verifyGitHubAnchorRecord({
      record, repository, issue, actor, expectedBody,
      comment: fetchAnchorComment(repository, record.commentId, cwd),
    });
  }
  const posted = ghJson([
    "api", `repos/${repository}/issues/${issue}/comments`, "--method", "POST", "-f", `body=${expectedBody}`,
  ], cwd);
  const record = parseGitHubAnchorComment({ repository, issue, actor, expectedBody, comment: posted });
  const verified = verifyGitHubAnchorRecord({
    record, repository, issue, actor, expectedBody,
    comment: fetchAnchorComment(repository, record.commentId, cwd),
  });
  writeJsonAtomic(path, verified);
  return verified;
}

function numberOption(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid numeric option: ${value}`);
  return parsed;
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : entry.isFile() ? [path] : [];
  }).sort();
}

function createProductionBinding(input) {
  const testBinding = createAcceptanceBinding({ ...input, evidenceKind: "test" });
  if (!input.anchor) throw new Error("production binding requires GitHub anchor authority");
  return {
    ...testBinding,
    evidenceKind: "acceptance",
    executionTrustBoundary: PRODUCTION_EXECUTION_TRUST_BOUNDARY,
    anchor: {
      ...input.anchor,
      maxCheckpointGapMs: checkpointMaxGapMs(testBinding.requiredDurationMs, testBinding.minimumBoundedRuns),
    },
  };
}

function withoutQualification(evidence) {
  const { qualified: _qualified, githubServerElapsedMs: _elapsed, ...structural } = evidence ?? {};
  return structural;
}

function startAnchorBody(binding) {
  return canonicalGitHubAnchorBody({
    kind: "start",
    bindingSha256: sha256(canonicalJson(binding)),
    mode: binding.mode,
    scenarioId: binding.scenarioId,
    sourceSha: binding.authority.sourceSha,
  });
}

function checkpointAnchorBody(binding, event, receipt, ordinal, previousCommentId) {
  return canonicalGitHubAnchorBody({
    kind: "checkpoint",
    bindingSha256: sha256(canonicalJson(binding)),
    ordinal,
    previousCommentId,
    runId: event.runId,
    receiptSha256: event.receiptSha256,
    runtimeDossierSha256: receipt.runtimeDossierSha256,
    journalHeadHash: event.hash,
    sourceSha: binding.authority.sourceSha,
    coreRuntimeSha256: binding.authority.coreRuntimeSha256,
  });
}

function reconcileCheckpointAnchors({
  root, binding, start, repository, issue, actor, cwd, createMissing, verifiedPrefix = [],
}) {
  const events = recoverRestartJournal(root).events.filter((event) => event.type === "bounded_run_committed");
  const pending = pendingGitHubCheckpointEvents(events, verifiedPrefix.length);
  const checkpoints = [...verifiedPrefix];
  let previousCommentId = checkpoints.at(-1)?.commentId ?? start.commentId;
  for (const [offset, event] of pending.entries()) {
    const index = verifiedPrefix.length + offset;
    const receipt = JSON.parse(readFileSync(resolve(root, ...event.receiptPath.split("/")), "utf8"));
    const path = resolve(root, "github-anchor-checkpoints", `${String(index + 1).padStart(6, "0")}-${event.runId}.json`);
    if (!createMissing && !existsSync(path)) throw new Error("qualifying run is missing its live GitHub checkpoint anchor");
    const checkpoint = ensureLiveAnchor({
      root, kind: "checkpoint", repository, issue, actor, cwd, path,
      expectedBody: checkpointAnchorBody(binding, event, receipt, index + 1, previousCommentId),
    });
    checkpoints.push(checkpoint);
    previousCommentId = checkpoint.commentId;
  }
  return checkpoints;
}

function endAnchorBody(binding, structuralEvidence, start, checkpoints) {
  return canonicalGitHubAnchorBody({
    kind: "end",
    bindingSha256: sha256(canonicalJson(binding)),
    evidenceSha256: sha256(canonicalJson(structuralEvidence)),
    journalHeadHash: structuralEvidence.journalHeadHash,
    startCommentId: start.commentId,
    checkpointCount: checkpoints.length,
    lastCheckpointCommentId: checkpoints.at(-1)?.commentId ?? "none",
  });
}

function verifyCompletedPredecessor({ root, dossier, binding, repository, issue, actor, cwd }) {
  const structural = deriveAcceptanceEvidence(root, binding);
  const persistedStructural = withoutQualification(dossier?.evidence);
  if (dossier?.schemaVersion !== "martin.overnight.acceptance-dossier.v1"
    || dossier.mode !== "8h" || dossier.status !== "COMPLETED" || dossier.evidenceKind !== "acceptance"
    || dossier.evidence?.qualified !== true || structural.requirementsSatisfied !== true
    || canonicalJson(persistedStructural) !== canonicalJson(structural)
    || canonicalJson(dossier.authority) !== canonicalJson(binding.authority)) {
    throw new Error("24h predecessor local evidence did not independently rederive");
  }
  const start = verifyGitHubAnchorRecord({
    record: dossier.anchors?.start, repository, issue, actor, expectedBody: startAnchorBody(binding),
    comment: fetchAnchorComment(repository, dossier.anchors?.start?.commentId, cwd),
  });
  const checkpoints = reconcileCheckpointAnchors({
    root, binding, start, repository, issue, actor, cwd, createMissing: false,
  });
  if (checkpoints.length !== structural.boundedRuns) throw new Error("GitHub checkpoint count does not match qualifying bounded runs");
  const end = verifyGitHubAnchorRecord({
    record: dossier.anchors?.end, repository, issue, actor,
    expectedBody: endAnchorBody(binding, structural, start, checkpoints),
    comment: fetchAnchorComment(repository, dossier.anchors?.end?.commentId, cwd),
  });
  const githubServerElapsedMs = assertGitHubServerElapsed(start, end, binding.requiredDurationMs);
  assertGitHubCheckpointCadence({
    start, checkpoints, end, minimumCount: binding.minimumBoundedRuns,
    maxGapMs: binding.anchor.maxCheckpointGapMs,
  });
  const expected = {
    schemaVersion: "martin.overnight.acceptance-dossier.v1",
    scenarioId: binding.scenarioId,
    mode: binding.mode,
    evidenceKind: "acceptance",
    executionTrustBoundary: binding.executionTrustBoundary,
    status: "COMPLETED",
    authority: binding.authority,
    anchorAuthority: binding.anchor,
    predecessor8hDossierSha256: binding.predecessor8hDossierSha256,
    requiredDurationMs: binding.requiredDurationMs,
    minimumBoundedRuns: binding.minimumBoundedRuns,
    anchors: { start, checkpoints, end },
    evidence: { ...structural, githubServerElapsedMs, qualified: true },
  };
  if (canonicalJson(dossier) !== canonicalJson(expected)) {
    throw new Error("24h predecessor completed dossier is not the full canonical projection");
  }
  return { structural, start, checkpoints, end, githubServerElapsedMs };
}

function completeProductionAcceptance({ root, binding, repository, issue, actor, start, cwd }) {
  const structural = deriveAcceptanceEvidence(root, binding);
  if (structural.requirementsSatisfied !== true) throw new Error("local acceptance requirements are not satisfied");
  const liveStart = verifyGitHubAnchorRecord({
    record: start, repository, issue, actor, expectedBody: startAnchorBody(binding),
    comment: fetchAnchorComment(repository, start.commentId, cwd),
  });
  const checkpoints = reconcileCheckpointAnchors({
    root, binding, start: liveStart, repository, issue, actor, cwd, createMissing: true,
  });
  if (checkpoints.length !== structural.boundedRuns) throw new Error("GitHub checkpoint count does not match qualifying bounded runs");
  const end = ensureLiveAnchor({
    root, kind: "end", repository, issue, actor,
    expectedBody: endAnchorBody(binding, structural, liveStart, checkpoints), cwd,
  });
  let githubServerElapsedMs;
  try {
    githubServerElapsedMs = assertGitHubServerElapsed(liveStart, end, binding.requiredDurationMs);
    assertGitHubCheckpointCadence({
      start: liveStart, checkpoints, end, minimumCount: binding.minimumBoundedRuns,
      maxGapMs: binding.anchor.maxCheckpointGapMs,
    });
  } catch (error) {
    rmSync(resolve(root, "github-anchor-end.json"), { force: true });
    throw error;
  }
  const evidence = { ...structural, githubServerElapsedMs, qualified: true };
  const dossier = {
    schemaVersion: "martin.overnight.acceptance-dossier.v1",
    scenarioId: binding.scenarioId,
    mode: binding.mode,
    evidenceKind: "acceptance",
    executionTrustBoundary: binding.executionTrustBoundary,
    status: "COMPLETED",
    authority: binding.authority,
    anchorAuthority: binding.anchor,
    predecessor8hDossierSha256: binding.predecessor8hDossierSha256,
    requiredDurationMs: binding.requiredDurationMs,
    minimumBoundedRuns: binding.minimumBoundedRuns,
    anchors: { start: liveStart, checkpoints, end },
    evidence,
  };
  const target = resolve(root, "acceptance-dossier.json");
  if (existsSync(target)) {
    const existing = JSON.parse(readFileSync(target, "utf8"));
    if (canonicalJson(existing) !== canonicalJson(dossier)) throw new Error("completed acceptance dossier is immutable");
  } else writeJsonAtomic(target, dossier);
  return { status: "COMPLETED", evidence, dossier, sha256: sha256(canonicalJson(dossier)), path: target };
}

function usage() {
  return `Usage: node scripts/overnight-harness.mjs --mode <smoke|8h|24h> --root <repo-owned-path> [options]

Options:
  --scenario-id <id>       Stable scenario identifier
  --seed <seed>            Deterministic fault seed
  --max-ticks <n>          Bounded work per invocation (resume by invoking again)
  --workers <n>            Worker concurrency (default 2)
  --providers <n>          Provider concurrency bound (default 1; provider-free harness makes no calls)
  --tests <n>              Focused-test concurrency (default 1)
  --cpu-percent <n>        CPU policy ceiling (default 75)
  --memory-mb <n>          Memory policy ceiling (default 1024)
  --disk-mb <n>            Disk policy ceiling (default 2048)
  --rate-per-minute <n>    Operation rate ceiling (default 60)
  --spend-usd <n>          Spend ceiling (default 0)
  --predecessor-8h <path>  Verified completed 8h dossier required by 24h
  --anchor-repo <owner/name> Private GitHub repository for server-time anchors (required for 8h/24h)
  --anchor-issue <n>       Private audit issue for start/end anchors (required for 8h/24h)
  --json                   Emit the result as JSON
`;
}

const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    root: { type: "string" },
    "scenario-id": { type: "string", default: "overnight-chaos" },
    seed: { type: "string", default: "martin-overnight-v1" },
    "max-ticks": { type: "string" },
    workers: { type: "string" },
    providers: { type: "string" },
    tests: { type: "string" },
    "cpu-percent": { type: "string" },
    "memory-mb": { type: "string" },
    "disk-mb": { type: "string" },
    "rate-per-minute": { type: "string" },
    "spend-usd": { type: "string" },
    "predecessor-8h": { type: "string" },
    "anchor-repo": { type: "string" },
    "anchor-issue": { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (values.help) {
  process.stdout.write(usage());
  process.exit(0);
}

try {
  if (!values.mode || !values.root) throw new Error("--mode and --root are required");
  const repositoryRoot = resolve(process.cwd());
  const requestedRoot = resolve(repositoryRoot, values.root);
  const relativeRoot = relative(repositoryRoot, requestedRoot);
  if (!relativeRoot || relativeRoot.startsWith("..") || isAbsolute(relativeRoot)) {
    throw new Error("--root must resolve to a child path inside the current repository");
  }
  const root = assertRepoOwnedEvidenceRoot(repositoryRoot, requestedRoot);
  const manifest = createScenarioManifest({ scenarioId: values["scenario-id"], seed: values.seed, mode: values.mode });
  const policy = createResourcePolicy({
    concurrency: {
      workers: numberOption(values.workers, 2),
      providers: numberOption(values.providers, 1),
      tests: numberOption(values.tests, 1),
      observer: 1,
      broadTests: 1,
    },
    limits: {
      cpuPercent: numberOption(values["cpu-percent"], 75),
      memoryMb: numberOption(values["memory-mb"], 1_024),
      diskMb: numberOption(values["disk-mb"], 2_048),
      operationsPerMinute: numberOption(values["rate-per-minute"], 60),
      spendUsd: numberOption(values["spend-usd"], 0),
    },
  });
  let result;
  if (values.mode === "smoke") {
    const maxTicks = numberOption(values["max-ticks"], 6);
    result = runHarness({ root, manifest, policy, maxTicks });
  } else {
    let anchorRepository = values["anchor-repo"];
    const anchorIssue = Number(values["anchor-issue"]);
    if (!anchorRepository || !Number.isSafeInteger(anchorIssue) || anchorIssue < 1) {
      throw new Error("8h/24h acceptance requires --anchor-repo and a positive --anchor-issue");
    }
    const anchorAuthority = assertPrivateAnchorRepository(anchorRepository, repositoryRoot);
    anchorRepository = anchorAuthority.repository;
    const anchorActor = anchorAuthority.actor;
    if (values["max-ticks"] !== undefined) throw new Error("--max-ticks is smoke-only; acceptance soaks run continuously");
    const bindingPath = resolve(root, "acceptance-binding.json");
    const resuming = existsSync(bindingPath);
    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
    let predecessor8hDossierSha256 = null;
    let predecessorRoot = null;
    if (values.mode === "24h") {
      if (!values["predecessor-8h"]) throw new Error("24h acceptance requires --predecessor-8h");
      const requestedPredecessor = resolve(repositoryRoot, values["predecessor-8h"]);
      assertRepoOwnedEvidenceRoot(repositoryRoot, requestedPredecessor);
      predecessorRoot = assertRepoOwnedEvidenceRoot(repositoryRoot, resolve(requestedPredecessor, ".."));
      const predecessorPath = resolve(predecessorRoot, "acceptance-dossier.json");
      if (requestedPredecessor !== predecessorPath) throw new Error("24h predecessor must be the canonical acceptance-dossier.json");
      const predecessorRaw = readFileSync(predecessorPath);
      const predecessor = JSON.parse(predecessorRaw.toString("utf8"));
      const predecessorBinding = JSON.parse(readFileSync(resolve(predecessorRoot, "acceptance-binding.json"), "utf8"));
      const canonicalPredecessorBinding = createProductionBinding({
        scenarioId: predecessorBinding.scenarioId,
        mode: predecessorBinding.mode,
        sourceSha: predecessorBinding.authority?.sourceSha,
        runnerSha256: predecessorBinding.authority?.runnerSha256,
        policySha256: predecessorBinding.authority?.policySha256,
        coreRuntimeSha256: predecessorBinding.authority?.coreRuntimeSha256,
        predecessor8hDossierSha256: predecessorBinding.predecessor8hDossierSha256,
        anchor: { repository: anchorRepository, issue: anchorIssue, actor: anchorActor },
      });
      if (canonicalJson(predecessorBinding) !== canonicalJson(canonicalPredecessorBinding)
        || predecessorBinding.authority?.sourceSha !== sourceSha) {
        throw new Error("24h predecessor journal/binding/dossier did not independently verify for this exact source SHA");
      }
      verifyCompletedPredecessor({
        root: predecessorRoot, dossier: predecessor, binding: predecessorBinding,
        repository: anchorRepository, issue: anchorIssue, actor: anchorActor, cwd: repositoryRoot,
      });
      predecessor8hDossierSha256 = createHash("sha256").update(predecessorRaw).digest("hex");
    }
    const trackedDirty = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=no"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: repositoryRoot, encoding: "utf8" })
      .split(/\r?\n/u).filter(Boolean);
    const rootRelative = relative(repositoryRoot, root).replaceAll("\\", "/");
    const allowedEvidenceRoots = [rootRelative];
    if (predecessorRoot !== null) allowedEvidenceRoots.push(relative(repositoryRoot, predecessorRoot).replaceAll("\\", "/"));
    const foreignUntracked = untracked.filter((path) => !allowedEvidenceRoots.some((allowed) => path === allowed || path.startsWith(`${allowed}/`)));
    if (trackedDirty || foreignUntracked.length > 0 || (!resuming && untracked.some((path) => path.startsWith(`${rootRelative}/`)))) {
      throw new Error("acceptance requires an exact clean source tree; on resume only its bound evidence root may be untracked");
    }
    const runnerFiles = [
      new URL(import.meta.url),
      new URL("./overnight/harness.mjs", import.meta.url),
      new URL("./overnight/acceptance-runner.mjs", import.meta.url),
      new URL("./overnight/integrated-mission-fixture.mjs", import.meta.url),
      new URL("./overnight/github-anchor.mjs", import.meta.url),
    ];
    const coreRuntimeRoot = resolve(repositoryRoot, "packages/core/dist");
    rmSync(coreRuntimeRoot, { recursive: true, force: true });
    const coreBuild = resolveReleaseCommandExecution(["pnpm", "--filter", "@martin/core", "build"]);
    execFileSync(coreBuild.command, coreBuild.args, {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
    const runnerSha256 = createHash("sha256");
    for (const path of runnerFiles) runnerSha256.update(readFileSync(path));
    if (!existsSync(resolve(coreRuntimeRoot, "mission/index.js"))) {
      throw new Error("acceptance requires a fresh built @martin/core runtime");
    }
    const coreRuntimeSha256 = computeCoreRuntimeSha256(coreRuntimeRoot);
    for (const path of listFiles(coreRuntimeRoot)) {
      runnerSha256.update(relative(coreRuntimeRoot, path).replaceAll("\\", "/"));
      runnerSha256.update(readFileSync(path));
    }
    const policySha256 = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
    const binding = createProductionBinding({
      scenarioId: values["scenario-id"], mode: values.mode, sourceSha,
      runnerSha256: runnerSha256.digest("hex"), policySha256, coreRuntimeSha256, predecessor8hDossierSha256,
      anchor: { repository: anchorRepository, issue: anchorIssue, actor: anchorActor },
    });
    const start = ensureLiveAnchor({
      root, kind: "start", repository: anchorRepository, issue: anchorIssue, actor: anchorActor,
      expectedBody: startAnchorBody(binding), cwd: repositoryRoot,
    });
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    let checkpointAnchors = reconcileCheckpointAnchors({
      root, binding, start, repository: anchorRepository, issue: anchorIssue,
      actor: anchorActor, cwd: repositoryRoot, createMissing: true,
    });
    result = await runContinuousAcceptance({
      root, binding, policy, signal: controller.signal,
      onBoundedRunCommitted: async () => {
        checkpointAnchors = reconcileCheckpointAnchors({
          root, binding, start, repository: anchorRepository, issue: anchorIssue,
          actor: anchorActor, cwd: repositoryRoot, createMissing: true,
          verifiedPrefix: checkpointAnchors,
        });
      },
    });
    if (result.status === "REQUIREMENTS_SATISFIED") {
      result = completeProductionAcceptance({
        root, binding, repository: anchorRepository, issue: anchorIssue, actor: anchorActor,
        start, cwd: repositoryRoot,
      });
    }
  }
  if (result.status === "BLOCKED") process.exitCode = 1;
  else if (result.status === "PAUSED") process.exitCode = 2;
  if (values.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else if (values.mode === "smoke") {
    process.stdout.write(`${result.status} ${result.dossier.mode} ticks=${result.ticksCompleted} elapsedMs=${result.dossier.elapsedMs}\n`);
  } else {
    process.stdout.write(`${result.status} ${values.mode} runs=${result.evidence.boundedRuns} activeElapsedMs=${result.evidence.activeElapsedMs}\n`);
  }
} catch (error) {
  process.stderr.write(`overnight harness: ${error.message}\n`);
  process.exitCode = 1;
}
