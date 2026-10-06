import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import {
  SWARM_SCHEMA_VERSION,
  swarmConcretePathMatchesPattern,
  validateSwarmChildContract,
  validateSwarmRunRecord,
  type SwarmConflictRecord,
  type SwarmCleanupRecord,
  type SwarmEvent,
  type SwarmPatchAdmission,
  type SwarmRunRecord,
  type SwarmTaskNode
} from "@martin/contracts";

import {
  verifyPersistedSwarmCandidateArtifact,
  type PersistedSwarmCandidateArtifact
} from "./candidates.js";
import { validateSwarmTaskGraph } from "./scheduler.js";
import type {
  SwarmWorkspaceManager,
  SwarmWorkspaceRuntimeHandle
} from "./workspaces.js";

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_DIAGNOSTIC_LENGTH = 512;

export interface SwarmIntegrationGitCommand {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly stdin?: Buffer;
}

export interface SwarmIntegrationGitResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export type SwarmIntegrationGitRunner = (
  command: SwarmIntegrationGitCommand
) => Promise<SwarmIntegrationGitResult>;

export interface SwarmIntegrationCandidate {
  readonly candidateId: string;
}

export interface SwarmIntegrationReconstruction {
  readonly reconstructionId: string;
  readonly swarmId: string;
  readonly failedCandidateId: string;
  readonly previousWorkspaceId: string;
  readonly replacementWorkspaceId: string;
  readonly baselineCommit: string;
  readonly replayedCandidateIds: readonly string[];
  readonly expectedTreeHash: string;
  readonly actualTreeHash: string;
  readonly state: "completed" | "failed";
  readonly recordedAt: string;
  readonly cleanup?: SwarmCleanupRecord;
  readonly diagnostic?: string;
}

export interface SwarmIntegrationEvidenceBundle {
  readonly decision: SwarmPatchAdmission;
  readonly event: SwarmEvent;
  readonly conflict?: SwarmConflictRecord;
  readonly reconstruction?: SwarmIntegrationReconstruction;
}

export interface SwarmIntegrationEvidenceStore {
  loadPersistedCandidate(candidateId: string): Promise<PersistedSwarmCandidateArtifact | undefined>;
  loadPersistedAdmission(candidateId: string): Promise<SwarmPatchAdmission | undefined>;
  /** Atomically claims the swarm/candidate pair; identity is retained as evidence, not as replay-key entropy. */
  claimCandidateIntegration(input: {
    swarmId: string;
    candidateId: string;
    identitySha256: string;
  }): Promise<"claimed" | "already_claimed">;
  persistOutcome(bundle: SwarmIntegrationEvidenceBundle): Promise<void>;
  persistReconstruction(record: SwarmIntegrationReconstruction): Promise<void>;
}

export interface IntegrateSwarmCandidatesInput {
  readonly swarmRecord: SwarmRunRecord;
  readonly workspaceManager: SwarmWorkspaceManager;
  readonly integrationWorkspaceId: string;
  readonly candidates: readonly SwarmIntegrationCandidate[];
  readonly evidenceStore: SwarmIntegrationEvidenceStore;
  readonly conflictPolicy?: "stop" | "continue";
  readonly gitRunner?: SwarmIntegrationGitRunner;
  readonly now?: () => string;
  readonly createId?: (prefix: string) => string;
  readonly createReconstructionWorkspaceId?: (sequence: number) => string;
  /** Internal lifecycle seam used to retain exact manager authority on exceptional paths. */
  readonly onWorkspaceCreated?: (workspace: SwarmWorkspaceRuntimeHandle) => void;
}

export interface SwarmIntegrationResult {
  readonly completed: boolean;
  readonly workspace: SwarmWorkspaceRuntimeHandle;
  readonly finalTreeHash: string;
  readonly admittedCandidateIds: readonly string[];
  readonly decisions: readonly SwarmPatchAdmission[];
  readonly events: readonly SwarmEvent[];
  readonly conflicts: readonly SwarmConflictRecord[];
  readonly reconstructions: readonly SwarmIntegrationReconstruction[];
  readonly cleanupAuthorized: boolean;
}

interface AdmittedReplay {
  artifact: PersistedSwarmCandidateArtifact;
  treeHash: string;
}

interface SwarmIntegrationCandidateWithArtifact {
  readonly artifact: PersistedSwarmCandidateArtifact;
}

export async function integrateSwarmCandidates(
  input: IntegrateSwarmCandidatesInput
): Promise<SwarmIntegrationResult> {
  const gitRunner = input.gitRunner ?? runGit;
  const now = input.now ?? (() => new Date().toISOString());
  const createId = input.createId ?? ((prefix: string) => `${prefix}-${randomUUID()}`);
  const createReconstructionWorkspaceId = input.createReconstructionWorkspaceId
    ?? ((sequence: number) => `integration-recovery-${String(sequence)}`);
  const conflictPolicy = input.conflictPolicy ?? "stop";
  assertIntegrationAuthority(input);
  assertCandidateReferencesUnique(input.candidates);
  const persistedCandidates: SwarmIntegrationCandidateWithArtifact[] = [];
  for (const reference of input.candidates) {
    const stored = await input.evidenceStore.loadPersistedCandidate(reference.candidateId);
    if (!stored || stored.candidate.candidateId !== reference.candidateId) {
      throw new Error(`Persisted swarm candidate is missing: ${reference.candidateId}`);
    }
    persistedCandidates.push({ artifact: snapshotCandidateArtifact(stored) });
  }
  const ordered = orderCandidates(
    input.swarmRecord.tasks,
    persistedCandidates
  );
  assertCandidateAliasesUnique(ordered);

  let workspace = await input.workspaceManager.createWorkspace({
    kind: "integration",
    workspaceId: input.integrationWorkspaceId
  });
  input.onWorkspaceCreated?.(workspace);
  assertManagerIntegrationWorkspace(input, workspace, input.integrationWorkspaceId);
  let expectedTreeHash = await baselineTreeHash(gitRunner, workspace.path, input.workspaceManager.baselineCommit);
  const initialTree = await writeTree(gitRunner, workspace.path);
  if (initialTree !== expectedTreeHash) {
    throw new Error("Integration workspace index does not match the immutable baseline tree.");
  }
  await assertNoUnstagedOrUntracked(gitRunner, workspace.path);

  const admitted: AdmittedReplay[] = [];
  const decisions: SwarmPatchAdmission[] = [];
  const events: SwarmEvent[] = [];
  const conflicts: SwarmConflictRecord[] = [];
  const reconstructions: SwarmIntegrationReconstruction[] = [];
  let cleanupAuthorized = true;

  for (const entry of ordered) {
    const artifact = entry.artifact;
    const persistedAdmission = await input.evidenceStore.loadPersistedAdmission(
      artifact.candidate.candidateId
    );
    const preconditionFailure = validateIntegrationPrecondition(
      input,
      artifact,
      persistedAdmission,
      expectedTreeHash
    );
    if (preconditionFailure) {
      const bundle = createRejectedBundle(input, artifact, {
        reasonCode: preconditionFailure.reasonCode,
        diagnostic: preconditionFailure.diagnostic,
        preTreeHash: expectedTreeHash,
        now: now(),
        createId
      });
      cleanupAuthorized = await persistBundle(input.evidenceStore, bundle);
      decisions.push(bundle.decision);
      events.push(bundle.event);
      if (!cleanupAuthorized || conflictPolicy === "stop") break;
      continue;
    }

    const claim = await input.evidenceStore.claimCandidateIntegration({
      swarmId: input.swarmRecord.swarmId,
      candidateId: artifact.candidate.candidateId,
      identitySha256: artifact.identitySha256
    });
    if (claim === "already_claimed") {
      const bundle = createRejectedBundle(input, artifact, {
        reasonCode: "integration_precondition_failed",
        diagnostic: "Candidate integration claim already exists.",
        preTreeHash: expectedTreeHash,
        now: now(),
        createId
      });
      cleanupAuthorized = await persistBundle(input.evidenceStore, bundle);
      decisions.push(bundle.decision);
      events.push(bundle.event);
      break;
    }

    const actualPreTree = await writeTree(gitRunner, workspace.path);
    if (actualPreTree !== expectedTreeHash) {
      const bundle = createRejectedBundle(input, artifact, {
        reasonCode: "integration_precondition_failed",
        diagnostic: "Integration tree changed before candidate application.",
        preTreeHash: actualPreTree,
        now: now(),
        createId
      });
      cleanupAuthorized = await persistBundle(input.evidenceStore, bundle);
      decisions.push(bundle.decision);
      events.push(bundle.event);
      break;
    }
    await assertNoUnstagedOrUntracked(gitRunner, workspace.path);

    try {
      await gitRunner({
        cwd: workspace.path,
        args: ["-c", "core.autocrlf=false", "apply", "--check", "--index", "-"],
        stdin: artifact.patch
      });
    } catch (error) {
      const postFailureTree = await writeTree(gitRunner, workspace.path);
      if (postFailureTree !== expectedTreeHash) {
        throw new Error("Git apply --check mutated the integration index.");
      }
      const conflict = createConflict(input, artifact, expectedTreeHash, error, now(), createId);
      const bundle = createRejectedBundle(input, artifact, {
        reasonCode: "integration_conflict",
        diagnostic: conflict.diagnostic ?? "Candidate conflicts with the integrated tree.",
        preTreeHash: expectedTreeHash,
        now: now(),
        createId,
        conflict
      });
      cleanupAuthorized = await persistBundle(input.evidenceStore, bundle);
      decisions.push(bundle.decision);
      events.push(bundle.event);
      conflicts.push(conflict);
      if (!cleanupAuthorized || conflictPolicy === "stop") break;
      continue;
    }

    try {
      await gitRunner({
        cwd: workspace.path,
        args: ["-c", "core.autocrlf=false", "apply", "--index", "-"],
        stdin: artifact.patch
      });
    } catch (error) {
      const failedBundle = createRejectedBundle(input, artifact, {
        reasonCode: "integration_apply_failed",
        diagnostic: sanitizeDiagnostic(error),
        preTreeHash: expectedTreeHash,
        now: now(),
        createId
      });
      const failurePersisted = await persistBundle(input.evidenceStore, failedBundle);
      decisions.push(failedBundle.decision);
      events.push(failedBundle.event);
      if (!failurePersisted) {
        cleanupAuthorized = false;
        break;
      }
      const reconstructed = await reconstructIntegration({
        input,
        gitRunner,
        currentWorkspace: workspace,
        admitted,
        failedArtifact: artifact,
        expectedTreeHash,
        sequence: reconstructions.length + 1,
        now,
        createId,
        createReconstructionWorkspaceId
      });
      workspace = reconstructed.workspace;
      reconstructions.push(reconstructed.record);
      try {
        await input.evidenceStore.persistReconstruction(reconstructed.record);
        cleanupAuthorized = true;
      } catch {
        cleanupAuthorized = false;
      }
      if (!reconstructed.ok || !cleanupAuthorized) break;
      continue;
    }

    await assertNoUnstagedOrUntracked(gitRunner, workspace.path);
    const postTreeHash = await writeTree(gitRunner, workspace.path);
    const admittedBundle = createAdmittedBundle(
      input,
      artifact,
      expectedTreeHash,
      postTreeHash,
      now(),
      createId
    );
    try {
      await input.evidenceStore.persistOutcome(admittedBundle);
    } catch (error) {
      const reconstructed = await reconstructIntegration({
        input,
        gitRunner,
        currentWorkspace: workspace,
        admitted,
        failedArtifact: artifact,
        expectedTreeHash,
        sequence: reconstructions.length + 1,
        now,
        createId,
        createReconstructionWorkspaceId,
        preserveFailedWorkspace: true,
        diagnostic: sanitizeDiagnostic(error)
      });
      workspace = reconstructed.workspace;
      reconstructions.push(reconstructed.record);
      const failureBundle = createRejectedBundle(input, artifact, {
        reasonCode: "artifact_persistence_failed",
        diagnostic: sanitizeDiagnostic(error),
        preTreeHash: expectedTreeHash,
        now: now(),
        createId,
        reconstruction: reconstructed.record
      });
      cleanupAuthorized = await persistBundle(input.evidenceStore, failureBundle);
      cleanupAuthorized = false;
      decisions.push(failureBundle.decision);
      events.push(failureBundle.event);
      break;
    }

    admitted.push({ artifact, treeHash: postTreeHash });
    expectedTreeHash = postTreeHash;
    decisions.push(admittedBundle.decision);
    events.push(admittedBundle.event);
  }

  const allAdmitted = admitted.length === ordered.length;
  return Object.freeze({
    completed: allAdmitted,
    workspace,
    finalTreeHash: expectedTreeHash,
    admittedCandidateIds: Object.freeze(admitted.map(({ artifact }) => artifact.candidate.candidateId)),
    decisions: Object.freeze(decisions),
    events: Object.freeze(events),
    conflicts: Object.freeze(conflicts),
    reconstructions: Object.freeze(reconstructions),
    cleanupAuthorized
  });
}

function assertIntegrationAuthority(input: IntegrateSwarmCandidatesInput): void {
  const graph = validateSwarmTaskGraph(input.swarmRecord.tasks);
  if (!graph.ok) throw new Error("Swarm task graph is invalid for deterministic integration.");
  if (
    !validateSwarmRunRecord(input.swarmRecord).ok
    || input.swarmRecord.outcome.state !== "running"
    || input.integrationWorkspaceId.trim().length === 0
  ) {
    throw new Error("Integration requires current parent authority and the manager baseline.");
  }
}

function assertManagerIntegrationWorkspace(
  input: IntegrateSwarmCandidatesInput,
  workspace: SwarmWorkspaceRuntimeHandle,
  expectedWorkspaceId: string
): void {
  if (
    workspace.record.kind !== "integration"
    || workspace.record.workspaceId !== expectedWorkspaceId
    || workspace.record.swarmId !== input.swarmRecord.swarmId
    || workspace.record.baselineCommit !== input.workspaceManager.baselineCommit
    || workspace.record.state !== "active"
  ) {
    throw new Error("Workspace manager returned an integration handle outside current parent authority.");
  }
}

function validateIntegrationPrecondition(
  input: IntegrateSwarmCandidatesInput,
  artifact: PersistedSwarmCandidateArtifact,
  persisted: SwarmPatchAdmission | undefined,
  expectedTreeHash: string
): { reasonCode: "patch_hash_mismatch" | "integration_precondition_failed"; diagnostic: string } | undefined {
  if (!verifyPersistedSwarmCandidateArtifact(artifact)) {
    return { reasonCode: "patch_hash_mismatch", diagnostic: "Persisted candidate bytes or identity hash do not match." };
  }
  const candidate = artifact.candidate;
  if (
    candidate.swarmId !== input.swarmRecord.swarmId
    || candidate.baselineCommit !== input.workspaceManager.baselineCommit
    || !persisted
    || persisted.schemaVersion !== SWARM_SCHEMA_VERSION
    || persisted.admissionId.trim().length === 0
    || persisted.state !== "admitted"
    || persisted.reasonCode !== "admitted"
    || persisted.receiptIntegrity !== "verified"
    || !admissionMatchesCandidate(persisted, artifact)
    || (persisted.preIntegrationTreeHash !== undefined && persisted.preIntegrationTreeHash !== expectedTreeHash)
  ) {
    return {
      reasonCode: "integration_precondition_failed",
      diagnostic: "Candidate identity, baseline, or persisted admission does not match integration authority."
    };
  }
  const agent = input.swarmRecord.agents.find((entry) => entry.agentId === candidate.agentId);
  if (
    !agent
    || agent.childRunId !== candidate.childRunId
    || agent.status !== "verified"
    || !validateSwarmChildContract(input.swarmRecord.parentContract, agent.contract).ok
    || candidate.taskIds.length !== 1
    || !sameStrings(candidate.taskIds, agent.contract.taskIds)
  ) {
    return { reasonCode: "integration_precondition_failed", diagnostic: "Candidate agent/task binding is stale." };
  }
  const task = input.swarmRecord.tasks.find((entry) => entry.taskId === candidate.taskIds[0]);
  if (
    !task
    || task.status !== "accepted"
    || task.assignedAgentId !== candidate.agentId
    || candidate.changedPaths.some((path) => (
      input.swarmRecord.parentContract.scope.deniedPaths.some((pattern) => swarmConcretePathMatchesPattern(path, pattern))
      || agent.contract.scope.deniedPaths.some((pattern) => swarmConcretePathMatchesPattern(path, pattern))
      || !input.swarmRecord.parentContract.scope.allowedPaths.some((pattern) => swarmConcretePathMatchesPattern(path, pattern))
      || !agent.contract.scope.allowedPaths.some((pattern) => swarmConcretePathMatchesPattern(path, pattern))
      || !task.writeScope.some((pattern) => swarmConcretePathMatchesPattern(path, pattern))
    ))
  ) {
    return { reasonCode: "integration_precondition_failed", diagnostic: "Candidate task or scope authority is stale." };
  }
  return undefined;
}

function admissionMatchesCandidate(
  admission: SwarmPatchAdmission,
  artifact: PersistedSwarmCandidateArtifact
): boolean {
  const candidate = artifact.candidate;
  return admission.candidateId === candidate.candidateId
    && admission.swarmId === candidate.swarmId
    && admission.workspaceId === candidate.workspaceId
    && admission.childRunId === candidate.childRunId
    && admission.agentId === candidate.agentId
    && admission.baselineCommit === candidate.baselineCommit
    && sameStrings(admission.taskIds, candidate.taskIds)
    && sameStrings(admission.changedPaths, candidate.changedPaths);
}

function orderCandidates(
  tasks: readonly SwarmTaskNode[],
  candidates: readonly SwarmIntegrationCandidateWithArtifact[]
): SwarmIntegrationCandidateWithArtifact[] {
  const order = stableTopologicalOrder(tasks);
  const rank = new Map(order.map((taskId, index) => [taskId, index]));
  return [...candidates].sort((left, right) => {
    const leftRanks = left.artifact.candidate.taskIds.map((taskId) => rank.get(taskId) ?? Number.MAX_SAFE_INTEGER);
    const rightRanks = right.artifact.candidate.taskIds.map((taskId) => rank.get(taskId) ?? Number.MAX_SAFE_INTEGER);
    const byDependency = Math.max(...leftRanks) - Math.max(...rightRanks);
    if (byDependency !== 0) return byDependency;
    const byTasks = [...left.artifact.candidate.taskIds].sort().join("\0")
      .localeCompare([...right.artifact.candidate.taskIds].sort().join("\0"));
    if (byTasks !== 0) return byTasks;
    return left.artifact.candidate.candidateId.localeCompare(right.artifact.candidate.candidateId);
  });
}

function stableTopologicalOrder(tasks: readonly SwarmTaskNode[]): string[] {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const indegree = new Map(tasks.map((task) => [task.taskId, task.dependsOn.length]));
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      const list = dependents.get(dependency) ?? [];
      list.push(task.taskId);
      dependents.set(dependency, list);
    }
  }
  const ready = tasks.filter((task) => indegree.get(task.taskId) === 0)
    .map((task) => task.taskId)
    .sort();
  const ordered: string[] = [];
  while (ready.length > 0) {
    const taskId = ready.shift();
    if (!taskId || !byId.has(taskId)) continue;
    ordered.push(taskId);
    for (const dependent of (dependents.get(taskId) ?? []).sort()) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (ordered.length !== tasks.length) throw new Error("Swarm task graph contains a cycle.");
  return ordered;
}

function assertCandidateReferencesUnique(candidates: readonly SwarmIntegrationCandidate[]): void {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.candidateId.trim().length === 0 || ids.has(candidate.candidateId)) {
      throw new Error("Duplicate or empty swarm candidate references are forbidden.");
    }
    ids.add(candidate.candidateId);
  }
}

function assertCandidateAliasesUnique(candidates: readonly SwarmIntegrationCandidateWithArtifact[]): void {
  const candidateIds = new Set<string>();
  const identities = new Set<string>();
  for (const { artifact } of candidates) {
    if (
      candidateIds.has(artifact.candidate.candidateId)
      || identities.has(artifact.identitySha256)
    ) {
      throw new Error("Duplicate or aliased swarm candidates are forbidden.");
    }
    candidateIds.add(artifact.candidate.candidateId);
    identities.add(artifact.identitySha256);
  }
}

async function reconstructIntegration(context: {
  input: IntegrateSwarmCandidatesInput;
  gitRunner: SwarmIntegrationGitRunner;
  currentWorkspace: SwarmWorkspaceRuntimeHandle;
  admitted: readonly AdmittedReplay[];
  failedArtifact: PersistedSwarmCandidateArtifact;
  expectedTreeHash: string;
  sequence: number;
  now: () => string;
  createId: (prefix: string) => string;
  createReconstructionWorkspaceId: (sequence: number) => string;
  preserveFailedWorkspace?: boolean;
  diagnostic?: string;
}): Promise<{ ok: boolean; workspace: SwarmWorkspaceRuntimeHandle; record: SwarmIntegrationReconstruction }> {
  let cleanup: SwarmCleanupRecord | undefined;
  if (!context.preserveFailedWorkspace) {
    cleanup = await context.input.workspaceManager.removeWorkspace(context.currentWorkspace, {
      evidencePersisted: true,
      processTreeClosed: true,
      force: true
    });
    if (cleanup.state !== "completed") {
      const actualTreeHash = await writeTree(context.gitRunner, context.currentWorkspace.path);
      const record: SwarmIntegrationReconstruction = Object.freeze({
        reconstructionId: context.createId("reconstruction"),
        swarmId: context.input.swarmRecord.swarmId,
        failedCandidateId: context.failedArtifact.candidate.candidateId,
        previousWorkspaceId: context.currentWorkspace.record.workspaceId,
        replacementWorkspaceId: context.currentWorkspace.record.workspaceId,
        baselineCommit: context.input.workspaceManager.baselineCommit,
        replayedCandidateIds: Object.freeze(context.admitted.map(({ artifact }) => artifact.candidate.candidateId)),
        expectedTreeHash: context.expectedTreeHash,
        actualTreeHash,
        state: "failed",
        recordedAt: context.now(),
        cleanup,
        diagnostic: "Integration workspace cleanup did not complete; reconstruction was not started."
      });
      return { ok: false, workspace: context.currentWorkspace, record };
    }
  }
  const replacementWorkspaceId = context.createReconstructionWorkspaceId(context.sequence);
  const workspace = await context.input.workspaceManager.createWorkspace({
    kind: "integration",
    workspaceId: replacementWorkspaceId
  });
  context.input.onWorkspaceCreated?.(workspace);
  assertManagerIntegrationWorkspace(context.input, workspace, replacementWorkspaceId);
  let actualTreeHash = await writeTree(context.gitRunner, workspace.path);
  let diagnostic = context.diagnostic;
  let ok = true;
  for (const replay of context.admitted) {
    try {
      await applyPatch(context.gitRunner, workspace.path, replay.artifact.patch);
      actualTreeHash = await writeTree(context.gitRunner, workspace.path);
      if (actualTreeHash !== replay.treeHash) {
        throw new Error("Replayed candidate tree hash does not match persisted integration evidence.");
      }
    } catch (error) {
      ok = false;
      diagnostic = sanitizeDiagnostic(error);
      break;
    }
  }
  if (actualTreeHash !== context.expectedTreeHash) ok = false;
  const record: SwarmIntegrationReconstruction = Object.freeze({
    reconstructionId: context.createId("reconstruction"),
    swarmId: context.input.swarmRecord.swarmId,
    failedCandidateId: context.failedArtifact.candidate.candidateId,
    previousWorkspaceId: context.currentWorkspace.record.workspaceId,
    replacementWorkspaceId: workspace.record.workspaceId,
    baselineCommit: context.input.workspaceManager.baselineCommit,
    replayedCandidateIds: Object.freeze(context.admitted.map(({ artifact }) => artifact.candidate.candidateId)),
    expectedTreeHash: context.expectedTreeHash,
    actualTreeHash,
    state: ok ? "completed" : "failed",
    recordedAt: context.now(),
    ...(cleanup ? { cleanup } : {}),
    ...(diagnostic ? { diagnostic } : {})
  });
  return { ok, workspace, record };
}

function snapshotCandidateArtifact(
  artifact: PersistedSwarmCandidateArtifact
): PersistedSwarmCandidateArtifact {
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

async function applyPatch(
  gitRunner: SwarmIntegrationGitRunner,
  cwd: string,
  patch: Buffer
): Promise<void> {
  await gitRunner({ cwd, args: ["-c", "core.autocrlf=false", "apply", "--check", "--index", "-"], stdin: patch });
  await gitRunner({ cwd, args: ["-c", "core.autocrlf=false", "apply", "--index", "-"], stdin: patch });
}

function createAdmittedBundle(
  input: IntegrateSwarmCandidatesInput,
  artifact: PersistedSwarmCandidateArtifact,
  preTreeHash: string,
  postTreeHash: string,
  decidedAt: string,
  createId: (prefix: string) => string
): SwarmIntegrationEvidenceBundle {
  return {
    decision: createDecision(input, artifact, {
      state: "admitted",
      reasonCode: "admitted",
      preTreeHash,
      postTreeHash,
      decidedAt,
      createId
    }),
    event: createEvent(input, artifact, "CHILD_PATCH_ADMITTED", decidedAt, {
      candidateId: artifact.candidate.candidateId,
      patchSha256: artifact.candidate.patchSha256,
      preIntegrationTreeHash: preTreeHash,
      postIntegrationTreeHash: postTreeHash
    })
  };
}

function createRejectedBundle(
  input: IntegrateSwarmCandidatesInput,
  artifact: PersistedSwarmCandidateArtifact,
  context: {
    reasonCode: SwarmPatchAdmission["reasonCode"];
    diagnostic: string;
    preTreeHash: string;
    now: string;
    createId: (prefix: string) => string;
    conflict?: SwarmConflictRecord;
    reconstruction?: SwarmIntegrationReconstruction;
  }
): SwarmIntegrationEvidenceBundle {
  return {
    decision: createDecision(input, artifact, {
      state: "rejected",
      reasonCode: context.reasonCode,
      preTreeHash: context.preTreeHash,
      decidedAt: context.now,
      diagnostic: context.diagnostic,
      createId: context.createId
    }),
    event: createEvent(
      input,
      artifact,
      context.conflict ? "INTEGRATION_CONFLICT" : "CHILD_PATCH_REJECTED",
      context.now,
      {
        candidateId: artifact.candidate.candidateId,
        reasonCode: context.reasonCode,
        preIntegrationTreeHash: context.preTreeHash,
        diagnostic: context.diagnostic
      }
    ),
    ...(context.conflict ? { conflict: context.conflict } : {}),
    ...(context.reconstruction ? { reconstruction: context.reconstruction } : {})
  };
}

function createDecision(
  input: IntegrateSwarmCandidatesInput,
  artifact: PersistedSwarmCandidateArtifact,
  context: {
    state: "admitted" | "rejected";
    reasonCode: SwarmPatchAdmission["reasonCode"];
    preTreeHash: string;
    postTreeHash?: string;
    decidedAt: string;
    diagnostic?: string;
    createId: (prefix: string) => string;
  }
): SwarmPatchAdmission {
  const candidate = artifact.candidate;
  return Object.freeze({
    schemaVersion: SWARM_SCHEMA_VERSION,
    admissionId: context.createId("integration-admission"),
    candidateId: candidate.candidateId,
    swarmId: input.swarmRecord.swarmId,
    workspaceId: candidate.workspaceId,
    childRunId: candidate.childRunId,
    agentId: candidate.agentId,
    taskIds: Object.freeze([...candidate.taskIds]),
    baselineCommit: candidate.baselineCommit,
    changedPaths: Object.freeze([...candidate.changedPaths]),
    state: context.state,
    reasonCode: context.reasonCode,
    receiptIntegrity: artifact.receiptIntegrity.state,
    decidedAt: context.decidedAt,
    preIntegrationTreeHash: context.preTreeHash,
    ...(context.postTreeHash ? { postIntegrationTreeHash: context.postTreeHash } : {}),
    ...(context.diagnostic ? { diagnostic: context.diagnostic } : {})
  });
}

function createEvent(
  input: IntegrateSwarmCandidatesInput,
  artifact: PersistedSwarmCandidateArtifact,
  type: SwarmEvent["type"],
  timestamp: string,
  payload: Record<string, unknown>
): SwarmEvent {
  return Object.freeze({
    type,
    swarmId: input.swarmRecord.swarmId,
    timestamp,
    parentPolicyVersion: input.swarmRecord.parentContract.policyVersion,
    taskId: artifact.candidate.taskIds[0],
    agentId: artifact.candidate.agentId,
    childRunId: artifact.candidate.childRunId,
    payload: Object.freeze(payload)
  });
}

function createConflict(
  input: IntegrateSwarmCandidatesInput,
  artifact: PersistedSwarmCandidateArtifact,
  preTreeHash: string,
  error: unknown,
  recordedAt: string,
  createId: (prefix: string) => string
): SwarmConflictRecord {
  return Object.freeze({
    conflictId: createId("conflict"),
    taskIds: [...artifact.candidate.taskIds],
    paths: [...artifact.candidate.changedPaths],
    state: "blocking",
    schemaVersion: SWARM_SCHEMA_VERSION,
    candidateId: artifact.candidate.candidateId,
    childRunId: artifact.candidate.childRunId,
    agentId: artifact.candidate.agentId,
    preIntegrationTreeHash: preTreeHash,
    recordedAt,
    diagnostic: sanitizeDiagnostic(error)
  });
}

async function persistBundle(
  store: SwarmIntegrationEvidenceStore,
  bundle: SwarmIntegrationEvidenceBundle
): Promise<boolean> {
  try {
    await store.persistOutcome(bundle);
    return true;
  } catch {
    return false;
  }
}

async function baselineTreeHash(
  gitRunner: SwarmIntegrationGitRunner,
  cwd: string,
  baselineCommit: string
): Promise<string> {
  return gitScalar(gitRunner, cwd, ["rev-parse", `${baselineCommit}^{tree}`]);
}

async function writeTree(gitRunner: SwarmIntegrationGitRunner, cwd: string): Promise<string> {
  return gitScalar(gitRunner, cwd, ["write-tree"]);
}

async function assertNoUnstagedOrUntracked(
  gitRunner: SwarmIntegrationGitRunner,
  cwd: string
): Promise<void> {
  await gitRunner({ cwd, args: ["diff", "--quiet", "--no-ext-diff", "--"] });
  const untracked = await gitRunner({
    cwd,
    args: ["ls-files", "--others", "--exclude-standard", "-z"]
  });
  if (untracked.stdout.length !== 0) {
    throw new Error("Integration workspace contains untracked mutation.");
  }
}

async function gitScalar(
  gitRunner: SwarmIntegrationGitRunner,
  cwd: string,
  args: readonly string[]
): Promise<string> {
  const result = await gitRunner({ cwd, args });
  return result.stdout.toString("utf8").trim();
}

function runGit(command: SwarmIntegrationGitCommand): Promise<SwarmIntegrationGitResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
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
    if (command.stdin) child.stdin?.end(command.stdin);
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function sanitizeDiagnostic(error: unknown): string {
  const raw = error instanceof Error
    ? ((error as Error & { stderr?: Buffer | string }).stderr?.toString() || error.message)
    : String(error);
  return raw.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim()
    .slice(0, MAX_DIAGNOSTIC_LENGTH);
}

export function hashSwarmIntegrationPatch(patch: Buffer): string {
  return createHash("sha256").update(patch).digest("hex");
}
