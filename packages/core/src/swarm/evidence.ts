import { createHash } from "node:crypto";
import { link, lstat, open, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { LoopRecord, SwarmLiveEvent, SwarmLivePlan, SwarmOutcome } from "@martin/contracts";

import { verifyReceiptIntegrityFromFiles } from "../persistence/integrity.js";

import {
  readCanonicalSwarmLiveEvidenceBundle,
  SwarmLiveStoreError,
  type SwarmLiveSnapshot
} from "./live-store.js";
import { assertSwarmPathIdentifier } from "./workspaces.js";

export const SWARM_EVIDENCE_INDEX_SCHEMA_VERSION = "martin.swarm-evidence-index.v1" as const;

export interface SwarmEvidenceIndexFile {
  kind: "operational" | "artifact";
  path: string;
  sha256: string;
  bytes: number;
}

export interface SwarmEvidenceIndex {
  schemaVersion: typeof SWARM_EVIDENCE_INDEX_SCHEMA_VERSION;
  swarmId: string;
  planHash: string;
  revision: number;
  outcome: SwarmOutcome;
  sealedAt: string;
  files: SwarmEvidenceIndexFile[];
}

export interface ReadAndSealSwarmEvidenceResult {
  index: SwarmEvidenceIndex;
  indexPath: string;
  indexBytes: string;
  model: SealedSwarmEvidenceModel;
}

export interface SealedSwarmEvidenceArtifact {
  path: string;
  value: Record<string, unknown>;
}

export interface SealedSwarmEvidenceModel {
  plan: SwarmLivePlan;
  events: SwarmLiveEvent[];
  snapshot: SwarmLiveSnapshot;
  artifacts: SealedSwarmEvidenceArtifact[];
}

interface EvidenceArtifact {
  path: string;
  relativePath: string;
  bytes: Buffer;
  value: Record<string, unknown>;
}

interface EvidenceSourceFile {
  path: string;
  bytes: Buffer;
  mtimeMs: number;
  size: number;
}

export async function readAndSealSwarmEvidence(input: {
  rootDir: string;
  swarmId: string;
  /** Internal deterministic race-test seam; not exported from the Core package root. */
  beforePublish?: () => Promise<void>;
}): Promise<ReadAndSealSwarmEvidenceResult> {
  assertSwarmPathIdentifier(input.swarmId, "swarm ID");
  const roots = await resolveExistingEvidenceRoots(input.rootDir, input.swarmId);
  const bundle = await readCanonicalSwarmLiveEvidenceBundle({
    directory: roots.swarmRoot,
    swarmId: input.swarmId
  });
  const artifacts = await readEvidenceArtifacts(roots.evidenceRoot, input.swarmId);
  validateArtifactContents(bundle.plan, bundle.snapshot.outcome, bundle.events, artifacts);
  const childProofs = await validateReferencedArtifacts(
    roots.runsRoot,
    bundle.plan,
    bundle.events,
    artifacts
  );

  const files: SwarmEvidenceIndexFile[] = [
    ...bundle.files.map((file) => ({
      kind: "operational" as const,
      path: normalizeRelative(relative(roots.swarmRoot, file.path)),
      sha256: sha256(file.bytes),
      bytes: file.bytes.byteLength
    })),
    ...artifacts.map((artifact) => ({
      kind: "artifact" as const,
      path: `evidence/${artifact.relativePath}`,
      sha256: sha256(artifact.bytes),
      bytes: artifact.bytes.byteLength
    })),
    ...childProofs.map((proof) => ({
      kind: "artifact" as const,
      path: normalizeRelative(relative(roots.runsRoot, proof.path)),
      sha256: sha256(proof.bytes),
      bytes: proof.bytes.byteLength
    }))
  ].sort((left, right) => left.path.localeCompare(right.path));

  const index: SwarmEvidenceIndex = {
    schemaVersion: SWARM_EVIDENCE_INDEX_SCHEMA_VERSION,
    swarmId: bundle.plan.swarmId,
    planHash: bundle.plan.planHash,
    revision: bundle.snapshot.revision,
    outcome: structuredClone(bundle.snapshot.outcome),
    sealedAt: bundle.snapshot.updatedAt,
    files
  };
  const indexPath = join(roots.evidenceRoot, "evidence-index.json");
  const sources = await captureSourceState([
    ...bundle.files.map((file) => ({ path: file.path, bytes: file.bytes })),
    ...artifacts.map((artifact) => ({ path: artifact.path, bytes: artifact.bytes })),
    ...childProofs
  ]);
  await input.beforePublish?.();
  await assertSourcesUnchanged(sources);
  const indexBytes = `${JSON.stringify(index, null, 2)}\n`;
  await writeIndexOnce(indexPath, indexBytes);
  return {
    index,
    indexPath,
    indexBytes,
    model: {
      plan: structuredClone(bundle.plan),
      events: bundle.events.map((event) => structuredClone(event)),
      snapshot: structuredClone(bundle.snapshot),
      artifacts: artifacts.map((artifact) => ({
        path: `evidence/${artifact.relativePath}`,
        value: structuredClone(artifact.value)
      }))
    }
  };
}

async function resolveExistingEvidenceRoots(rootDir: string, swarmId: string): Promise<{
  runsRoot: string;
  swarmsRoot: string;
  swarmRoot: string;
  evidenceRoot: string;
}> {
  const runsRoot = await existingExactDirectory(resolve(rootDir), "MISSING_SWARM_STORE");
  const swarmsRoot = await existingExactDirectory(join(runsRoot, "_swarms"), "MISSING_SWARM_STORE");
  assertContained(runsRoot, swarmsRoot);
  const swarmRoot = await existingExactDirectory(join(swarmsRoot, swarmId), "MISSING_SWARM_STORE");
  assertContained(swarmsRoot, swarmRoot);
  const evidenceRoot = await existingExactDirectory(join(swarmRoot, "evidence"), "MISSING_SWARM_EVIDENCE");
  assertContained(swarmRoot, evidenceRoot);
  return { runsRoot, swarmsRoot, swarmRoot, evidenceRoot };
}

async function existingExactDirectory(lexicalPath: string, missingCode: string): Promise<string> {
  const expected = resolve(lexicalPath);
  const metadata = await lstat(expected).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SwarmLiveStoreError(missingCode, "Required swarm evidence path is missing.", { path: expected });
    }
    throw error;
  });
  const canonical = await existingRealpath(expected, missingCode);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || resolve(canonical) !== expected) {
    throw new SwarmLiveStoreError("EVIDENCE_PATH_ALIAS", "Swarm evidence roots must be exact canonical directories.", {
      path: expected
    });
  }
  return canonical;
}

async function readEvidenceArtifacts(evidenceRoot: string, swarmId: string): Promise<EvidenceArtifact[]> {
  const artifacts: EvidenceArtifact[] = [];
  await walkEvidenceDirectory(evidenceRoot, evidenceRoot, artifacts, new Set([evidenceRoot]));
  artifacts.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  for (const artifact of artifacts) {
    if (artifact.relativePath === "evidence-index.json") continue;
    const artifactSwarmId = artifact.value.swarmId;
    if (artifactSwarmId !== undefined && artifactSwarmId !== swarmId) {
      throw new SwarmLiveStoreError("EVIDENCE_SWARM_MISMATCH", "Evidence artifact belongs to a different swarm.", {
        path: artifact.relativePath
      });
    }
  }
  return artifacts.filter((artifact) => artifact.relativePath !== "evidence-index.json");
}

const PHASE5_SEAL_OUTPUTS = new Set([
  "evidence-index.json",
  "parent-receipt.json",
  "swarm-receipt-integrity.json",
  "swarm-receipt-seal.json",
  "swarm-receipt-seal-status.json"
]);

async function walkEvidenceDirectory(
  evidenceRoot: string,
  directory: string,
  artifacts: EvidenceArtifact[],
  seenCanonicalPaths: Set<string>
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const lexicalPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new SwarmLiveStoreError("EVIDENCE_PATH_ALIAS", "Evidence cannot contain symbolic-link or junction aliases.", {
        path: lexicalPath
      });
    }
    const canonicalPath = await existingRealpath(lexicalPath, "MISSING_SWARM_EVIDENCE");
    assertContained(evidenceRoot, canonicalPath);
    if (seenCanonicalPaths.has(canonicalPath)) {
      throw new SwarmLiveStoreError("EVIDENCE_PATH_ALIAS", "Evidence contains a duplicate canonical path.", {
        path: canonicalPath
      });
    }
    seenCanonicalPaths.add(canonicalPath);
    if (entry.isDirectory()) {
      await walkEvidenceDirectory(evidenceRoot, canonicalPath, artifacts, seenCanonicalPaths);
      continue;
    }
    if (!entry.isFile()) {
      throw new SwarmLiveStoreError("MALFORMED_SWARM_EVIDENCE", "Evidence contains an unsupported filesystem entry.");
    }
    const relativePath = normalizeRelative(relative(evidenceRoot, canonicalPath));
    if (PHASE5_SEAL_OUTPUTS.has(relativePath)) continue;
    if (!relativePath.endsWith(".json")) {
      throw new SwarmLiveStoreError("MALFORMED_SWARM_EVIDENCE", "Evidence artifacts must be JSON files.", {
        path: relativePath
      });
    }
    const bytes = await readFile(canonicalPath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new SwarmLiveStoreError("MALFORMED_SWARM_EVIDENCE", "Evidence artifact contains malformed JSON.", {
        path: relativePath
      });
    }
    if (!isRecord(parsed)) {
      throw new SwarmLiveStoreError("MALFORMED_SWARM_EVIDENCE", "Evidence artifact must contain a JSON object.", {
        path: relativePath
      });
    }
    artifacts.push({ path: canonicalPath, relativePath, bytes, value: parsed });
  }
}

async function validateReferencedArtifacts(
  runsRoot: string,
  plan: SwarmLivePlan,
  events: readonly SwarmLiveEvent[],
  artifacts: readonly EvidenceArtifact[]
): Promise<Array<{ path: string; bytes: Buffer }>> {
  const childCompletions = artifacts
    .filter((artifact) => artifact.relativePath.startsWith("child-completions/"))
    .map((artifact) => artifact.value);
  const cleanupArtifacts = artifacts
    .filter((artifact) => artifact.relativePath.startsWith("cleanup/"))
    .map((artifact) => artifact.value);
  const proofFiles: Array<{ path: string; bytes: Buffer }> = [];
  const startedChildRuns = events
    .filter((event) => event.type === "CHILD_STARTED" && event.childRunId)
    .map((event) => event.childRunId!);
  if (new Set(startedChildRuns).size !== startedChildRuns.length) {
    throw new SwarmLiveStoreError("DUPLICATE_CHILD_START_EVIDENCE", "A child run has multiple start event claims.");
  }
  const seenChildRuns = new Set<string>();
  for (const event of events) {
    if (
      !event.childRunId
      || !["CHILD_VERIFIED", "CHILD_STOPPED", "CHILD_NEEDS_REVIEW"].includes(event.type)
    ) continue;
    if (!startedChildRuns.includes(event.childRunId)) {
      const blockedLaunch = events.some((candidate) => (
        candidate.type === "ACTION_BLOCKED"
        && candidate.childRunId === event.childRunId
        && candidate.taskId === event.taskId
        && candidate.agentId === event.agentId
        && candidate.payload.action === "child_launch"
      ));
      if (!blockedLaunch) {
        throw new SwarmLiveStoreError(
          "ORPHAN_CHILD_TERMINAL_EVIDENCE",
          "A child terminal event without a start must be bound to an explicit blocked launch."
        );
      }
      continue;
    }
    if (seenChildRuns.has(event.childRunId)) {
      throw new SwarmLiveStoreError("DUPLICATE_CHILD_TERMINAL_EVIDENCE", "A child run has multiple terminal event claims.", {
        childRunId: event.childRunId
      });
    }
    seenChildRuns.add(event.childRunId);
    const completions = childCompletions.filter((value) => value.childRunId === event.childRunId);
    const completion = completions[0];
    if (!completion || completions.length !== 1) {
      throw new SwarmLiveStoreError("MISSING_CHILD_EVIDENCE", "Terminal child event has no persisted completion evidence.", {
        childRunId: event.childRunId
      });
    }
    proofFiles.push(...await validateChildProof(runsRoot, plan, event, completion, artifacts));
    const cleanup = completion.cleanup;
    if (isRecord(cleanup) && typeof cleanup.cleanupId === "string") {
      if (!cleanupArtifacts.some((value) => value.cleanupId === cleanup.cleanupId)) {
        throw new SwarmLiveStoreError("MISSING_CLEANUP_EVIDENCE", "Child completion references missing cleanup evidence.", {
          childRunId: event.childRunId,
          cleanupId: cleanup.cleanupId
        });
      }
    }
  }
  for (const childRunId of startedChildRuns) {
    if (!seenChildRuns.has(childRunId)) {
      throw new SwarmLiveStoreError("MISSING_CHILD_TERMINAL_EVIDENCE", "Started child run has no terminal event claim.", {
        childRunId
      });
    }
  }
  return proofFiles;
}

function validateArtifactContents(
  plan: SwarmLivePlan,
  outcome: SwarmOutcome,
  events: readonly SwarmLiveEvent[],
  artifacts: readonly EvidenceArtifact[]
): void {
  const semanticIds = new Set<string>();
  let verifiedGlobalCount = 0;
  for (const artifact of artifacts) {
    const value = artifact.value;
    const category = artifact.relativePath.split("/")[0] ?? "";
    const semanticId = semanticArtifactId(category, value);
    if (semanticId) {
      const key = `${category}:${semanticId}`;
      if (semanticIds.has(key)) {
        throw new SwarmLiveStoreError("DUPLICATE_SEMANTIC_EVIDENCE", "Evidence contains duplicate semantic artifacts.", {
          category,
          semanticId
        });
      }
      semanticIds.add(key);
    }
    if (category === "cleanup") {
      requireText(value.cleanupId, artifact.relativePath);
      if (value.swarmId !== plan.swarmId || !["completed", "cleanup_pending", "failed"].includes(String(value.state))) {
        throw new SwarmLiveStoreError("INVALID_CLEANUP_EVIDENCE", "Cleanup evidence does not bind the canonical swarm.");
      }
      if (value.state === "cleanup_pending" && outcome.state !== "needs_review") {
        throw new SwarmLiveStoreError("CLEANUP_OUTCOME_MISMATCH", "Cleanup-pending evidence requires a needs-review parent outcome.");
      }
    } else if (category === "integration-reconstructions") {
      for (const field of ["reconstructionId", "failedCandidateId", "previousWorkspaceId", "replacementWorkspaceId"]) {
        requireText(value[field], artifact.relativePath);
      }
      if (
        value.swarmId !== plan.swarmId
        || value.baselineCommit !== plan.baselineCommit
        || !["completed", "failed"].includes(String(value.state))
        || (value.state === "completed" && value.expectedTreeHash !== value.actualTreeHash)
      ) {
        throw new SwarmLiveStoreError("INVALID_INTEGRATION_EVIDENCE", "Integration evidence does not bind the canonical plan.");
      }
    } else if (category === "integration-outcomes") {
      const decision = value.decision;
      const event = value.event;
      const payload = isRecord(event) ? event.payload : undefined;
      if (
        !isRecord(decision)
        || !isRecord(event)
        || !isRecord(payload)
        || decision.swarmId !== plan.swarmId
        || event.swarmId !== plan.swarmId
        || decision.candidateId !== payload.candidateId
      ) {
        throw new SwarmLiveStoreError("INVALID_INTEGRATION_EVIDENCE", "Integration outcome identities are inconsistent.");
      }
    } else if (category === "global-verification") {
      requireText(value.verificationId, artifact.relativePath);
      if (
        value.swarmId !== plan.swarmId
        || value.parentPolicyVersion !== plan.parentContract.policyVersion
        || value.baselineCommit !== plan.baselineCommit
        || !["pending", "passed", "failed", "unknown"].includes(String(value.commandState))
        || !["pending", "clean", "mutated", "unknown"].includes(String(value.mutationState))
      ) {
        throw new SwarmLiveStoreError("INVALID_GLOBAL_VERIFICATION_EVIDENCE", "Verifier evidence does not bind the canonical plan.");
      }
      const matchingEvents = events.filter((event) => (
        (event.type === "GLOBAL_VERIFIER_PASSED" || event.type === "GLOBAL_VERIFIER_FAILED")
        && event.payload.verificationId === value.verificationId
        && event.payload.integratedTreeHash === value.integratedTreeHash
      ));
      const expectedEventType = value.commandState === "passed"
        ? "GLOBAL_VERIFIER_PASSED"
        : "GLOBAL_VERIFIER_FAILED";
      if (matchingEvents.length !== 1 || matchingEvents[0]?.type !== expectedEventType) {
        throw new SwarmLiveStoreError(
          "INVALID_GLOBAL_VERIFICATION_EVIDENCE",
          "Verifier artifact does not match one canonical verifier event."
        );
      }
      if (value.commandState === "passed" && value.mutationState === "clean") verifiedGlobalCount += 1;
    }
  }
  const verifierEvents = events.filter((event) => (
    event.type === "GLOBAL_VERIFIER_PASSED" || event.type === "GLOBAL_VERIFIER_FAILED"
  ));
  const verifierArtifacts = artifacts.filter((artifact) => artifact.relativePath.startsWith("global-verification/"));
  if (verifierEvents.length !== verifierArtifacts.length) {
    throw new SwarmLiveStoreError(
      "INVALID_GLOBAL_VERIFICATION_EVIDENCE",
      "Canonical verifier events and persisted verifier artifacts must be one-to-one."
    );
  }
  if (outcome.state === "verified" && verifiedGlobalCount !== 1) {
    throw new SwarmLiveStoreError(
      "INVALID_GLOBAL_VERIFICATION_EVIDENCE",
      "A verified parent outcome requires exactly one passed, clean global verification artifact."
    );
  }
}

async function validateChildProof(
  runsRoot: string,
  plan: SwarmLivePlan,
  event: SwarmLiveEvent,
  completion: Record<string, unknown>,
  artifacts: readonly EvidenceArtifact[]
): Promise<Array<{ path: string; bytes: Buffer }>> {
  const childRunId = event.childRunId!;
  assertSwarmPathIdentifier(childRunId, "child run ID");
  const childRoot = await existingRealpath(join(runsRoot, childRunId), "MISSING_CHILD_RUN_PROOF");
  assertStrictlyContained(runsRoot, childRoot);
  const loop = await readExistingProofFile(childRoot, "loop-record.json");
  const ledger = await readExistingProofFile(childRoot, "ledger.jsonl");
  const integrity = await readExistingProofFile(childRoot, "receipt-integrity.json");
  let loopRecord: LoopRecord;
  try {
    loopRecord = JSON.parse(loop.bytes.toString("utf8")) as LoopRecord;
  } catch {
    throw new SwarmLiveStoreError("MALFORMED_CHILD_RUN_PROOF", "Child LoopRecord is malformed.", { childRunId });
  }
  const integritySummary = await verifyReceiptIntegrityFromFiles({
    runId: childRunId,
    runsRoot,
    loopRecordPath: loop.path,
    ledgerPath: ledger.path
  });
  if (integritySummary.state !== "verified") {
    throw new SwarmLiveStoreError("CHILD_RECEIPT_INTEGRITY_INVALID", "Child run receipt integrity is not verified.", {
      childRunId,
      integrityState: integritySummary.state
    });
  }
  const receipt = completion.receipt;
  const link = loopRecord.receiptScope?.swarmChild;
  const completionCleanup = completion.cleanup;
  const matchingCleanup = isRecord(completionCleanup)
    ? artifacts.find((artifact) => (
        artifact.relativePath.startsWith("cleanup/")
        && artifact.value.cleanupId === completionCleanup.cleanupId
      ))?.value
    : undefined;
  const matchingClosure = artifacts.find((artifact) => (
    artifact.relativePath.startsWith("process-closures/")
    && artifact.value.childRunId === childRunId
  ))?.value;
  if (
    !isRecord(receipt)
    || !link
    || completion.swarmId !== plan.swarmId
    || completion.childRunId !== childRunId
    || completion.agentId !== event.agentId
    || receipt.swarmId !== plan.swarmId
    || receipt.childRunId !== childRunId
    || receipt.agentId !== event.agentId
    || link.parentSwarmId !== plan.swarmId
    || link.agentId !== event.agentId
    || completion.attemptId !== link.attemptId
    || receipt.attemptId !== link.attemptId
    || !sameStringSet(completion.taskIds, link.taskIds)
    || !sameStringSet(receipt.taskIds, link.taskIds)
    || (event.taskId !== undefined && !link.taskIds.includes(event.taskId))
  ) {
    throw new SwarmLiveStoreError("CHILD_RECEIPT_LINK_MISMATCH", "Child proof lineage does not match terminal evidence.", {
      childRunId
    });
  }
  if (
    typeof completion.workspaceId !== "string"
    || !completion.workspaceId.trim()
    || completion.processCloseState !== "closed"
    || !["settled", "overspent", "released"].includes(String(completion.leaseState))
    || completion.evidencePersisted !== true
    || !["completed", "not_required"].includes(String(completion.workspaceCleanupState))
    || !isRecord(completionCleanup)
    || typeof completionCleanup.cleanupId !== "string"
    || !matchingCleanup
    || matchingCleanup.swarmId !== plan.swarmId
    || matchingCleanup.workspaceId !== completion.workspaceId
    || matchingCleanup.state !== completionCleanup.state
    || !matchingClosure
    || matchingClosure.swarmId !== plan.swarmId
    || matchingClosure.workspaceId !== completion.workspaceId
    || matchingClosure.agentId !== event.agentId
    || matchingClosure.state !== "closed"
  ) {
    throw new SwarmLiveStoreError(
      "INVALID_CHILD_COMPLETION_EVIDENCE",
      "Child completion is missing its exact process closure or cleanup binding.",
      { childRunId }
    );
  }
  const receiptIntegrity = receipt.integrity;
  if (
    !isRecord(receiptIntegrity)
    || receiptIntegrity.state !== "verified"
    || receiptIntegrity.keyId !== integritySummary.keyId
    || receiptIntegrity.loopRecordSha256 !== integritySummary.loopRecordSha256
    || receiptIntegrity.ledgerSha256 !== integritySummary.ledgerSha256
    || receiptIntegrity.ledgerHeadHash !== integritySummary.ledgerHeadHash
    || receipt.bindingSha256 !== receiptBindingSha256(receipt)
  ) {
    throw new SwarmLiveStoreError("CHILD_RECEIPT_INTEGRITY_INVALID", "Child completion receipt does not bind verified integrity.", {
      childRunId
    });
  }
  return [loop, ledger, integrity];
}

async function readExistingProofFile(
  childRoot: string,
  name: string
): Promise<{ path: string; bytes: Buffer }> {
  const lexicalPath = join(childRoot, name);
  const path = await existingRealpath(lexicalPath, "MISSING_CHILD_RUN_PROOF");
  assertContained(childRoot, path);
  if (resolve(lexicalPath) !== resolve(path)) {
    throw new SwarmLiveStoreError("EVIDENCE_PATH_ALIAS", "Child proof files cannot be path aliases.", { path: lexicalPath });
  }
  return { path, bytes: await readFile(path) };
}

function receiptBindingSha256(receipt: Record<string, unknown>): string {
  const integrity = receipt.integrity;
  if (!isRecord(integrity)) return "";
  return sha256(Buffer.from(JSON.stringify({
    receiptId: receipt.receiptId,
    swarmId: receipt.swarmId,
    childRunId: receipt.childRunId,
    agentId: receipt.agentId,
    attemptId: receipt.attemptId,
    taskIds: Array.isArray(receipt.taskIds) ? [...receipt.taskIds].sort() : [],
    integrity: {
      state: integrity.state,
      keyId: integrity.keyId,
      loopRecordSha256: integrity.loopRecordSha256,
      ledgerSha256: integrity.ledgerSha256,
      ledgerHeadHash: integrity.ledgerHeadHash
    }
  }), "utf8"));
}

async function captureSourceState(
  sources: ReadonlyArray<{ path: string; bytes: Buffer }>
): Promise<EvidenceSourceFile[]> {
  const seen = new Set<string>();
  const result: EvidenceSourceFile[] = [];
  for (const source of sources) {
    const canonical = await realpath(source.path);
    if (canonical !== source.path || seen.has(canonical)) {
      throw new SwarmLiveStoreError("EVIDENCE_PATH_ALIAS", "Evidence source paths must be unique and canonical.", {
        path: source.path
      });
    }
    seen.add(canonical);
    const metadata = await stat(canonical);
    result.push({ path: canonical, bytes: source.bytes, mtimeMs: metadata.mtimeMs, size: metadata.size });
  }
  return result;
}

async function assertSourcesUnchanged(sources: readonly EvidenceSourceFile[]): Promise<void> {
  for (const source of sources) {
    const canonical = await realpath(source.path).catch(() => "");
    const metadata = canonical ? await stat(canonical).catch(() => undefined) : undefined;
    const bytes = canonical ? await readFile(canonical).catch(() => undefined) : undefined;
    if (
      canonical !== source.path
      || !metadata
      || !bytes
      || metadata.mtimeMs !== source.mtimeMs
      || metadata.size !== source.size
      || !bytes.equals(source.bytes)
    ) {
      throw new SwarmLiveStoreError("EVIDENCE_SOURCE_CHANGED", "Evidence source changed before index publication.", {
        path: source.path
      });
    }
  }
}

function semanticArtifactId(category: string, value: Record<string, unknown>): string | undefined {
  const fieldsByCategory: Record<string, string> = {
    "child-completions": "childRunId",
    cleanup: "cleanupId",
    "integration-reconstructions": "reconstructionId",
    "integration-outcomes": "candidateId",
    "global-verification": "verificationId",
    candidates: "candidateId",
    decisions: "candidateId",
    "process-closures": "childRunId",
    "pre-cleanup": "childRunId",
    "workspace-failures": "failureId"
  };
  const field = fieldsByCategory[category];
  if (!field) return undefined;
  const direct = value[field];
  if (typeof direct === "string" && direct.trim()) return direct;
  if (category === "integration-outcomes" && isRecord(value.decision)) {
    const candidateId = value.decision.candidateId;
    if (typeof candidateId === "string" && candidateId.trim()) return candidateId;
  }
  return undefined;
}

function requireText(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SwarmLiveStoreError("MALFORMED_SWARM_EVIDENCE", "Evidence artifact is missing a required identity.", {
      path
    });
  }
}

function sameStringSet(left: unknown, right: readonly string[]): boolean {
  return Array.isArray(left)
    && left.length === right.length
    && [...left].every((value) => typeof value === "string")
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

async function writeIndexOnce(path: string, contents: string): Promise<void> {
  const desired = Buffer.from(contents, "utf8");
  try {
    const existing = await readFile(path);
    if (existing.equals(desired)) return;
    throw new SwarmLiveStoreError("EVIDENCE_INDEX_CONFLICT", "A different sealed evidence index already exists.");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }

  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx");
    await handle.writeFile(desired);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, path);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const existing = await readFile(path);
      if (!existing.equals(desired)) {
        throw new SwarmLiveStoreError("EVIDENCE_INDEX_CONFLICT", "A different sealed evidence index already exists.");
      }
    }
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

async function existingRealpath(path: string, code: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new SwarmLiveStoreError(code, "Required swarm evidence path does not exist.", { path });
    }
    throw error;
  }
}

function assertContained(parent: string, child: string): void {
  const rel = relative(parent, child);
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new SwarmLiveStoreError("STORE_PATH_ESCAPE", "Swarm evidence path escapes its canonical parent.");
}

function assertStrictlyContained(parent: string, child: string): void {
  const rel = relative(parent, child);
  if (rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)) return;
  throw new SwarmLiveStoreError("STORE_PATH_ESCAPE", "Child run proof path must be strictly contained by runs root.");
}

function normalizeRelative(path: string): string {
  return path.split(sep).join("/");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
