import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  SWARM_SCHEMA_VERSION,
  swarmConcretePathMatchesPattern,
  validateSwarmChildContract,
  validateSwarmConcretePath,
  validateSwarmRunRecord,
  type LoopRecord,
  type ReceiptIntegrityState,
  type ReceiptIntegritySummary,
  type SwarmCandidate,
  type SwarmPatchAdmission,
  type SwarmPatchAdmissionReasonCode,
  type SwarmRunRecord
} from "@martin/contracts";

import {
  verifyReceiptIntegrityFromFiles
} from "../persistence/integrity.js";
import type { SwarmWorkspaceRuntimeHandle } from "./workspaces.js";

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_DIAGNOSTIC_LENGTH = 512;

export interface SwarmCandidateGitCommand {
  readonly cwd: string;
  readonly args: readonly string[];
}

export interface SwarmCandidateGitResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export type SwarmCandidateGitRunner = (
  command: SwarmCandidateGitCommand
) => Promise<SwarmCandidateGitResult>;

export interface PersistedSwarmCandidateArtifact {
  readonly candidate: SwarmCandidate;
  readonly attemptId: string;
  readonly proposalId: string;
  readonly identitySha256: string;
  readonly candidateTreeHash: string;
  readonly patch: Buffer;
  readonly manifest: Buffer;
  readonly manifestSha256: string;
  readonly receiptIntegrity: ReceiptIntegritySummary;
}

export interface SwarmProcessClosureEvidence {
  readonly swarmId: string;
  readonly workspaceId: string;
  readonly childRunId: string;
  readonly agentId: string;
  readonly state: "closed";
  readonly completedAt: string;
}

/**
 * Implementations must durably and atomically reject duplicate candidate IDs.
 * The caller does not receive cleanup authority until both operations resolve.
 */
export interface SwarmCandidateArtifactWriter {
  loadProcessClosure(childRunId: string): Promise<SwarmProcessClosureEvidence | undefined>;
  persistCandidate(artifact: PersistedSwarmCandidateArtifact): Promise<void>;
  persistDecision(decision: SwarmPatchAdmission): Promise<void>;
}

export interface CaptureSwarmCandidateInput {
  readonly swarmRecord: SwarmRunRecord;
  readonly canonicalRoot: string;
  readonly swarmId: string;
  readonly candidateId: string;
  readonly admissionId: string;
  readonly attemptId: string;
  readonly proposalId: string;
  readonly childRunId: string;
  readonly agentId: string;
  readonly taskIds: readonly string[];
  readonly expectedBaselineCommit: string;
  readonly workspace: SwarmWorkspaceRuntimeHandle;
  readonly childState: "verified" | "stopped" | "needs_review" | "running" | "queued";
  readonly declaredPaths: readonly string[];
  readonly childAllowedPaths: readonly string[];
  readonly inheritedDeniedPaths: readonly string[];
  readonly taskWriteScope: readonly string[];
  readonly runsRoot: string;
  readonly loopRecordPath: string;
  readonly ledgerPath: string;
  readonly artifactWriter: SwarmCandidateArtifactWriter;
  readonly gitRunner?: SwarmCandidateGitRunner;
  readonly now?: () => string;
  /** Test-only race seam executed after validation and before staging. */
  readonly beforeStage?: () => void | Promise<void>;
}

export interface CaptureSwarmCandidateResult {
  readonly admission: SwarmPatchAdmission;
  readonly artifact?: PersistedSwarmCandidateArtifact;
  readonly cleanupAuthorized: boolean;
}

interface RejectionContext {
  readonly input: CaptureSwarmCandidateInput;
  readonly reasonCode: SwarmPatchAdmissionReasonCode;
  readonly receiptIntegrity: ReceiptIntegrityState;
  readonly changedPaths: readonly string[];
  readonly diagnostic?: string;
  readonly now: () => string;
}

interface GitInventory {
  readonly paths: string[];
  readonly statuses: ReadonlyMap<string, string>;
}

/**
 * Internal live-runtime bridge to the candidate module's single NUL-safe Git
 * inventory parser. Policy enforcement remains in captureAndAdmitSwarmCandidate.
 */
export async function inventorySwarmCandidatePaths(
  workspacePath: string,
  gitRunner: SwarmCandidateGitRunner = runGit
): Promise<string[]> {
  const workspaceRoot = await realpath(resolve(workspacePath));
  const inventory = await inventoryChangedDelta(gitRunner, workspaceRoot);
  const concrete = validateConcretePathSet(inventory.paths);
  if (!concrete.ok) throw new Error(concrete.error);
  return [...concrete.paths];
}

export async function captureAndAdmitSwarmCandidate(
  input: CaptureSwarmCandidateInput
): Promise<CaptureSwarmCandidateResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const gitRunner = input.gitRunner ?? runGit;
  let receiptIntegrity: ReceiptIntegrityState = "material_missing";
  let changedPaths: string[] = [];

  const reject = async (
    reasonCode: SwarmPatchAdmissionReasonCode,
    diagnostic?: string
  ): Promise<CaptureSwarmCandidateResult> => persistRejection({
    input,
    reasonCode,
    receiptIntegrity,
    changedPaths,
    ...(diagnostic ? { diagnostic: sanitizeDiagnostic(diagnostic, input.workspace.path) } : {}),
    now
  });

  if (!hasIdentityFields(input) || !hasValidWorkspaceBinding(input) || !hasValidParentAuthority(input)) {
    return reject("identity_mismatch", "Candidate identity does not match the manager-issued child workspace.");
  }
  if (input.workspace.record.baselineCommit !== input.expectedBaselineCommit) {
    return reject("stale_baseline", "Candidate workspace record does not match the immutable parent baseline.");
  }
  if (input.childState !== "verified") {
    return reject("child_not_terminal", "Child must be in the verified terminal state before candidate capture.");
  }
  const processClosure = await input.artifactWriter.loadProcessClosure(input.childRunId);
  if (!processClosureMatches(input, processClosure)) {
    return reject("process_active", "Child process tree must be closed before candidate capture.");
  }

  const receiptSummary = await verifyReceiptIntegrityFromFiles({
    runId: input.childRunId,
    runsRoot: input.runsRoot,
    loopRecordPath: input.loopRecordPath,
    ledgerPath: input.ledgerPath
  });
  receiptIntegrity = receiptSummary.state;
  if (receiptSummary.state !== "verified") {
    return reject("receipt_not_verified", receiptSummary.reason ?? "Child receipt integrity is not verified.");
  }

  const verifiedMaterial = await readVerifiedReceiptMaterial(input, receiptSummary);
  if (!verifiedMaterial || !receiptBindingMatches(input, verifiedMaterial)) {
    return reject("receipt_scope_mismatch", "Verified receipt is not bound to this swarm candidate identity.");
  }

  let workspaceRoot: string;
  try {
    workspaceRoot = await realpath(resolve(input.workspace.path));
    if (!await signedReceiptScopeMatches(verifiedMaterial.receiptScope, workspaceRoot)) {
      return reject("receipt_scope_mismatch", "Signed receipt scope does not match the manager-issued child workspace.");
    }
    await assertCanonicalStateUnchanged(
      gitRunner,
      input.canonicalRoot,
      workspaceRoot,
      input.expectedBaselineCommit,
      input.workspace.isolationMode ?? "worktree"
    );
    const workspaceHead = await gitScalar(gitRunner, workspaceRoot, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}"
    ]);
    if (
      input.workspace.record.baselineCommit !== input.expectedBaselineCommit
      || workspaceHead !== input.expectedBaselineCommit
    ) {
      return reject("stale_baseline", "Candidate workspace does not match the immutable parent baseline.");
    }
  } catch (error) {
    return reject("stale_baseline", diagnosticFromError(error));
  }

  let observedInventory: GitInventory;
  try {
    observedInventory = await inventoryChangedDelta(gitRunner, workspaceRoot);
    changedPaths = observedInventory.paths;
  } catch (error) {
    return reject("git_inventory_failed", diagnosticFromError(error));
  }
  if (changedPaths.length === 0) {
    return reject("empty_candidate", "Git reported no candidate mutation.");
  }

  const declared = validateConcretePathSet(input.declaredPaths);
  if (!declared.ok) {
    return reject("invalid_concrete_path", declared.error);
  }
  const observed = validateConcretePathSet(changedPaths);
  if (!observed.ok) {
    return reject("invalid_concrete_path", observed.error);
  }
  if (!sameStringSet(observed.paths, declared.paths)) {
    return reject("undeclared_path", "Declared paths do not exactly equal the Git-observed delta.");
  }

  for (const candidatePath of observed.paths) {
    if (input.inheritedDeniedPaths.some((pattern) => swarmConcretePathMatchesPattern(candidatePath, pattern))) {
      return reject("path_denied", `Denied path: ${candidatePath}`);
    }
    if (!input.childAllowedPaths.some((pattern) => swarmConcretePathMatchesPattern(candidatePath, pattern))) {
      return reject("path_not_allowed", `Path is outside the child allowance: ${candidatePath}`);
    }
    if (!input.taskWriteScope.some((pattern) => swarmConcretePathMatchesPattern(candidatePath, pattern))) {
      return reject("task_scope_violation", `Path is outside the task write scope: ${candidatePath}`);
    }
    try {
      await assertContainedConcretePath(workspaceRoot, candidatePath);
    } catch (error) {
      return reject("unsafe_path", diagnosticFromError(error));
    }
  }

  try {
    await readTrackedModesAndAssertSafe(gitRunner, workspaceRoot, observed.paths);
  } catch (error) {
    return reject("unsafe_path", diagnosticFromError(error));
  }

  const preStageFingerprint = await fingerprintCandidatePaths(workspaceRoot, observed.paths);
  await input.beforeStage?.();
  const postHookFingerprint = await fingerprintCandidatePaths(workspaceRoot, observed.paths);
  if (preStageFingerprint !== postHookFingerprint) {
    return reject(
      "candidate_changed_during_capture",
      "Candidate bytes changed after validation and before immutable capture."
    );
  }

  try {
    await gitRunner({ cwd: workspaceRoot, args: ["add", "-A", "--", "."] });
    const secondInventory = await inventoryChangedDelta(gitRunner, workspaceRoot);
    const stagedPaths = await inventoryStagedPaths(
      gitRunner,
      workspaceRoot,
      input.expectedBaselineCommit
    );
    if (!sameStringSet(observed.paths, secondInventory.paths) || !sameStringSet(observed.paths, stagedPaths)) {
      return reject(
        "candidate_changed_during_capture",
        "Candidate delta changed after policy validation and before immutable capture."
      );
    }
    const unstaged = await gitRunner({ cwd: workspaceRoot, args: ["diff", "--quiet", "--no-ext-diff", "--"] });
    if (unstaged.stdout.length !== 0 || unstaged.stderr.length !== 0) {
      return reject("candidate_changed_during_capture", "Candidate retained unstaged mutations after capture.");
    }
  } catch (error) {
    return reject("candidate_changed_during_capture", diagnosticFromError(error));
  }
  try {
    await readTrackedModesAndAssertSafe(gitRunner, workspaceRoot, observed.paths);
  } catch (error) {
    return reject("unsafe_path", diagnosticFromError(error));
  }

  let patch: Buffer;
  let manifest: Buffer;
  let candidateTreeHash: string;
  try {
    const captured = await captureImmutableGitArtifact(
      gitRunner,
      workspaceRoot,
      input.expectedBaselineCommit,
      observed.paths
    );
    patch = captured.patch;
    manifest = captured.manifest;
    candidateTreeHash = captured.candidateTreeHash;
  } catch (error) {
    return reject("git_inventory_failed", diagnosticFromError(error));
  }
  if (patch.length === 0) {
    return reject("empty_candidate", "Captured candidate patch is empty.");
  }
  const patchSha256 = sha256(patch);
  const manifestSha256 = sha256(manifest);
  const candidate: SwarmCandidate = Object.freeze({
    schemaVersion: SWARM_SCHEMA_VERSION,
    candidateId: input.candidateId,
    swarmId: input.swarmId,
    workspaceId: input.workspace.record.workspaceId,
    childRunId: input.childRunId,
    agentId: input.agentId,
    taskIds: Object.freeze([...input.taskIds]),
    baselineCommit: input.expectedBaselineCommit,
    patchSha256,
    changedPaths: Object.freeze([...observed.paths]),
    createdAt: now()
  });
  const artifact: PersistedSwarmCandidateArtifact = Object.freeze({
    candidate,
    attemptId: input.attemptId,
    proposalId: input.proposalId,
    identitySha256: hashCandidateArtifactIdentity({
      candidate,
      attemptId: input.attemptId,
      proposalId: input.proposalId,
      patchSha256,
      manifestSha256,
      candidateTreeHash,
      receipt: receiptSummary
    }),
    candidateTreeHash,
    patch,
    manifest,
    manifestSha256,
    receiptIntegrity: Object.freeze({ ...receiptSummary })
  });
  const admission = createAdmission(input, {
    state: "admitted",
    reasonCode: "admitted",
    receiptIntegrity: receiptSummary.state,
    changedPaths: observed.paths,
    decidedAt: now()
  });

  try {
    await input.artifactWriter.persistCandidate(artifact);
    await input.artifactWriter.persistDecision(admission);
  } catch (error) {
    const persistenceFailure = createAdmission(input, {
      state: "rejected",
      reasonCode: "artifact_persistence_failed",
      receiptIntegrity: receiptSummary.state,
      changedPaths: observed.paths,
      decidedAt: now(),
      diagnostic: sanitizeDiagnostic(diagnosticFromError(error), workspaceRoot)
    });
    try {
      await input.artifactWriter.persistDecision(persistenceFailure);
    } catch {
      // The caller receives no cleanup authority when durable evidence is unavailable.
    }
    return { admission: persistenceFailure, artifact, cleanupAuthorized: false };
  }

  return { admission, artifact, cleanupAuthorized: true };
}

async function persistRejection(context: RejectionContext): Promise<CaptureSwarmCandidateResult> {
  const decision = createAdmission(context.input, {
    state: "rejected",
    reasonCode: context.reasonCode,
    receiptIntegrity: context.receiptIntegrity,
    changedPaths: context.changedPaths,
    decidedAt: context.now(),
    ...(context.diagnostic ? { diagnostic: context.diagnostic } : {})
  });
  try {
    await context.input.artifactWriter.persistDecision(decision);
    return { admission: decision, cleanupAuthorized: true };
  } catch (error) {
    return {
      admission: createAdmission(context.input, {
        state: "rejected",
        reasonCode: "artifact_persistence_failed",
        receiptIntegrity: context.receiptIntegrity,
        changedPaths: context.changedPaths,
        decidedAt: context.now(),
        diagnostic: sanitizeDiagnostic(diagnosticFromError(error), context.input.workspace.path)
      }),
      cleanupAuthorized: false
    };
  }
}

function createAdmission(
  input: CaptureSwarmCandidateInput,
  decision: Pick<
    SwarmPatchAdmission,
    "state" | "reasonCode" | "receiptIntegrity" | "changedPaths" | "decidedAt"
  > & Pick<Partial<SwarmPatchAdmission>, "diagnostic">
): SwarmPatchAdmission {
  return Object.freeze({
    schemaVersion: SWARM_SCHEMA_VERSION,
    admissionId: input.admissionId,
    candidateId: input.candidateId,
    swarmId: input.swarmId,
    workspaceId: input.workspace.record.workspaceId,
    childRunId: input.childRunId,
    agentId: input.agentId,
    taskIds: Object.freeze([...input.taskIds]),
    baselineCommit: input.expectedBaselineCommit,
    changedPaths: Object.freeze([...decision.changedPaths]),
    state: decision.state,
    reasonCode: decision.reasonCode,
    receiptIntegrity: decision.receiptIntegrity,
    decidedAt: decision.decidedAt,
    ...(decision.diagnostic ? { diagnostic: decision.diagnostic } : {})
  });
}

function hasIdentityFields(input: CaptureSwarmCandidateInput): boolean {
  return [
    input.swarmId,
    input.candidateId,
    input.admissionId,
    input.attemptId,
    input.proposalId,
    input.childRunId,
    input.agentId,
    input.expectedBaselineCommit
  ].every((value) => value.trim().length > 0)
    && input.taskIds.length > 0
    && new Set(input.taskIds).size === input.taskIds.length;
}

function hasValidWorkspaceBinding(input: CaptureSwarmCandidateInput): boolean {
  const record = input.workspace.record;
  return record.kind === "child"
    && record.swarmId === input.swarmId
    && record.childRunId === input.childRunId
    && record.agentId === input.agentId
    && sameStringSet(record.taskIds, input.taskIds);
}

function processClosureMatches(
  input: CaptureSwarmCandidateInput,
  closure: SwarmProcessClosureEvidence | undefined
): closure is SwarmProcessClosureEvidence {
  return closure?.state === "closed"
    && closure.swarmId === input.swarmId
    && closure.workspaceId === input.workspace.record.workspaceId
    && closure.childRunId === input.childRunId
    && closure.agentId === input.agentId
    && Number.isFinite(Date.parse(closure.completedAt));
}

async function readVerifiedReceiptMaterial(
  input: CaptureSwarmCandidateInput,
  firstSummary: ReceiptIntegritySummary
): Promise<LoopRecord | undefined> {
  try {
    const rawLoopRecord = await readFile(input.loopRecordPath, "utf8");
    if (
      !firstSummary.loopRecordSha256
      || sha256(Buffer.from(rawLoopRecord, "utf8")) !== firstSummary.loopRecordSha256
    ) {
      return undefined;
    }
    const secondSummary = await verifyReceiptIntegrityFromFiles({
      runId: input.childRunId,
      runsRoot: input.runsRoot,
      loopRecordPath: input.loopRecordPath,
      ledgerPath: input.ledgerPath
    });
    if (
      secondSummary.state !== "verified"
      || secondSummary.loopRecordSha256 !== firstSummary.loopRecordSha256
      || secondSummary.ledgerSha256 !== firstSummary.ledgerSha256
      || secondSummary.ledgerHeadHash !== firstSummary.ledgerHeadHash
      || secondSummary.keyId !== firstSummary.keyId
    ) {
      return undefined;
    }
    return JSON.parse(rawLoopRecord) as LoopRecord;
  } catch {
    return undefined;
  }
}

async function signedReceiptScopeMatches(
  scope: LoopRecord["receiptScope"],
  workspaceRoot: string
): Promise<boolean> {
  const boundPaths = [scope?.repoRoot, scope?.workingDirectory]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (boundPaths.length === 0) return false;
  for (const boundPath of boundPaths) {
    try {
      if (!pathsEqual(await realpath(resolve(boundPath)), workspaceRoot)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function receiptBindingMatches(input: CaptureSwarmCandidateInput, loop: LoopRecord): boolean {
  let boundTaskIds: unknown;
  try {
    boundTaskIds = JSON.parse(loop.metadata["swarm.taskIds"] ?? "null");
  } catch {
    return false;
  }
  return loop.loopId === input.childRunId
    && loop.workspaceId === input.workspace.record.workspaceId
    && loop.status === "completed"
    && loop.lifecycleState === "completed"
    && loop.metadata["swarm.parentId"] === input.swarmId
    && loop.metadata["swarm.agentId"] === input.agentId
    && loop.metadata["swarm.attemptId"] === input.attemptId
    && loop.metadata["swarm.proposalId"] === input.proposalId
    && loop.metadata["swarm.baselineCommit"] === input.expectedBaselineCommit
    && Array.isArray(boundTaskIds)
    && boundTaskIds.every((value) => typeof value === "string")
    && sameStringSet(boundTaskIds as string[], input.taskIds);
}

function hasValidParentAuthority(input: CaptureSwarmCandidateInput): boolean {
  if (!validateSwarmRunRecord(input.swarmRecord).ok) return false;
  if (input.swarmRecord.swarmId !== input.swarmId || input.swarmRecord.outcome.state !== "running") return false;
  const agent = input.swarmRecord.agents.find((candidate) => candidate.agentId === input.agentId);
  if (
    !agent
    || agent.childRunId !== input.childRunId
    || !validateSwarmChildContract(input.swarmRecord.parentContract, agent.contract).ok
    || !sameStringSet(agent.contract.taskIds, input.taskIds)
    || !sameStringSet(agent.contract.scope.allowedPaths, input.childAllowedPaths)
  ) {
    return false;
  }
  const requiredDenials = [
    ...new Set([
      ...input.swarmRecord.parentContract.scope.deniedPaths,
      ...agent.contract.scope.deniedPaths
    ])
  ];
  if (!sameStringSet(requiredDenials, input.inheritedDeniedPaths)) return false;
  const tasks = input.taskIds.map((taskId) => input.swarmRecord.tasks.find((task) => task.taskId === taskId));
  if (tasks.some((task) => !task) || tasks.some((task) => task?.assignedAgentId !== input.agentId)) return false;
  const acceptedState = tasks.every((task) => task?.status === "accepted")
    && agent.status === input.childState;
  const livePreAdmissionState = tasks.every((task) => task?.status === "running")
    && agent.status === "running";
  if (!acceptedState && !livePreAdmissionState) return false;
  const taskScope = [...new Set(tasks.flatMap((task) => task?.writeScope ?? []))];
  return sameStringSet(taskScope, input.taskWriteScope);
}

async function assertCanonicalStateUnchanged(
  gitRunner: SwarmCandidateGitRunner,
  canonicalRootInput: string,
  workspaceRoot: string,
  expectedBaselineCommit: string,
  isolationMode: SwarmWorkspaceRuntimeHandle["isolationMode"]
): Promise<void> {
  const canonicalRoot = await realpath(resolve(canonicalRootInput));
  const [canonicalHead, canonicalStatus, canonicalCommon, workspaceCommon] = await Promise.all([
    gitScalar(gitRunner, canonicalRoot, ["rev-parse", "--verify", "HEAD^{commit}"]),
    gitRunner({
      cwd: canonicalRoot,
      args: ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]
    }),
    resolveGitCommonDirectory(gitRunner, canonicalRoot),
    resolveGitCommonDirectory(gitRunner, workspaceRoot)
  ]);
  if (canonicalHead !== expectedBaselineCommit || canonicalStatus.stdout.length !== 0) {
    throw new Error("Canonical repository changed during candidate admission.");
  }

  if (isolationMode === "worktree") {
    if (!pathsEqual(canonicalCommon, workspaceCommon)) {
      throw new Error("Canonical repository does not own the candidate worktree.");
    }
    return;
  }

  if (!isContained(workspaceRoot, workspaceCommon) || pathsEqual(canonicalCommon, workspaceCommon)) {
    throw new Error("Independent clone Git metadata is not self-contained.");
  }
  const origin = await gitScalar(gitRunner, workspaceRoot, ["config", "--get", "remote.origin.url"]);
  if (!isAbsolute(origin)) {
    throw new Error("Independent clone origin is not an absolute canonical repository path.");
  }
  const originReal = await realpath(resolve(origin));
  if (!pathsEqual(originReal, canonicalRoot)) {
    throw new Error("Independent clone origin does not match the canonical repository.");
  }
}

async function resolveGitCommonDirectory(
  gitRunner: SwarmCandidateGitRunner,
  cwd: string
): Promise<string> {
  const value = await gitScalar(gitRunner, cwd, ["rev-parse", "--git-common-dir"]);
  return realpath(resolve(cwd, value));
}

async function inventoryChangedDelta(
  gitRunner: SwarmCandidateGitRunner,
  cwd: string
): Promise<GitInventory> {
  const result = await gitRunner({
    cwd,
    args: ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]
  });
  return parsePorcelainStatus(result.stdout);
}

async function inventoryStagedPaths(
  gitRunner: SwarmCandidateGitRunner,
  cwd: string,
  baselineCommit: string
): Promise<string[]> {
  const result = await gitRunner({
    cwd,
    args: ["diff", "--cached", "--name-only", "-z", "--no-renames", baselineCommit, "--"]
  });
  return parseNulPaths(result.stdout);
}

function parsePorcelainStatus(output: Buffer): GitInventory {
  if (output.length === 0) return { paths: [], statuses: new Map() };
  const statuses = new Map<string, string>();
  const paths = splitNul(output).map((record) => {
    if (record.length < 4 || record[2] !== 0x20) {
      throw new Error("Malformed NUL-delimited Git status record.");
    }
    const path = decodeGitPath(record.subarray(3));
    statuses.set(path, record.subarray(0, 2).toString("ascii"));
    return path;
  }).sort(comparePaths);
  return { paths, statuses };
}

function parseNulPaths(output: Buffer): string[] {
  if (output.length === 0) return [];
  return splitNul(output).map(decodeGitPath).sort(comparePaths);
}

function splitNul(output: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    if (index > start) records.push(output.subarray(start, index));
    start = index + 1;
  }
  if (start !== output.length) {
    throw new Error("Git NUL-delimited output was truncated.");
  }
  return records;
}

function decodeGitPath(value: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

function validateConcretePathSet(
  paths: readonly string[]
): { ok: true; paths: string[] } | { ok: false; error: string } {
  const validated: string[] = [];
  for (const value of paths) {
    const result = validateSwarmConcretePath(value);
    if (!result.ok) return { ok: false, error: result.error };
    validated.push(result.value);
  }
  const unique = [...new Set(validated)].sort(comparePaths);
  if (unique.length !== validated.length) {
    return { ok: false, error: "Concrete path set contains duplicates." };
  }
  return { ok: true, paths: unique };
}

async function assertContainedConcretePath(workspaceRoot: string, concretePath: string): Promise<void> {
  let current = workspaceRoot;
  for (const segment of concretePath.split("/")) {
    current = resolve(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Candidate path traverses a symlink or junction: ${concretePath}`);
      }
      const resolvedSegment = await realpath(current);
      if (!isContained(workspaceRoot, resolvedSegment)) {
        throw new Error(`Candidate path escapes its workspace: ${concretePath}`);
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        const ancestor = await nearestExistingRealAncestor(dirname(current));
        if (!isContained(workspaceRoot, ancestor)) {
          throw new Error(`Candidate path ancestor escapes its workspace: ${concretePath}`);
        }
        return;
      }
      throw error;
    }
  }
}

async function nearestExistingRealAncestor(start: string): Promise<string> {
  let candidate = start;
  while (true) {
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) {
        throw new Error("Candidate path ancestor is a symlink or junction.");
      }
      return realpath(candidate);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function readTrackedModesAndAssertSafe(
  gitRunner: SwarmCandidateGitRunner,
  cwd: string,
  paths: readonly string[]
): Promise<ReadonlyMap<string, string>> {
  const result = await gitRunner({
    cwd,
    args: ["ls-files", "--stage", "-z", "--", ...paths]
  });
  const modes = new Map<string, string>();
  for (const record of splitNul(result.stdout)) {
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error("Malformed Git index mode record.");
    const header = record.subarray(0, tab).toString("ascii");
    const mode = header.split(" ", 1)[0];
    const path = decodeGitPath(record.subarray(tab + 1));
    if (mode) modes.set(path, mode);
    if (mode === "120000") throw new Error("Changed symbolic links are forbidden in swarm candidates.");
    if (mode === "160000") throw new Error("Changed gitlinks are forbidden in swarm candidates.");
  }
  return modes;
}

export function verifyPersistedSwarmCandidateArtifact(
  artifact: PersistedSwarmCandidateArtifact
): boolean {
  const patchSha256 = sha256(artifact.patch);
  const manifestSha256 = sha256(artifact.manifest);
  return artifact.candidate.schemaVersion === SWARM_SCHEMA_VERSION
    && artifact.candidate.candidateId.trim().length > 0
    && artifact.candidate.swarmId.trim().length > 0
    && artifact.candidate.childRunId.trim().length > 0
    && artifact.candidate.agentId.trim().length > 0
    && artifact.candidate.baselineCommit.trim().length > 0
    && artifact.attemptId.trim().length > 0
    && artifact.proposalId.trim().length > 0
    && /^[0-9a-f]{40,64}$/u.test(artifact.candidateTreeHash)
    && artifact.receiptIntegrity.state === "verified"
    && manifestMatchesCandidate(artifact.manifest, artifact.candidate.changedPaths)
    && patchSha256 === artifact.candidate.patchSha256
    && manifestSha256 === artifact.manifestSha256
    && artifact.identitySha256 === hashCandidateArtifactIdentity({
      candidate: artifact.candidate,
      attemptId: artifact.attemptId,
      proposalId: artifact.proposalId,
      patchSha256,
      manifestSha256,
      candidateTreeHash: artifact.candidateTreeHash,
      receipt: artifact.receiptIntegrity
    });
}

function manifestMatchesCandidate(manifest: Buffer, changedPaths: readonly string[]): boolean {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(manifest);
  } catch {
    return false;
  }
  const fields = decoded.split("\0");
  if (fields.at(-1) !== "") return false;
  fields.pop();
  if (fields.length !== changedPaths.length * 3) return false;
  const manifestPaths: string[] = [];
  for (let index = 0; index < fields.length; index += 3) {
    const status = fields[index];
    const mode = fields[index + 1];
    const path = fields[index + 2];
    if (!status || status.length !== 2 || !mode || !/^[0-7]{6}$/u.test(mode) || !path) return false;
    if (!validateSwarmConcretePath(path).ok) return false;
    manifestPaths.push(path);
  }
  return sameStringSet(manifestPaths, changedPaths);
}

function hashCandidateArtifactIdentity(
  input: {
    candidate: SwarmCandidate;
    attemptId: string;
    proposalId: string;
    patchSha256: string;
    manifestSha256: string;
    candidateTreeHash: string;
    receipt: ReceiptIntegritySummary;
  }
): string {
  return sha256(Buffer.from(JSON.stringify({
    swarmId: input.candidate.swarmId,
    candidateId: input.candidate.candidateId,
    attemptId: input.attemptId,
    proposalId: input.proposalId,
    workspaceId: input.candidate.workspaceId,
    childRunId: input.candidate.childRunId,
    agentId: input.candidate.agentId,
    taskIds: [...input.candidate.taskIds].sort(comparePaths),
    baselineCommit: input.candidate.baselineCommit,
    patchSha256: input.patchSha256,
    manifestSha256: input.manifestSha256,
    candidateTreeHash: input.candidateTreeHash,
    receipt: {
      keyId: input.receipt.keyId,
      loopRecordSha256: input.receipt.loopRecordSha256,
      ledgerSha256: input.receipt.ledgerSha256,
      ledgerHeadHash: input.receipt.ledgerHeadHash
    }
  }), "utf8"));
}

async function captureImmutableGitArtifact(
  gitRunner: SwarmCandidateGitRunner,
  cwd: string,
  baselineCommit: string,
  expectedPaths: readonly string[]
): Promise<{ patch: Buffer; manifest: Buffer; candidateTreeHash: string }> {
  const candidateTreeHash = await gitScalar(gitRunner, cwd, ["write-tree"]);
  if (!/^[0-9a-f]{40,64}$/u.test(candidateTreeHash)) {
    throw new Error("Git returned an invalid immutable candidate tree identity.");
  }
  const raw = await gitRunner({
    cwd,
    args: ["diff", "--raw", "-z", "--no-abbrev", "--no-renames", baselineCommit, candidateTreeHash, "--"]
  });
  const parsed = parseRawDiffManifest(raw.stdout);
  if (!sameStringSet(parsed.paths, expectedPaths)) {
    throw new Error("Captured patch paths do not match the validated candidate delta.");
  }
  const patch = await gitRunner({
    cwd,
    args: [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-renames",
      baselineCommit,
      candidateTreeHash,
      "--"
    ]
  });
  const stableTreeHash = await gitScalar(gitRunner, cwd, ["write-tree"]);
  if (stableTreeHash !== candidateTreeHash) {
    throw new Error("Candidate index changed while its immutable tree evidence was captured.");
  }
  return { patch: Buffer.from(patch.stdout), manifest: parsed.manifest, candidateTreeHash };
}

function parseRawDiffManifest(output: Buffer): { paths: string[]; manifest: Buffer } {
  const records = splitNul(output);
  if (records.length % 2 !== 0) throw new Error("Malformed Git raw diff output.");
  const paths: string[] = [];
  const fields: string[] = [];
  for (let index = 0; index < records.length; index += 2) {
    const header = records[index]?.toString("ascii") ?? "";
    const pathRecord = records[index + 1];
    const match = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])$/u.exec(header);
    if (!match?.[1] || !match[2] || !match[3] || !pathRecord) {
      throw new Error("Malformed Git raw diff record.");
    }
    const path = decodeGitPath(pathRecord);
    const concrete = validateSwarmConcretePath(path);
    if (!concrete.ok) throw new Error(concrete.error);
    const mode = match[2] === "000000" ? match[1] : match[2];
    if (mode === "120000") throw new Error("Changed symbolic links are forbidden in swarm candidates.");
    if (mode === "160000") throw new Error("Changed gitlinks are forbidden in swarm candidates.");
    paths.push(concrete.value);
    fields.push(`${match[3]} `, mode, concrete.value, "");
  }
  const unique = [...new Set(paths)];
  if (unique.length !== paths.length) throw new Error("Git raw diff contains duplicate paths.");
  return {
    paths: [...paths].sort(comparePaths),
    manifest: Buffer.from(fields.join("\0"), "utf8")
  };
}

async function fingerprintCandidatePaths(root: string, paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path, "utf8");
    hash.update("\0", "utf8");
    const absolute = resolve(root, ...path.split("/"));
    try {
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        hash.update("symlink", "utf8");
      } else if (stat.isFile()) {
        hash.update("file\0", "utf8");
        hash.update(await readFile(absolute));
      } else if (stat.isDirectory()) {
        hash.update("directory", "utf8");
      } else {
        hash.update("other", "utf8");
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      hash.update("missing", "utf8");
    }
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort(comparePaths);
  const normalizedRight = [...right].sort(comparePaths);
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function comparePaths(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

async function gitScalar(
  gitRunner: SwarmCandidateGitRunner,
  cwd: string,
  args: readonly string[]
): Promise<string> {
  const result = await gitRunner({ cwd, args });
  return result.stdout.toString("utf8").trim();
}

function runGit(command: SwarmCandidateGitCommand): Promise<SwarmCandidateGitResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      [...command.args],
      {
        cwd: command.cwd,
        encoding: null,
        windowsHide: true,
        maxBuffer: MAX_GIT_OUTPUT_BYTES
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(Object.assign(error, { stderr }));
          return;
        }
        resolvePromise({
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
          stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr)
        });
      }
    );
  });
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeDiagnostic(value: string, workspacePath: string): string {
  const compact = value
    .replaceAll(workspacePath, "<workspace>")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return compact.slice(0, MAX_DIAGNOSTIC_LENGTH);
}

function diagnosticFromError(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as Error & { stderr?: unknown }).stderr;
    if (Buffer.isBuffer(stderr) && stderr.length > 0) return stderr.toString("utf8");
    if (typeof stderr === "string" && stderr.length > 0) return stderr;
    return error.message;
  }
  return String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
