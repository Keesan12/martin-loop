import type {
  SwarmBudgetLedger,
  SwarmBudgetLease,
  SwarmDependencyWaiver,
  SwarmParentContract,
  SwarmTaskNode
} from "@martin/contracts";
import {
  normalizeSwarmPathPattern,
  swarmPathPatternsOverlap
} from "@martin/contracts";

export interface SwarmSchedulerError {
  code: string;
  taskId?: string;
  message: string;
}

export type SwarmGraphValidationResult =
  | { ok: true; errors: [] }
  | { ok: false; errors: SwarmSchedulerError[] };

export type SwarmBatchResult =
  | { ok: true; tasks: SwarmTaskNode[]; errors: [] }
  | { ok: false; tasks: []; errors: SwarmSchedulerError[] };

export type SwarmBudgetTransitionResult =
  | { ok: true; ledger: SwarmBudgetLedger; lease: SwarmBudgetLease; errors: [] }
  | { ok: false; ledger: SwarmBudgetLedger; errors: SwarmSchedulerError[] };

export interface SwarmBudgetProtectedUsage {
  readonly usd: number;
  readonly tokens: number;
}

export type ParentDependencyWaiverRegistry = Readonly<{
  kind: "parent_dependency_waiver_registry";
}>;

export type IssuedDependencyWaiverCapability = Readonly<{
  kind: "issued_dependency_waiver";
}>;

export type DependencyWaiverIssuanceResult =
  | {
      ok: true;
      capability: IssuedDependencyWaiverCapability;
      evidence: SwarmDependencyWaiver;
      errors: [];
    }
  | { ok: false; errors: SwarmSchedulerError[] };

interface ParentWaiverRegistryState {
  swarmId: string;
  parentPolicyVersion: string;
  dependencyWaiversAllowed: boolean;
}

interface IssuedWaiverState {
  registry: ParentDependencyWaiverRegistry;
  evidence: SwarmDependencyWaiver;
}

const parentWaiverRegistries = new WeakMap<object, ParentWaiverRegistryState>();
const issuedWaiverCapabilities = new WeakMap<object, IssuedWaiverState>();

export function createParentDependencyWaiverRegistry(input: {
  swarmId: string;
  parentPolicyVersion: string;
  dependencyWaiversAllowed: boolean;
}): ParentDependencyWaiverRegistry {
  const registry: ParentDependencyWaiverRegistry = Object.freeze({
    kind: "parent_dependency_waiver_registry"
  });
  parentWaiverRegistries.set(registry, { ...input });
  return registry;
}

export function issueParentDependencyWaiver(
  registry: ParentDependencyWaiverRegistry,
  evidence: SwarmDependencyWaiver
): DependencyWaiverIssuanceResult {
  const registryState = parentWaiverRegistries.get(registry);
  if (!registryState) {
    return {
      ok: false,
      errors: [{
        code: "UNISSUED_PARENT_WAIVER_REGISTRY",
        message: "Dependency waivers require an internally issued parent registry."
      }]
    };
  }
  if (!registryState.dependencyWaiversAllowed) {
    return {
      ok: false,
      errors: [{
        code: "DEPENDENCY_WAIVERS_DISABLED",
        message: "Parent recovery policy does not allow dependency waivers."
      }]
    };
  }
  if (evidence.parentPolicyVersion !== registryState.parentPolicyVersion) {
    return {
      ok: false,
      errors: [{
        code: "WAIVER_POLICY_VERSION_MISMATCH",
        taskId: evidence.taskId,
        message: "Dependency waiver is not bound to the issuing parent policy version."
      }]
    };
  }
  if (
    !hasText(evidence.taskId)
    || !hasText(evidence.dependencyTaskId)
    || !hasText(evidence.approvedBy)
    || !hasText(evidence.approvedAt)
    || Number.isNaN(Date.parse(evidence.approvedAt))
  ) {
    return {
      ok: false,
      errors: [{
        code: "INVALID_DEPENDENCY_WAIVER",
        taskId: evidence.taskId,
        message: "Dependency waiver evidence requires task, dependency, approval identity, and approval time."
      }]
    };
  }

  const capability: IssuedDependencyWaiverCapability = Object.freeze({
    kind: "issued_dependency_waiver"
  });
  const clonedEvidence = { ...evidence };
  issuedWaiverCapabilities.set(capability, { registry, evidence: clonedEvidence });
  return { ok: true, capability, evidence: clonedEvidence, errors: [] };
}

export function createSwarmBudgetLedger(input: {
  capUsd: number;
  capTokens?: number;
}): SwarmBudgetLedger {
  return {
    capUsd: input.capUsd,
    settledUsd: 0,
    settledTokens: 0,
    leases: [],
    ...(input.capTokens !== undefined ? { capTokens: input.capTokens } : {})
  };
}

export function reserveSwarmBudgetLease(
  ledger: SwarmBudgetLedger,
  input: Omit<SwarmBudgetLease, "status" | "actualUsage">
): SwarmBudgetTransitionResult {
  if (!validateBudgetLedger(ledger)) {
    return budgetError(ledger, "INVALID_BUDGET_LEDGER", "Budget caps and settled totals must be nonnegative finite values within their caps.");
  }
  if (!hasText(input.leaseId) || !hasText(input.agentId) || !hasText(input.taskId)) {
    return budgetError(ledger, "INVALID_LEASE_IDENTITY", "Lease, agent, and task identifiers must be nonempty.");
  }
  if (!isNonnegativeFinite(input.reservedUsd) || !isNonnegativeInteger(input.reservedTokens)) {
    return budgetError(ledger, "INVALID_LEASE_AMOUNT", "Lease reservations must be nonnegative finite values.");
  }
  if (ledger.leases.some((lease) => lease.leaseId === input.leaseId)) {
    return budgetError(ledger, "DUPLICATE_LEASE_ID", `Lease ${input.leaseId} already exists.`);
  }
  const active = activeReservations(ledger);
  if (
    ledger.settledUsd + active.usd + input.reservedUsd > ledger.capUsd
    || (ledger.capTokens !== undefined
      && ledger.settledTokens + active.tokens + input.reservedTokens > ledger.capTokens)
  ) {
    return budgetError(ledger, "GLOBAL_BUDGET_EXCEEDED", "The reservation would exceed the parent budget cap.");
  }
  const lease: SwarmBudgetLease = { ...input, status: "reserved" };
  return {
    ok: true,
    ledger: { ...ledger, leases: [...ledger.leases.map(cloneLease), lease] },
    lease,
    errors: []
  };
}

/**
 * Extends one live lease by atomically reclaiming only the unobserved portion
 * of sibling reservations. This keeps initial fair-share reservations intact
 * until a child actually needs more capacity, while ensuring every live
 * observation remains protected and total granted capacity never exceeds the
 * parent cap.
 */
export function extendSwarmBudgetLease(
  ledger: SwarmBudgetLedger,
  input: {
    leaseId: string;
    requiredUsd: number;
    requiredTokens: number;
    protectedUsage: Readonly<Record<string, SwarmBudgetProtectedUsage>>;
  }
): SwarmBudgetTransitionResult {
  if (!validateBudgetLedger(ledger)) {
    return budgetError(ledger, "INVALID_BUDGET_LEDGER", "Budget caps and settled totals must be nonnegative finite values within their caps.");
  }
  const target = ledger.leases.find((lease) => lease.leaseId === input.leaseId);
  if (!target) return budgetError(ledger, "LEASE_NOT_FOUND", `Lease ${input.leaseId} does not exist.`);
  if (target.status !== "reserved") {
    return budgetError(ledger, "LEASE_ALREADY_FINAL", `Lease ${input.leaseId} is already ${target.status}.`);
  }
  if (!isNonnegativeFinite(input.requiredUsd) || !isNonnegativeInteger(input.requiredTokens)) {
    return budgetError(ledger, "INVALID_LEASE_AMOUNT", "Required live usage must use nonnegative finite values.");
  }
  for (const [leaseId, usage] of Object.entries(input.protectedUsage)) {
    const lease = ledger.leases.find((candidate) => candidate.leaseId === leaseId);
    if (!lease || lease.status !== "reserved") {
      return budgetError(ledger, "INVALID_PROTECTED_USAGE", `Protected usage references non-active lease ${leaseId}.`);
    }
    if (!isNonnegativeFinite(usage.usd) || !isNonnegativeInteger(usage.tokens)) {
      return budgetError(ledger, "INVALID_PROTECTED_USAGE", `Protected usage for lease ${leaseId} is invalid.`);
    }
  }

  const protectedTarget = input.protectedUsage[input.leaseId];
  const requiredUsd = Math.max(input.requiredUsd, protectedTarget?.usd ?? 0, target.reservedUsd);
  const requiredTokens = Math.max(input.requiredTokens, protectedTarget?.tokens ?? 0, target.reservedTokens);
  if (requiredUsd > ledger.capUsd || (ledger.capTokens !== undefined && requiredTokens > ledger.capTokens)) {
    return budgetError(ledger, "GLOBAL_BUDGET_EXCEEDED", "The live usage observation exceeds the parent budget cap.");
  }

  const nextLeases = ledger.leases.map(cloneLease);
  let usdNeeded = requiredUsd - target.reservedUsd;
  let tokensNeeded = requiredTokens - target.reservedTokens;
  const active = activeReservations(ledger);
  usdNeeded = Math.max(0, usdNeeded - Math.max(0, ledger.capUsd - ledger.settledUsd - active.usd));
  tokensNeeded = Math.max(0, tokensNeeded - Math.max(0, (ledger.capTokens ?? Number.MAX_SAFE_INTEGER) - ledger.settledTokens - active.tokens));

  for (const sibling of [...nextLeases]
    .filter((lease) => lease.status === "reserved" && lease.leaseId !== input.leaseId)
    .sort((left, right) => left.leaseId.localeCompare(right.leaseId))) {
    const floor = input.protectedUsage[sibling.leaseId] ?? { usd: 0, tokens: 0 };
    const reclaimedUsd = Math.min(usdNeeded, Math.max(0, sibling.reservedUsd - floor.usd));
    const reclaimedTokens = Math.min(tokensNeeded, Math.max(0, sibling.reservedTokens - floor.tokens));
    sibling.reservedUsd -= reclaimedUsd;
    sibling.reservedTokens -= reclaimedTokens;
    usdNeeded -= reclaimedUsd;
    tokensNeeded -= reclaimedTokens;
    if (nearlyEqual(usdNeeded, 0) && tokensNeeded === 0) break;
  }
  if (!nearlyEqual(usdNeeded, 0) || tokensNeeded !== 0) {
    return budgetError(ledger, "GLOBAL_BUDGET_EXCEEDED", "Observed live usage cannot be granted without exceeding the parent budget cap.");
  }

  const nextTarget = nextLeases.find((lease) => lease.leaseId === input.leaseId)!;
  nextTarget.reservedUsd = requiredUsd;
  nextTarget.reservedTokens = requiredTokens;
  const nextLedger = { ...ledger, leases: nextLeases };
  if (!validateBudgetLedger(nextLedger)) {
    return budgetError(ledger, "GLOBAL_BUDGET_EXCEEDED", "The elastic lease transition would violate the parent budget cap.");
  }
  return { ok: true, ledger: nextLedger, lease: cloneLease(nextTarget), errors: [] };
}

export function settleSwarmBudgetLease(
  ledger: SwarmBudgetLedger,
  input: { leaseId: string; actualUsd: number; actualTokens: number; provenance?: string }
): SwarmBudgetTransitionResult {
  if (!validateBudgetLedger(ledger)) {
    return budgetError(ledger, "INVALID_BUDGET_LEDGER", "Budget caps and settled totals must be nonnegative finite values within their caps.");
  }
  const lease = ledger.leases.find((candidate) => candidate.leaseId === input.leaseId);
  if (!lease) return budgetError(ledger, "LEASE_NOT_FOUND", `Lease ${input.leaseId} does not exist.`);
  if (lease.status !== "reserved") {
    return budgetError(ledger, "LEASE_ALREADY_FINAL", `Lease ${input.leaseId} is already ${lease.status}.`);
  }
  if (!isNonnegativeFinite(input.actualUsd) || !isNonnegativeInteger(input.actualTokens)) {
    return budgetError(ledger, "INVALID_SETTLEMENT_AMOUNT", "Actual usage must use nonnegative finite values.");
  }
  const leaseOverspent = input.actualUsd > lease.reservedUsd || input.actualTokens > lease.reservedTokens;
  const settledLease: SwarmBudgetLease = {
    ...lease,
    status: leaseOverspent ? "overspent" : "settled",
    actualUsage: {
      usd: input.actualUsd,
      tokens: input.actualTokens,
      ...(input.provenance !== undefined ? { provenance: input.provenance } : {})
    }
  };
  const nextLedger: SwarmBudgetLedger = {
    ...ledger,
    settledUsd: ledger.settledUsd + input.actualUsd,
    settledTokens: ledger.settledTokens + input.actualTokens,
    leases: ledger.leases.map((candidate) => candidate.leaseId === input.leaseId ? settledLease : cloneLease(candidate))
  };
  if (leaseOverspent) {
    return budgetError(
      nextLedger,
      "LEASE_OVERSPEND",
      "Actual usage exceeded the reserved lease and was recorded as terminal spend."
    );
  }
  return { ok: true, ledger: nextLedger, lease: settledLease, errors: [] };
}

export function releaseSwarmBudgetLease(
  ledger: SwarmBudgetLedger,
  leaseId: string
): SwarmBudgetTransitionResult {
  if (!validateBudgetLedger(ledger)) {
    return budgetError(ledger, "INVALID_BUDGET_LEDGER", "Budget caps and settled totals must be nonnegative finite values within their caps.");
  }
  const lease = ledger.leases.find((candidate) => candidate.leaseId === leaseId);
  if (!lease) return budgetError(ledger, "LEASE_NOT_FOUND", `Lease ${leaseId} does not exist.`);
  if (lease.status !== "reserved") {
    return budgetError(ledger, "LEASE_ALREADY_FINAL", `Lease ${leaseId} is already ${lease.status}.`);
  }
  const releasedLease: SwarmBudgetLease = { ...lease, status: "released" };
  return {
    ok: true,
    ledger: {
      ...ledger,
      leases: ledger.leases.map((candidate) => candidate.leaseId === leaseId ? releasedLease : cloneLease(candidate))
    },
    lease: releasedLease,
    errors: []
  };
}

export function validateSwarmTaskGraph(tasks: readonly SwarmTaskNode[]): SwarmGraphValidationResult {
  const errors: SwarmSchedulerError[] = [];
  const byId = new Map<string, SwarmTaskNode>();

  for (const task of tasks) {
    if (byId.has(task.taskId)) {
      errors.push({
        code: "DUPLICATE_TASK_ID",
        taskId: task.taskId,
        message: `Duplicate task identifier: ${task.taskId}`
      });
    } else {
      byId.set(task.taskId, task);
    }
    if (task.mutationMode === "read_only" && task.writeScope.length > 0) {
      errors.push({
        code: "READ_ONLY_SCOPE_CONFLICT",
        taskId: task.taskId,
        message: "Read-only tasks cannot declare write scope."
      });
    }
    if (task.mutationMode !== "read_only" && task.mutationMode !== "write") {
      errors.push({
        code: "INVALID_MUTATION_MODE",
        taskId: task.taskId,
        message: "Tasks must explicitly declare read_only or write mutation mode."
      });
    } else if (task.mutationMode === "write" && task.writeScope.length === 0) {
      errors.push({
        code: "WRITE_SCOPE_REQUIRED",
        taskId: task.taskId,
        message: "Write tasks must declare at least one write scope pattern."
      });
    }
    if (task.writeScope.some((pattern) => !normalizeSwarmPathPattern(pattern).ok)) {
      errors.push({
        code: "INVALID_WRITE_SCOPE",
        taskId: task.taskId,
        message: "Task write scope contains an unsafe or malformed repository path pattern."
      });
    }
  }

  for (const task of tasks) {
    for (const dependencyId of task.dependsOn) {
      if (dependencyId === task.taskId) {
        errors.push({
          code: "SELF_DEPENDENCY",
          taskId: task.taskId,
          message: `Task ${task.taskId} cannot depend on itself.`
        });
      } else if (!byId.has(dependencyId)) {
        errors.push({
          code: "MISSING_DEPENDENCY",
          taskId: task.taskId,
          message: `Task ${task.taskId} depends on missing task ${dependencyId}.`
        });
      }
    }
  }

  if (!errors.some((error) => error.code === "DUPLICATE_TASK_ID" || error.code === "MISSING_DEPENDENCY")) {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (taskId: string): boolean => {
      if (visiting.has(taskId)) return true;
      if (visited.has(taskId)) return false;
      visiting.add(taskId);
      for (const dependencyId of byId.get(taskId)?.dependsOn ?? []) {
        if (visit(dependencyId)) return true;
      }
      visiting.delete(taskId);
      visited.add(taskId);
      return false;
    };

    for (const taskId of [...byId.keys()].sort()) {
      if (visit(taskId)) {
        errors.push({
          code: "TASK_CYCLE",
          taskId,
          message: `Task graph contains a dependency cycle involving ${taskId}.`
        });
        break;
      }
    }
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

export function selectNextSwarmBatch(input: {
  swarmId: string;
  tasks: readonly SwarmTaskNode[];
  maxConcurrency: number;
  parentContract: Pick<SwarmParentContract, "policyVersion" | "recoveryPolicy" | "maxConcurrency">;
  dependencyWaiverRegistry?: ParentDependencyWaiverRegistry;
  dependencyWaiverCapabilities?: readonly IssuedDependencyWaiverCapability[];
}): SwarmBatchResult {
  const graph = validateSwarmTaskGraph(input.tasks);
  const errors: SwarmSchedulerError[] = [...graph.errors];
  if (!hasText(input.swarmId)) {
    errors.push({
      code: "INVALID_SWARM_ID",
      message: "Active swarmId is required for scheduler authority binding."
    });
  }
  if (!Number.isInteger(input.maxConcurrency) || input.maxConcurrency <= 0) {
    errors.push({
      code: "INVALID_CONCURRENCY",
      message: "maxConcurrency must be a positive integer."
    });
  }
  if (!Number.isInteger(input.parentContract.maxConcurrency) || input.parentContract.maxConcurrency <= 0) {
    errors.push({
      code: "INVALID_PARENT_CONCURRENCY",
      message: "Parent maxConcurrency must be a positive integer."
    });
  }
  const waiverValidation = validateDependencyWaiverCapabilities(
    input.swarmId,
    input.tasks,
    input.parentContract,
    input.dependencyWaiverRegistry,
    input.dependencyWaiverCapabilities ?? []
  );
  errors.push(...waiverValidation.errors);
  if (errors.length > 0) return { ok: false, tasks: [], errors };

  const byId = new Map(input.tasks.map((task) => [task.taskId, task]));
  const running = input.tasks.filter((task) => task.status === "running");
  if (running.length > input.parentContract.maxConcurrency) {
    return {
      ok: false,
      tasks: [],
      errors: [{
        code: "PARENT_CONCURRENCY_EXCEEDED",
        message: "Active work already exceeds the parent concurrency cap."
      }]
    };
  }
  const effectiveConcurrency = Math.min(input.maxConcurrency, input.parentContract.maxConcurrency);
  const availableSlots = Math.max(effectiveConcurrency - running.length, 0);
  if (availableSlots === 0) return { ok: true, tasks: [], errors: [] };

  const ready = input.tasks
    .filter((task) => task.status === "queued" || task.status === "ready")
    .filter((task) => task.dependsOn.every((dependencyId) => {
      if (waiverValidation.evidence.some((waiver) =>
        waiver.taskId === task.taskId
        && waiver.dependencyTaskId === dependencyId
        && waiver.parentPolicyVersion === input.parentContract.policyVersion
      )) return true;
      const dependency = byId.get(dependencyId);
      return dependency?.status === "accepted";
    }))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));

  const admitted: SwarmTaskNode[] = [];
  const activeMutations = running.filter(isMutatingTask);
  for (const candidate of ready) {
    if (admitted.length >= availableSlots) break;
    if (
      isMutatingTask(candidate)
      && [...activeMutations, ...admitted.filter(isMutatingTask)].some((active) => tasksHaveScopeCollision(candidate, active))
    ) {
      continue;
    }
    admitted.push(candidate);
  }

  return { ok: true, tasks: admitted, errors: [] };
}

export function tasksHaveScopeCollision(left: SwarmTaskNode, right: SwarmTaskNode): boolean {
  if (!isMutatingTask(left) || !isMutatingTask(right)) return false;
  return left.writeScope.some((leftPath) =>
    right.writeScope.some((rightPath) => swarmPathPatternsOverlap(leftPath, rightPath))
  );
}

function isMutatingTask(task: SwarmTaskNode): boolean {
  return task.mutationMode === "write";
}

function activeReservations(ledger: SwarmBudgetLedger): { usd: number; tokens: number } {
  return ledger.leases.reduce(
    (total, lease) => lease.status === "reserved"
      ? { usd: total.usd + lease.reservedUsd, tokens: total.tokens + lease.reservedTokens }
      : total,
    { usd: 0, tokens: 0 }
  );
}

function budgetError(
  ledger: SwarmBudgetLedger,
  code: string,
  message: string
): SwarmBudgetTransitionResult {
  return {
    ok: false,
    ledger: cloneLedger(ledger),
    errors: [{ code, message }]
  };
}

function cloneLedger(ledger: SwarmBudgetLedger): SwarmBudgetLedger {
  return { ...ledger, leases: ledger.leases.map(cloneLease) };
}

function cloneLease(lease: SwarmBudgetLease): SwarmBudgetLease {
  return {
    ...lease,
    ...(lease.actualUsage ? { actualUsage: { ...lease.actualUsage } } : {})
  };
}

function isNonnegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function validateBudgetLedger(ledger: SwarmBudgetLedger): boolean {
  if (
    !isNonnegativeFinite(ledger.capUsd)
    || (ledger.capTokens !== undefined && !isNonnegativeInteger(ledger.capTokens))
    || !isNonnegativeFinite(ledger.settledUsd)
    || !isNonnegativeInteger(ledger.settledTokens)
  ) {
    return false;
  }

  const ids = new Set<string>();
  let settledUsd = 0;
  let settledTokens = 0;
  let reservedUsd = 0;
  let reservedTokens = 0;
  let hasOverspentLease = false;
  for (const lease of ledger.leases) {
    if (!hasText(lease.leaseId) || ids.has(lease.leaseId) || !hasText(lease.agentId) || !hasText(lease.taskId)) {
      return false;
    }
    ids.add(lease.leaseId);
    if (!(["reserved", "settled", "overspent", "released"] as string[]).includes(lease.status)) return false;
    if (!isNonnegativeFinite(lease.reservedUsd) || !isNonnegativeInteger(lease.reservedTokens)) return false;

    if (lease.status === "settled" || lease.status === "overspent") {
      if (
        !lease.actualUsage
        || !isNonnegativeFinite(lease.actualUsage.usd)
        || !isNonnegativeInteger(lease.actualUsage.tokens)
      ) {
        return false;
      }
      const exceededReservation = lease.actualUsage.usd > lease.reservedUsd
        || lease.actualUsage.tokens > lease.reservedTokens;
      if ((lease.status === "settled" && exceededReservation)
        || (lease.status === "overspent" && !exceededReservation)) {
        return false;
      }
      settledUsd += lease.actualUsage.usd;
      settledTokens += lease.actualUsage.tokens;
      if (lease.status === "overspent") hasOverspentLease = true;
    } else if (lease.actualUsage !== undefined) {
      return false;
    }

    if (lease.status === "reserved") {
      reservedUsd += lease.reservedUsd;
      reservedTokens += lease.reservedTokens;
    }
  }

  return nearlyEqual(ledger.settledUsd, settledUsd)
    && ledger.settledTokens === settledTokens
    // Once a provider reports an overage, the spend is irreversible. Keep the
    // ledger structurally valid so every already-running lease can settle its
    // actual usage and terminal evidence can seal. Admission remains closed:
    // reserveSwarmBudgetLease still rejects any further reservation whose
    // settled + reserved total exceeds the hard cap.
    && (hasOverspentLease || settledUsd + reservedUsd <= ledger.capUsd)
    && (ledger.capTokens === undefined
      || hasOverspentLease
      || settledTokens + reservedTokens <= ledger.capTokens);
}

function isNonnegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
}

function hasText(value: string): boolean {
  return value.trim().length > 0;
}

function validateDependencyWaiverCapabilities(
  activeSwarmId: string,
  tasks: readonly SwarmTaskNode[],
  parent: Pick<SwarmParentContract, "policyVersion" | "recoveryPolicy">,
  registry: ParentDependencyWaiverRegistry | undefined,
  capabilities: readonly IssuedDependencyWaiverCapability[]
): { errors: SwarmSchedulerError[]; evidence: SwarmDependencyWaiver[] } {
  if (capabilities.length === 0) return { errors: [], evidence: [] };
  if (!parent.recoveryPolicy.dependencyWaiversAllowed) {
    return {
      errors: [{
        code: "DEPENDENCY_WAIVERS_DISABLED",
        message: "Parent recovery policy does not allow dependency waivers."
      }],
      evidence: []
    };
  }
  const registryState = registry ? parentWaiverRegistries.get(registry) : undefined;
  if (!registry || !registryState) {
    return {
      errors: [{
        code: "UNISSUED_DEPENDENCY_WAIVER",
        message: "Dependency waiver capabilities require an internally issued parent registry."
      }],
      evidence: []
    };
  }
  if (registryState.swarmId !== activeSwarmId) {
    return {
      errors: [{
        code: "WAIVER_SWARM_MISMATCH",
        message: "Parent waiver registry is not bound to the active swarm."
      }],
      evidence: []
    };
  }
  if (registryState.parentPolicyVersion !== parent.policyVersion) {
    return {
      errors: [{
        code: "WAIVER_POLICY_VERSION_MISMATCH",
        message: "Parent waiver registry is not bound to the active policy version."
      }],
      evidence: []
    };
  }
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const errors: SwarmSchedulerError[] = [];
  const evidence: SwarmDependencyWaiver[] = [];
  for (const capability of capabilities) {
    const issued = isObject(capability) ? issuedWaiverCapabilities.get(capability) : undefined;
    if (!issued || issued.registry !== registry) {
      errors.push({
        code: "UNISSUED_DEPENDENCY_WAIVER",
        message: "A structurally valid object is not an internally issued waiver capability."
      });
      continue;
    }
    const waiver = issued.evidence;
    if (waiver.parentPolicyVersion !== parent.policyVersion) {
      errors.push({
        code: "WAIVER_POLICY_VERSION_MISMATCH",
        taskId: waiver.taskId,
        message: "Dependency waiver is not bound to the active parent policy version."
      });
      continue;
    }
    const task = byId.get(waiver.taskId);
    if (
      !task
      || !task.dependsOn.includes(waiver.dependencyTaskId)
      || !hasText(waiver.approvedBy)
      || !hasText(waiver.approvedAt)
      || Number.isNaN(Date.parse(waiver.approvedAt))
    ) {
      errors.push({
        code: "INVALID_DEPENDENCY_WAIVER",
        taskId: waiver.taskId,
        message: "Dependency waiver must bind an existing dependency and include approval identity and time."
      });
      continue;
    }
    evidence.push({ ...waiver });
  }
  return { errors, evidence: errors.length === 0 ? evidence : [] };
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
