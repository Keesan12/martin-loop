import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  SWARM_SCHEMA_VERSION,
  validateSwarmRunRecord,
  type SwarmGlobalVerification,
  type SwarmPatchAdmission,
  type SwarmRunRecord,
  type SwarmVerifierSubprocessResult,
  type VerificationStep
} from "@martin/contracts";

import {
  verifyPersistedSwarmCandidateArtifact,
  type PersistedSwarmCandidateArtifact
} from "./candidates.js";
import type {
  SwarmWorkspaceManager,
  SwarmWorkspaceRuntimeHandle
} from "./workspaces.js";

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface SwarmVerificationGitCommand {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly stdin?: Buffer;
}

export interface SwarmVerificationGitResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export type SwarmVerificationGitRunner = (
  command: SwarmVerificationGitCommand
) => Promise<SwarmVerificationGitResult>;

export interface SwarmVerifierBinding {
  readonly swarmId: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly parentPolicyVersion: string;
  readonly baselineCommit: string;
  readonly integratedTreeHash: string;
  readonly commands: readonly string[];
}

export interface SwarmVerifierExecutionRequest {
  readonly swarmId: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly parentPolicyVersion: string;
  readonly baselineCommit: string;
  readonly integratedTreeHash: string;
  readonly commands: readonly VerificationStep[];
  readonly signal: AbortSignal;
}

export interface SwarmVerifierExecutionResult {
  readonly passed: boolean;
  readonly processCloseState: "closed" | "not_required" | "failed";
  readonly binding: SwarmVerifierBinding;
  readonly subprocessResults: readonly SwarmVerifierSubprocessResult[];
}

export interface SwarmVerifierExecutor {
  execute(request: SwarmVerifierExecutionRequest): Promise<SwarmVerifierExecutionResult>;
}

export interface SwarmGlobalVerificationEvidenceStore {
  loadPersistedCandidate(candidateId: string): Promise<PersistedSwarmCandidateArtifact | undefined>;
  loadPersistedAdmission(candidateId: string): Promise<SwarmPatchAdmission | undefined>;
  persistGlobalVerification(evidence: SwarmGlobalVerification): Promise<void>;
}

export interface VerifyIntegratedSwarmResultInput {
  readonly swarmRecord: SwarmRunRecord;
  readonly workspaceManager: SwarmWorkspaceManager;
  readonly verifierWorkspaceId: string;
  readonly admittedCandidateIds: readonly string[];
  readonly integratedTreeHash: string;
  readonly evidenceStore: SwarmGlobalVerificationEvidenceStore;
  readonly executor: SwarmVerifierExecutor | ((request: SwarmVerifierExecutionRequest) => Promise<SwarmVerifierExecutionResult>);
  readonly signal: AbortSignal;
  readonly gitRunner?: SwarmVerificationGitRunner;
  readonly now?: () => string;
  readonly createVerificationId?: () => string;
}

export interface VerifyIntegratedSwarmResult {
  readonly passed: boolean;
  readonly workspace: SwarmWorkspaceRuntimeHandle;
  readonly evidence: SwarmGlobalVerification;
  readonly replayedCandidateIds: readonly string[];
  readonly reconstructedTreeHash: string;
  readonly cleanupAuthorized: boolean;
  readonly processCloseState: "closed" | "not_required" | "failed";
  readonly diagnostic?: string;
}

export async function verifyIntegratedSwarmResult(
  input: VerifyIntegratedSwarmResultInput
): Promise<VerifyIntegratedSwarmResult> {
  const gitRunner = input.gitRunner ?? runGit;
  const now = input.now ?? (() => new Date().toISOString());
  const verificationId = (input.createVerificationId ?? (() => `verification-${randomUUID()}`))();
  const startedAt = now();
  assertParentAuthority(input);
  const workspace = await input.workspaceManager.createWorkspace({
    kind: "verifier",
    workspaceId: input.verifierWorkspaceId
  });

  const commands = input.swarmRecord.parentContract.globalVerifierStack.map((step) => step.command);
  const replayedCandidateIds: string[] = [];
  let reconstructedTreeHash = "";
  let commandState: SwarmGlobalVerification["commandState"] = "unknown";
  let mutationState: SwarmGlobalVerification["mutationState"] = "unknown";
  let subprocessResults: readonly SwarmVerifierSubprocessResult[] = [];
  let processCloseState: SwarmVerifierExecutionResult["processCloseState"] = "not_required";
  let diagnostic: string | undefined;

  try {
    assertVerifierWorkspace(input, workspace);
    reconstructedTreeHash = await assertBaselineWorkspace(
      gitRunner,
      workspace.path,
      input.workspaceManager.baselineCommit
    );
    const seen = new Set<string>();
    for (const candidateId of input.admittedCandidateIds) {
      if (candidateId.trim().length === 0 || seen.has(candidateId)) {
        throw new Error("Global verification requires a unique recorded candidate sequence.");
      }
      seen.add(candidateId);
      const artifact = await input.evidenceStore.loadPersistedCandidate(candidateId);
      const admission = await input.evidenceStore.loadPersistedAdmission(candidateId);
      if (!artifact || !admission) {
        throw new Error(`Persisted admitted candidate evidence is missing: ${candidateId}`);
      }
      const snapshot = snapshotArtifact(artifact);
      assertReplayEvidence(input, snapshot, admission, reconstructedTreeHash);
      await applyPatch(gitRunner, workspace.path, snapshot.patch);
      const postTreeHash = await writeTree(gitRunner, workspace.path);
      if (postTreeHash !== admission.postIntegrationTreeHash) {
        throw new Error(`Candidate replay tree mismatch: ${candidateId}`);
      }
      await assertWorktreeMatchesIndex(gitRunner, workspace.path);
      replayedCandidateIds.push(candidateId);
      reconstructedTreeHash = postTreeHash;
    }
    if (reconstructedTreeHash !== input.integratedTreeHash) {
      throw new Error("Reconstructed verifier tree does not match the recorded integration tree.");
    }

    const preCommandTree = await writeTree(gitRunner, workspace.path);
    if (preCommandTree !== input.integratedTreeHash) {
      throw new Error("Verifier index changed before global commands started.");
    }
    await assertWorktreeMatchesIndex(gitRunner, workspace.path);
    const preUntracked = await readUntracked(gitRunner, workspace.path);
    if (preUntracked.length !== 0) {
      throw new Error("Verifier workspace is not clean before global commands started.");
    }

    let execution: SwarmVerifierExecutionResult | undefined;
    try {
      execution = await executeVerifier(input.executor, {
        swarmId: input.swarmRecord.swarmId,
        workspaceId: workspace.record.workspaceId,
        cwd: workspace.path,
        parentPolicyVersion: input.swarmRecord.parentContract.policyVersion,
        baselineCommit: input.workspaceManager.baselineCommit,
        integratedTreeHash: input.integratedTreeHash,
        commands: input.swarmRecord.parentContract.globalVerifierStack.map((step) => ({ ...step })),
        signal: input.signal
      });
      subprocessResults = execution.subprocessResults.map((step) => ({ ...step }));
      processCloseState = execution.processCloseState;
      commandState = verifierExecutionPassed(input, workspace, execution) ? "passed" : "failed";
    } catch (error) {
      commandState = "unknown";
      diagnostic = sanitizeDiagnostic(error);
    }

    mutationState = await verifierWorkspaceUnchanged(
      gitRunner,
      workspace.path,
      preCommandTree,
      preUntracked
    ) ? "clean" : "mutated";
  } catch (error) {
    diagnostic = sanitizeDiagnostic(error);
  }

  const evidence: SwarmGlobalVerification = Object.freeze({
    schemaVersion: SWARM_SCHEMA_VERSION,
    verificationId,
    swarmId: input.swarmRecord.swarmId,
    workspaceId: workspace.record.workspaceId,
    parentPolicyVersion: input.swarmRecord.parentContract.policyVersion,
    baselineCommit: input.workspaceManager.baselineCommit,
    integratedTreeHash: input.integratedTreeHash,
    commands: Object.freeze([...commands]),
    commandState,
    mutationState,
    startedAt,
    completedAt: now(),
    subprocessResults: Object.freeze(subprocessResults.map((step) => Object.freeze({ ...step })))
  });

  let cleanupAuthorized = true;
  try {
    await input.evidenceStore.persistGlobalVerification(evidence);
  } catch (error) {
    cleanupAuthorized = false;
    diagnostic ??= sanitizeDiagnostic(error);
  }
  const passed = cleanupAuthorized
    && replayedCandidateIds.length === input.admittedCandidateIds.length
    && reconstructedTreeHash === input.integratedTreeHash
    && evidence.commandState === "passed"
    && evidence.mutationState === "clean"
    && processCloseState === "closed"
    && !input.signal.aborted;
  return Object.freeze({
    passed,
    workspace,
    evidence,
    replayedCandidateIds: Object.freeze([...replayedCandidateIds]),
    reconstructedTreeHash,
    cleanupAuthorized,
    processCloseState,
    ...(diagnostic ? { diagnostic } : {})
  });
}

function assertParentAuthority(input: VerifyIntegratedSwarmResultInput): void {
  if (
    !validateSwarmRunRecord(input.swarmRecord).ok
    || input.swarmRecord.outcome.state !== "running"
    || input.swarmRecord.swarmId.trim().length === 0
    || input.verifierWorkspaceId.trim().length === 0
    || !/^[0-9a-f]{40,64}$/u.test(input.integratedTreeHash)
    || (
      input.swarmRecord.tasks.some((task) => task.required && task.mutationMode === "write" && task.status === "accepted")
      && input.admittedCandidateIds.length === 0
    )
  ) {
    throw new Error("Global verification requires current parent and integration authority.");
  }
}

function assertVerifierWorkspace(
  input: VerifyIntegratedSwarmResultInput,
  workspace: SwarmWorkspaceRuntimeHandle
): void {
  if (
    workspace.record.kind !== "verifier"
    || workspace.record.workspaceId !== input.verifierWorkspaceId
    || workspace.record.swarmId !== input.swarmRecord.swarmId
    || workspace.record.baselineCommit !== input.workspaceManager.baselineCommit
    || workspace.record.state !== "active"
  ) {
    throw new Error("Workspace manager returned a verifier handle outside parent authority.");
  }
}

function assertReplayEvidence(
  input: VerifyIntegratedSwarmResultInput,
  artifact: PersistedSwarmCandidateArtifact,
  admission: SwarmPatchAdmission,
  expectedPreTreeHash: string
): void {
  const candidate = artifact.candidate;
  if (
    !verifyPersistedSwarmCandidateArtifact(artifact)
    || candidate.swarmId !== input.swarmRecord.swarmId
    || candidate.baselineCommit !== input.workspaceManager.baselineCommit
    || admission.schemaVersion !== SWARM_SCHEMA_VERSION
    || admission.state !== "admitted"
    || admission.reasonCode !== "admitted"
    || admission.receiptIntegrity !== "verified"
    || admission.candidateId !== candidate.candidateId
    || admission.swarmId !== candidate.swarmId
    || admission.workspaceId !== candidate.workspaceId
    || admission.childRunId !== candidate.childRunId
    || admission.agentId !== candidate.agentId
    || admission.baselineCommit !== candidate.baselineCommit
    || !sameStrings(admission.taskIds, candidate.taskIds)
    || !sameStrings(admission.changedPaths, candidate.changedPaths)
    || admission.preIntegrationTreeHash !== expectedPreTreeHash
    || !admission.postIntegrationTreeHash
  ) {
    throw new Error(`Persisted candidate admission is invalid: ${candidate.candidateId}`);
  }
}

function verifierExecutionPassed(
  input: VerifyIntegratedSwarmResultInput,
  workspace: SwarmWorkspaceRuntimeHandle,
  execution: SwarmVerifierExecutionResult
): boolean {
  const expectedCommands = input.swarmRecord.parentContract.globalVerifierStack.map((step) => step.command);
  const binding = execution.binding;
  return execution.passed
    && execution.processCloseState === "closed"
    && !input.signal.aborted
    && binding.swarmId === input.swarmRecord.swarmId
    && binding.workspaceId === workspace.record.workspaceId
    && binding.cwd === workspace.path
    && binding.parentPolicyVersion === input.swarmRecord.parentContract.policyVersion
    && binding.baselineCommit === input.workspaceManager.baselineCommit
    && binding.integratedTreeHash === input.integratedTreeHash
    && sameStrings(binding.commands, expectedCommands)
    && execution.subprocessResults.length === expectedCommands.length
    && execution.subprocessResults.every((step, index) => (
      step.command === expectedCommands[index]
      && step.launched
      && step.completed
      && !step.timedOut
      && step.exitCode === 0
      && typeof step.completedAt === "string"
      && step.completedAt.length > 0
    ));
}

async function executeVerifier(
  executor: VerifyIntegratedSwarmResultInput["executor"],
  request: SwarmVerifierExecutionRequest
): Promise<SwarmVerifierExecutionResult> {
  return typeof executor === "function" ? executor(request) : executor.execute(request);
}

async function assertBaselineWorkspace(
  gitRunner: SwarmVerificationGitRunner,
  cwd: string,
  baselineCommit: string
): Promise<string> {
  const expected = await gitScalar(gitRunner, cwd, ["rev-parse", `${baselineCommit}^{tree}`]);
  const actual = await writeTree(gitRunner, cwd);
  if (actual !== expected) throw new Error("Verifier workspace does not start at the immutable baseline tree.");
  await assertWorktreeMatchesIndex(gitRunner, cwd);
  if ((await readUntracked(gitRunner, cwd)).length !== 0) {
    throw new Error("Verifier baseline workspace contains untracked files.");
  }
  return actual;
}

async function applyPatch(
  gitRunner: SwarmVerificationGitRunner,
  cwd: string,
  patch: Buffer
): Promise<void> {
  await gitRunner({ cwd, args: ["-c", "core.autocrlf=false", "apply", "--check", "--index", "-"], stdin: patch });
  await gitRunner({ cwd, args: ["-c", "core.autocrlf=false", "apply", "--index", "-"], stdin: patch });
}

async function verifierWorkspaceUnchanged(
  gitRunner: SwarmVerificationGitRunner,
  cwd: string,
  expectedTreeHash: string,
  expectedUntracked: readonly string[]
): Promise<boolean> {
  try {
    return await writeTree(gitRunner, cwd) === expectedTreeHash
      && await worktreeMatchesIndex(gitRunner, cwd)
      && sameStrings(await readUntracked(gitRunner, cwd), expectedUntracked);
  } catch {
    return false;
  }
}

async function assertWorktreeMatchesIndex(
  gitRunner: SwarmVerificationGitRunner,
  cwd: string
): Promise<void> {
  if (!await worktreeMatchesIndex(gitRunner, cwd)) {
    throw new Error("Verifier tracked worktree content does not match its index.");
  }
}

async function worktreeMatchesIndex(
  gitRunner: SwarmVerificationGitRunner,
  cwd: string
): Promise<boolean> {
  try {
    await gitRunner({ cwd, args: ["diff-files", "--quiet", "--"] });
    return true;
  } catch {
    return false;
  }
}

async function readUntracked(
  gitRunner: SwarmVerificationGitRunner,
  cwd: string
): Promise<string[]> {
  const result = await gitRunner({
    cwd,
    args: ["ls-files", "--others", "--exclude-standard", "-z"]
  });
  const fields = result.stdout.toString("utf8").split("\0");
  if (fields.at(-1) !== "") throw new Error("Git returned a malformed untracked inventory.");
  fields.pop();
  return fields;
}

async function writeTree(gitRunner: SwarmVerificationGitRunner, cwd: string): Promise<string> {
  return gitScalar(gitRunner, cwd, ["write-tree"]);
}

async function gitScalar(
  gitRunner: SwarmVerificationGitRunner,
  cwd: string,
  args: readonly string[]
): Promise<string> {
  const result = await gitRunner({ cwd, args });
  return result.stdout.toString("utf8").trim();
}

function snapshotArtifact(artifact: PersistedSwarmCandidateArtifact): PersistedSwarmCandidateArtifact {
  return {
    candidate: {
      ...artifact.candidate,
      taskIds: [...artifact.candidate.taskIds],
      changedPaths: [...artifact.candidate.changedPaths]
    },
    attemptId: artifact.attemptId,
    proposalId: artifact.proposalId,
    identitySha256: artifact.identitySha256,
    candidateTreeHash: artifact.candidateTreeHash,
    patch: Buffer.from(artifact.patch),
    manifest: Buffer.from(artifact.manifest),
    manifestSha256: artifact.manifestSha256,
    receiptIntegrity: { ...artifact.receiptIntegrity }
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sanitizeDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\0]+/gu, " ").trim().slice(0, 512) || "Global verification failed.";
}

function runGit(command: SwarmVerificationGitCommand): Promise<SwarmVerificationGitResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      "git",
      [...command.args],
      {
        cwd: command.cwd,
        encoding: "buffer",
        windowsHide: true,
        maxBuffer: MAX_GIT_OUTPUT_BYTES
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolvePromise({
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
          stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr)
        });
      }
    );
    if (command.stdin) child.stdin?.end(command.stdin);
  });
}
