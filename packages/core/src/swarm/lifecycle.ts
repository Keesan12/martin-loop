import {
  SWARM_SCHEMA_VERSION,
  type SwarmBudgetLedger,
  type SwarmCleanupRecord,
  type SwarmEvent,
  type SwarmRunRecord
} from "@martin/contracts";

import { releaseSwarmBudgetLease } from "./scheduler.js";
import type { SwarmWorkspaceManager, SwarmWorkspaceRuntimeHandle } from "./workspaces.js";

export interface SwarmChildProcessClosure {
  readonly state: "closed" | "failed";
  readonly completedAt: string;
  readonly errorCode?: string;
}

export interface SwarmLifecycleTerminalEvidence {
  readonly schemaVersion: typeof SWARM_SCHEMA_VERSION;
  readonly swarmId: string;
  readonly agentId: string;
  readonly childRunId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly leaseId: string;
  readonly processCloseState: "closed" | "failed";
  readonly leaseState: "settled" | "overspent" | "released" | "failed";
  readonly reason: "cancelled" | "child_terminal_failure";
  readonly recordedAt: string;
  readonly errorCode?: string;
}

export interface SwarmLifecyclePreCleanupEvidence {
  readonly terminal: SwarmLifecycleTerminalEvidence;
  readonly childEvent: SwarmEvent;
  readonly budgetLedger: SwarmBudgetLedger;
  readonly cleanupIntent: {
    readonly workspaceId: string;
    readonly workspaceKind: "child";
    readonly force: true;
  };
}

export interface SwarmChildLifecycleEvidenceWriter {
  persistBeforeCleanup(evidence: SwarmLifecyclePreCleanupEvidence): Promise<void>;
}

export interface SwarmLifecycleEvidenceStore {
  persistCleanupEvidence(cleanup: SwarmCleanupRecord): Promise<void>;
  persistTerminalRecord(record: SwarmRunRecord): Promise<void>;
}

export interface ActiveSwarmChildRegistration {
  readonly swarmId: string;
  readonly agentId: string;
  readonly childRunId: string;
  readonly taskId: string;
  readonly leaseId: string;
  readonly workspace: SwarmWorkspaceRuntimeHandle;
  readonly abortController: AbortController;
  readonly processClosed: Promise<SwarmChildProcessClosure>;
  readonly evidenceWriter: SwarmChildLifecycleEvidenceWriter;
}

export interface SwarmLifecycleControllerInput {
  readonly record: SwarmRunRecord;
  readonly workspaceManager: SwarmWorkspaceManager;
  readonly evidenceStore: SwarmLifecycleEvidenceStore;
  readonly now?: () => string;
  readonly createCleanupId?: () => string;
}

export interface SwarmLifecycleCancellationResult {
  readonly acceptingWork: false;
  readonly state: "stopped" | "needs_review";
  readonly record: SwarmRunRecord;
  readonly terminalEvidence: readonly SwarmLifecycleTerminalEvidence[];
  readonly cleanupEvidence: readonly SwarmCleanupRecord[];
  readonly unresolvedChildRunIds: readonly string[];
}

export interface SwarmLifecycleController {
  readonly swarmId: string;
  assertAcceptingWork(): void;
  registerActiveChild(registration: ActiveSwarmChildRegistration): void;
  cancel(reason: "cancelled" | "child_terminal_failure"): Promise<SwarmLifecycleCancellationResult>;
}

interface ControllerState {
  acceptingWork: boolean;
  record: SwarmRunRecord;
  registrations: Map<string, ActiveSwarmChildRegistration>;
  cancellation?: Promise<SwarmLifecycleCancellationResult>;
  input: SwarmLifecycleControllerInput;
}

const controllerAuthority = new WeakMap<SwarmLifecycleController, ControllerState>();

/** Internal parent capability. This module is intentionally absent from Core root exports. */
export function createSwarmLifecycleController(input: SwarmLifecycleControllerInput): SwarmLifecycleController {
  const state: ControllerState = {
    acceptingWork: true,
    record: cloneRecord(input.record),
    registrations: new Map(),
    input
  };
  const controller: SwarmLifecycleController = Object.freeze({
    swarmId: state.record.swarmId,
    assertAcceptingWork() {
      if (!authority(controller).acceptingWork) throw new Error("Swarm is no longer accepting scheduling or admission work.");
    },
    registerActiveChild(registration: ActiveSwarmChildRegistration) {
      const current = authority(controller);
      if (!current.acceptingWork) throw new Error("Cannot register a child after swarm cancellation begins.");
      assertRegistration(current, registration);
      current.registrations.set(registration.childRunId, registration);
    },
    cancel(reason: "cancelled" | "child_terminal_failure") {
      const current = authority(controller);
      current.acceptingWork = false;
      current.cancellation ??= cancelRegisteredChildren(current, reason);
      return current.cancellation;
    }
  });
  controllerAuthority.set(controller, state);
  return controller;
}

async function cancelRegisteredChildren(
  state: ControllerState,
  reason: "cancelled" | "child_terminal_failure"
): Promise<SwarmLifecycleCancellationResult> {
  const now = state.input.now ?? (() => new Date().toISOString());
  const registrations = [...state.registrations.values()];

  // cancel() closes the scheduling/admission gate synchronously before abort.
  for (const registration of registrations) registration.abortController.abort(reason);

  // The shared process supervisor owns bounded grace and escalation. Never race
  // its closure promise with a second timeout that could leave descendants live.
  const closures = await Promise.all(registrations.map(async (registration) => ({
    registration,
    closure: await registration.processClosed.catch(() => ({
      state: "failed" as const,
      completedAt: now(),
      errorCode: "PROCESS_CLOSE_FAILED"
    }))
  })));

  let ledger = cloneLedger(state.record.budgetLedger);
  const terminalEvidence: SwarmLifecycleTerminalEvidence[] = [];
  const childEvents: SwarmEvent[] = [];
  const persisted = new Set<string>();
  const unresolved = new Set<string>();

  // Persist pre-cleanup evidence for every registration before any removal.
  for (const { registration, closure } of closures) {
    const lease = ledger.leases.find((candidate) => candidate.leaseId === registration.leaseId);
    let leaseState: SwarmLifecycleTerminalEvidence["leaseState"] = "failed";
    if (lease && lease.agentId === registration.agentId && lease.taskId === registration.taskId) {
      if (lease.status === "reserved") {
        const released = releaseSwarmBudgetLease(ledger, lease.leaseId);
        if (released.ok) {
          ledger = released.ledger;
          leaseState = "released";
        }
      } else {
        leaseState = lease.status;
      }
    }
    if (leaseState === "failed" || closure.state !== "closed") unresolved.add(registration.childRunId);

    const terminal: SwarmLifecycleTerminalEvidence = Object.freeze({
      schemaVersion: SWARM_SCHEMA_VERSION,
      swarmId: state.record.swarmId,
      agentId: registration.agentId,
      childRunId: registration.childRunId,
      taskId: registration.taskId,
      workspaceId: registration.workspace.record.workspaceId,
      leaseId: registration.leaseId,
      processCloseState: closure.state,
      leaseState,
      reason,
      recordedAt: now(),
      ...(closure.errorCode ? { errorCode: closure.errorCode } : {})
    });
    const childEvent: SwarmEvent = Object.freeze({
      type: closure.state === "closed" ? "CHILD_STOPPED" : "CHILD_NEEDS_REVIEW",
      swarmId: state.record.swarmId,
      timestamp: terminal.recordedAt,
      parentPolicyVersion: state.record.parentContract.policyVersion,
      taskId: registration.taskId,
      agentId: registration.agentId,
      childRunId: registration.childRunId,
      payload: Object.freeze({ reason, processCloseState: closure.state, leaseState })
    });
    terminalEvidence.push(terminal);
    childEvents.push(childEvent);
    try {
      await registration.evidenceWriter.persistBeforeCleanup({
        terminal,
        childEvent,
        budgetLedger: cloneLedger(ledger),
        cleanupIntent: {
          workspaceId: registration.workspace.record.workspaceId,
          workspaceKind: "child",
          force: true
        }
      });
      persisted.add(registration.childRunId);
    } catch {
      unresolved.add(registration.childRunId);
    }
  }

  const cleanupEvidence: SwarmCleanupRecord[] = [];
  for (const { registration, closure } of closures) {
    if (closure.state !== "closed" || !persisted.has(registration.childRunId)) continue;
    let cleanup: SwarmCleanupRecord;
    try {
      cleanup = await state.input.workspaceManager.removeWorkspace(registration.workspace, {
        evidencePersisted: true,
        processTreeClosed: true,
        force: true
      });
    } catch (error) {
      cleanup = failedCleanupRecord(state, registration, error, now, state.input.createCleanupId);
    }
    cleanupEvidence.push(cleanup);
    if (cleanup.state !== "completed") unresolved.add(registration.childRunId);
    try {
      await state.input.evidenceStore.persistCleanupEvidence(cleanup);
    } catch {
      unresolved.add(registration.childRunId);
    }
  }

  const completedAt = now();
  let record = buildTerminalRecord(state.record, closures, childEvents, ledger, unresolved, reason, completedAt);
  try {
    await state.input.evidenceStore.persistTerminalRecord(record);
  } catch {
    unresolved.add("parent-record");
    record = buildTerminalRecord(state.record, closures, childEvents, ledger, unresolved, reason, completedAt);
  }

  const finalState = unresolved.size === 0 ? "stopped" : "needs_review";
  state.record = record;
  return Object.freeze({
    acceptingWork: false,
    state: finalState,
    record,
    terminalEvidence: Object.freeze(terminalEvidence),
    cleanupEvidence: Object.freeze(cleanupEvidence),
    unresolvedChildRunIds: Object.freeze([...unresolved].sort())
  });
}

function buildTerminalRecord(
  record: SwarmRunRecord,
  closures: readonly {
    readonly registration: ActiveSwarmChildRegistration;
    readonly closure: SwarmChildProcessClosure;
  }[],
  childEvents: readonly SwarmEvent[],
  ledger: SwarmBudgetLedger,
  unresolved: ReadonlySet<string>,
  reason: "cancelled" | "child_terminal_failure",
  completedAt: string
): SwarmRunRecord {
  const terminalState = unresolved.size === 0 ? "stopped" : "needs_review";
  const unresolvedChildRunIds = [...unresolved].sort();
  const terminalEvent: SwarmEvent = Object.freeze({
    type: terminalState === "stopped" ? "SWARM_STOPPED" : "SWARM_NEEDS_REVIEW",
    swarmId: record.swarmId,
    timestamp: completedAt,
    parentPolicyVersion: record.parentContract.policyVersion,
    payload: Object.freeze({ reason, unresolvedChildRunIds })
  });
  return cloneRecord({
    ...record,
    budgetLedger: ledger,
    agents: record.agents.map((agent) => {
      const registration = closures.find(({ registration: candidate }) => candidate.agentId === agent.agentId)?.registration;
      return registration
        ? { ...agent, status: unresolved.has(registration.childRunId) ? "needs_review" : "stopped" }
        : { ...agent };
    }),
    tasks: record.tasks.map((task) => {
      const registration = closures.find(({ registration: candidate }) => candidate.taskId === task.taskId)?.registration;
      return registration
        ? { ...task, status: unresolved.has(registration.childRunId) ? "needs_review" : "stopped" }
        : { ...task };
    }),
    outcome: {
      state: terminalState,
      reason: terminalState === "stopped"
        ? "Parent cancellation completed after process closure and evidence-safe cleanup."
        : unresolved.has("parent-record")
          ? "Terminal parent evidence could not be persisted."
          : "Parent cancellation retained unresolved process, evidence, lease, or cleanup state."
    },
    events: [...record.events, ...childEvents, terminalEvent],
    updatedAt: completedAt
  });
}

function authority(controller: SwarmLifecycleController): ControllerState {
  const state = controllerAuthority.get(controller);
  if (!state) throw new Error("Unknown swarm lifecycle authority.");
  return state;
}

function assertRegistration(state: ControllerState, registration: ActiveSwarmChildRegistration): void {
  const agent = state.record.agents.find((candidate) => candidate.agentId === registration.agentId);
  const task = state.record.tasks.find((candidate) => candidate.taskId === registration.taskId);
  const lease = state.record.budgetLedger.leases.find((candidate) => candidate.leaseId === registration.leaseId);
  if (
    registration.swarmId !== state.record.swarmId
    || registration.workspace.record.kind !== "child"
    || registration.workspace.record.swarmId !== state.record.swarmId
    || registration.workspace.record.childRunId !== registration.childRunId
    || registration.workspace.record.agentId !== registration.agentId
    || !registration.workspace.record.taskIds.includes(registration.taskId)
    || agent?.childRunId !== registration.childRunId
    || !agent.contract.taskIds.includes(registration.taskId)
    || task?.assignedAgentId !== registration.agentId
    || lease?.agentId !== registration.agentId
    || lease.taskId !== registration.taskId
    || state.registrations.has(registration.childRunId)
  ) throw new Error("Active swarm child registration is duplicate or authority-mismatched.");
}

function failedCleanupRecord(
  state: ControllerState,
  registration: ActiveSwarmChildRegistration,
  error: unknown,
  now: () => string,
  createCleanupId?: () => string
): SwarmCleanupRecord {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "WORKSPACE_REMOVE_FAILED")
    : "WORKSPACE_REMOVE_FAILED";
  return Object.freeze({
    schemaVersion: SWARM_SCHEMA_VERSION,
    cleanupId: createCleanupId?.() ?? `cleanup-failed-${registration.workspace.record.workspaceId}`,
    swarmId: state.record.swarmId,
    workspaceId: registration.workspace.record.workspaceId,
    workspaceKind: "child",
    evidencePersisted: true,
    processCloseState: "closed",
    removalState: "failed",
    state: code === "EPERM" || code === "EBUSY" ? "cleanup_pending" : "failed",
    attemptedAt: now(),
    errorCode: code
  });
}

function cloneLedger(ledger: SwarmBudgetLedger): SwarmBudgetLedger {
  return {
    ...ledger,
    leases: ledger.leases.map((lease) => ({
      ...lease,
      ...(lease.actualUsage ? { actualUsage: { ...lease.actualUsage } } : {})
    }))
  };
}

function cloneRecord(record: SwarmRunRecord): SwarmRunRecord {
  return JSON.parse(JSON.stringify(record)) as SwarmRunRecord;
}
