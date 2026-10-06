import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm
} from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  SWARM_SCHEMA_VERSION,
  validateSwarmLiveEvent,
  validateSwarmLivePlan,
  validateSwarmLiveRevision
} from "@martin/contracts";
import type {
  FailureClass,
  SwarmEvent,
  SwarmEventType,
  SwarmLiveEvent,
  SwarmLivePlan,
  SwarmOutcome
} from "@martin/contracts";
import {
  isAuthorizedParentSwarmPipelineResult,
  type RunParentSwarmPipelineResult
} from "./index.js";

export interface SwarmLiveStorePaths {
  directory: string;
  plan: string;
  events: string;
  snapshot: string;
  startClaim: string;
  writerLock: string;
  eventClaims: string;
}

export interface CanonicalSwarmLiveEvidenceFile {
  kind: "plan" | "start_claim" | "event_claim" | "events" | "snapshot";
  path: string;
  bytes: Buffer;
}

export interface CanonicalSwarmLiveEvidenceBundle {
  plan: SwarmLivePlan;
  events: SwarmLiveEvent[];
  snapshot: SwarmLiveSnapshot;
  paths: SwarmLiveStorePaths;
  files: CanonicalSwarmLiveEvidenceFile[];
}

export interface SwarmCancellationRequest {
  requestedAt: string;
  reason: string;
  requestedBy?: string;
}

export interface SwarmLiveSnapshot {
  schemaVersion: typeof SWARM_SCHEMA_VERSION;
  swarmId: string;
  planHash: string;
  revision: number;
  lastSequence: number;
  eventCount: number;
  lastEventType?: SwarmEventType;
  cancellation?: SwarmCancellationRequest;
  outcome: SwarmOutcome;
  updatedAt: string;
}

export interface SwarmLiveEventInput {
  idempotencyKey: string;
  type: SwarmEventType;
  timestamp: string;
  taskId?: string;
  agentId?: string;
  childRunId?: string;
  failureClass?: FailureClass;
  payload: Record<string, unknown>;
}

export interface SwarmLiveAppendResult {
  event: SwarmLiveEvent;
  snapshot: SwarmLiveSnapshot;
  duplicate: boolean;
}

export interface SwarmLiveAppendOptions {
  expectedRevision: number;
}

export interface CreateSwarmLiveStoreInput {
  rootDir: string;
  plan: SwarmLivePlan;
}

export interface OpenSwarmLiveStoreInput {
  rootDir: string;
  swarmId: string;
}

export interface SwarmLiveStore {
  readonly plan: SwarmLivePlan;
  claimStart(): Promise<void>;
  append(input: SwarmLiveEventInput, options: SwarmLiveAppendOptions): Promise<SwarmLiveAppendResult>;
  persistParentOutcome(
    result: RunParentSwarmPipelineResult,
    options: SwarmLiveAppendOptions
  ): Promise<SwarmLiveAppendResult>;
  requestCancellation(
    request: SwarmCancellationRequest & { idempotencyKey: string },
    options: SwarmLiveAppendOptions
  ): Promise<SwarmLiveAppendResult>;
  readSnapshot(): Promise<SwarmLiveSnapshot>;
  readEvents(): Promise<SwarmLiveEvent[]>;
  waitForRevision(afterRevision: number, signal?: AbortSignal): Promise<SwarmLiveSnapshot>;
  paths(): SwarmLiveStorePaths;
}

export class SwarmLiveStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "SwarmLiveStoreError";
  }
}

const writerQueues = new Map<string, Promise<void>>();

export async function createSwarmLiveStore(input: CreateSwarmLiveStoreInput): Promise<SwarmLiveStore> {
  assertValidPlan(input.plan);
  const paths = resolveStorePaths(input.rootDir, input.plan.swarmId);
  await mkdir(paths.directory, { recursive: true });
  await publishJsonIfAbsent(paths.plan, input.plan);
  const existingPlan = await readRequiredJson<SwarmLivePlan>(paths.plan, "MISSING_PLAN");
  assertValidPlan(existingPlan);
  if (existingPlan.planHash !== input.plan.planHash) {
    throw new SwarmLiveStoreError(
      "PLAN_CONFLICT",
      "A different live plan already owns this swarm store.",
      { expectedPlanHash: existingPlan.planHash, actualPlanHash: input.plan.planHash }
    );
  }
  const eventsHandle = await open(paths.events, "a");
  await eventsHandle.close();
  await mkdir(paths.eventClaims, { recursive: true });
  const store = new FileSwarmLiveStore(paths, clone(input.plan));
  await store.recover();
  return store;
}

export async function openSwarmLiveStore(input: OpenSwarmLiveStoreInput): Promise<SwarmLiveStore> {
  const paths = resolveStorePaths(input.rootDir, input.swarmId);
  return openSwarmLiveStoreAtDirectory({ directory: paths.directory, swarmId: input.swarmId });
}

/** Internal canonical-path entrypoint; intentionally not exported from the Core package root. */
export async function openSwarmLiveStoreAtDirectory(input: {
  directory: string;
  swarmId: string;
}): Promise<SwarmLiveStore> {
  const paths = resolveStorePathsAtDirectory(input.directory, input.swarmId);
  const plan = await readRequiredJson<SwarmLivePlan>(paths.plan, "MISSING_PLAN");
  assertValidPlan(plan);
  if (plan.swarmId !== input.swarmId) {
    throw new SwarmLiveStoreError("PLAN_CONFLICT", "Canonical store directory contains a different swarm plan.");
  }
  const store = new FileSwarmLiveStore(paths, plan);
  await store.recover();
  return store;
}

/** Read-only evidence path. It validates derived files but never heals or rewrites them. */
export async function readCanonicalSwarmLiveEvidenceBundle(input: {
  directory: string;
  swarmId: string;
}): Promise<CanonicalSwarmLiveEvidenceBundle> {
  const paths = resolveStorePathsAtDirectory(input.directory, input.swarmId);
  const planBytes = await readRequiredBytes(paths.plan, "MISSING_PLAN");
  const plan = parseRequiredJson<SwarmLivePlan>(planBytes, paths.plan);
  assertValidPlan(plan);
  if (plan.swarmId !== input.swarmId) {
    throw new SwarmLiveStoreError("PLAN_CONFLICT", "Canonical store directory contains a different swarm plan.");
  }

  const startClaimBytes = await readRequiredBytes(paths.startClaim, "MISSING_START_CLAIM");
  const startClaim = parseRequiredJson<Partial<{
    schemaVersion: string;
    swarmId: string;
    planHash: string;
  }>>(startClaimBytes, paths.startClaim);
  if (
    startClaim.schemaVersion !== SWARM_SCHEMA_VERSION
    || startClaim.swarmId !== plan.swarmId
    || startClaim.planHash !== plan.planHash
  ) {
    throw new SwarmLiveStoreError("START_CLAIM_CONFLICT", "Start claim does not bind the canonical swarm plan.");
  }

  const authoritative = await loadAuthoritativeEventClaims(paths, plan, { strictEntries: true });
  const terminalIndexes = authoritative.events.flatMap((event, index) => (
    isParentTerminalEvent(event) ? [index] : []
  ));
  if (
    terminalIndexes.length !== 1
    || terminalIndexes[0] !== authoritative.events.length - 1
  ) {
    throw new SwarmLiveStoreError(
      "INVALID_TERMINAL_EVENT_CHAIN",
      "Canonical swarm evidence requires exactly one final parent terminal event."
    );
  }
  const snapshot = replaySnapshot(plan, authoritative.events);
  if (snapshot.outcome.state === "running") {
    throw new SwarmLiveStoreError("NON_TERMINAL_SWARM_EVIDENCE", "Swarm evidence can only be sealed after a parent terminal outcome.");
  }

  const eventsBytes = await readRequiredBytes(paths.events, "MISSING_EVENT_JOURNAL");
  const expectedEvents = Buffer.from(eventJournalText(authoritative.events), "utf8");
  if (!eventsBytes.equals(expectedEvents)) {
    throw new SwarmLiveStoreError("EVENT_JOURNAL_MISMATCH", "Derived event journal does not match immutable event claims.");
  }
  const snapshotBytes = await readRequiredBytes(paths.snapshot, "MISSING_SNAPSHOT");
  const expectedSnapshot = Buffer.from(jsonText(snapshot), "utf8");
  if (!snapshotBytes.equals(expectedSnapshot)) {
    throw new SwarmLiveStoreError("SNAPSHOT_MISMATCH", "Derived snapshot does not match immutable event claims.");
  }

  return {
    plan: clone(plan),
    events: authoritative.events.map(clone),
    snapshot: clone(snapshot),
    paths: { ...paths },
    files: [
      { kind: "plan", path: paths.plan, bytes: planBytes },
      { kind: "start_claim", path: paths.startClaim, bytes: startClaimBytes },
      ...authoritative.claims.map((claim) => ({
        kind: "event_claim" as const,
        path: claim.path,
        bytes: claim.bytes
      })),
      { kind: "events", path: paths.events, bytes: eventsBytes },
      { kind: "snapshot", path: paths.snapshot, bytes: snapshotBytes }
    ]
  };
}

class FileSwarmLiveStore implements SwarmLiveStore {
  readonly plan: SwarmLivePlan;
  readonly #listeners = new Set<(snapshot: SwarmLiveSnapshot) => void>();

  constructor(
    private readonly storePaths: SwarmLiveStorePaths,
    plan: SwarmLivePlan
  ) {
    this.plan = clone(plan);
  }

  paths(): SwarmLiveStorePaths {
    return { ...this.storePaths };
  }

  async claimStart(): Promise<void> {
    const claim = {
      schemaVersion: SWARM_SCHEMA_VERSION,
      swarmId: this.plan.swarmId,
      planHash: this.plan.planHash
    };
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.storePaths.startClaim, "wx");
      await handle.writeFile(`${JSON.stringify(claim, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      await handle?.close();
      if (!isNodeError(error, "EEXIST")) throw error;
      const existing = await readRequiredJson<Partial<typeof claim>>(
        this.storePaths.startClaim,
        "MISSING_START_CLAIM"
      );
      if (
        existing.schemaVersion !== SWARM_SCHEMA_VERSION
        || existing.swarmId !== this.plan.swarmId
        || existing.planHash !== this.plan.planHash
      ) {
        throw new SwarmLiveStoreError(
          "START_CLAIM_CONFLICT",
          "The immutable live swarm start claim does not match this exact plan."
        );
      }
      throw new SwarmLiveStoreError(
        "LIVE_SWARM_ALREADY_STARTED",
        "This exact live swarm has already started; replay is blocked before spend."
      );
    }
  }

  async recover(): Promise<void> {
    const events = await loadAuthoritativeEvents(this.storePaths, this.plan);
    const snapshot = replaySnapshot(this.plan, events);
    await Promise.all([
      writeEventJournalAtomic(this.storePaths.events, events),
      writeDerivedJsonAtomic(this.storePaths.snapshot, snapshot)
    ]);
  }

  async append(
    input: SwarmLiveEventInput,
    options: SwarmLiveAppendOptions
  ): Promise<SwarmLiveAppendResult> {
    if (input.type === "SWARM_VERIFIED") {
      throw new SwarmLiveStoreError(
        "PARENT_VERIFIED_AUTHORITY_REQUIRED",
        "SWARM_VERIFIED may only be persisted by the parent/global verifier pipeline."
      );
    }
    return this.appendInternal(input, options);
  }

  async persistParentOutcome(
    result: RunParentSwarmPipelineResult,
    options: SwarmLiveAppendOptions
  ): Promise<SwarmLiveAppendResult> {
    if (!isAuthorizedParentSwarmPipelineResult(result)) {
      throw new SwarmLiveStoreError(
        "PARENT_PIPELINE_AUTHORITY_REQUIRED",
        "Only the exact result object returned by runParentSwarmPipeline may persist a parent outcome."
      );
    }
    const parentResult = clone(result);
    if (
      parentResult.record.swarmId !== this.plan.swarmId
      || parentResult.record.parentContract.policyVersion !== this.plan.parentContract.policyVersion
      || parentResult.outcome.state === "running"
      || parentResult.record.outcome.state !== parentResult.outcome.state
      || parentResult.record.outcome.reason !== parentResult.outcome.reason
    ) {
      throw new SwarmLiveStoreError("PARENT_OUTCOME_MISMATCH", "Parent pipeline outcome does not match this live plan.");
    }
    const type = parentResult.outcome.state === "verified"
      ? "SWARM_VERIFIED"
      : parentResult.outcome.state === "stopped"
        ? "SWARM_STOPPED"
        : "SWARM_NEEDS_REVIEW";
    const terminalEvents = parentResult.record.events.filter((event) => isParentRecordTerminalEvent(event));
    const authorityEvents = terminalEvents.filter((event) => event.type === "SWARM_VERIFIED");
    const globalVerifierEvents = parentResult.record.events.filter((event) => (
      (event.type === "GLOBAL_VERIFIER_PASSED" || event.type === "GLOBAL_VERIFIER_FAILED")
      && event.swarmId === this.plan.swarmId
      && event.parentPolicyVersion === this.plan.parentContract.policyVersion
    ));
    if (
      terminalEvents.length > 1
      || (terminalEvents[0] !== undefined && (
        terminalEvents[0] !== parentResult.record.events.at(-1)
        || terminalEvents[0].type !== type
        || terminalEvents[0].swarmId !== this.plan.swarmId
        || terminalEvents[0].parentPolicyVersion !== this.plan.parentContract.policyVersion
      ))
      || (type === "SWARM_VERIFIED" && authorityEvents.length !== 1)
    ) {
      throw new SwarmLiveStoreError(
        "PARENT_OUTCOME_MISMATCH",
        "Parent result lacks one exact final parent outcome authority event."
      );
    }
    if (
      globalVerifierEvents.length > 1
      || (type === "SWARM_VERIFIED" && globalVerifierEvents[0]?.type !== "GLOBAL_VERIFIER_PASSED")
      || (globalVerifierEvents[0] !== undefined && (
        parentResult.verification === undefined
        || globalVerifierEvents[0].payload.verificationId !== parentResult.verification.verificationId
        || globalVerifierEvents[0].payload.integratedTreeHash !== parentResult.integration.finalTreeHash
      ))
      || (parentResult.verification !== undefined && globalVerifierEvents.length !== 1)
    ) {
      throw new SwarmLiveStoreError(
        "PARENT_OUTCOME_MISMATCH",
        "Parent result has an invalid global-verifier event sequence."
      );
    }
    const resultSha256 = createHash("sha256").update(JSON.stringify(parentResult), "utf8").digest("hex");
    const durableEvents = await loadAuthoritativeEvents(this.storePaths, this.plan);
    const firstPersistedParentEvent = durableEvents.findIndex((event) => isPersistedParentPipelineEvent(event));
    const durablePrefixLength = firstPersistedParentEvent < 0 ? durableEvents.length : firstPersistedParentEvent;
    const recordPrefixOffset = canonicalUndurableBootstrapOffset(
      parentResult.record,
      durableEvents.slice(0, durablePrefixLength)
    );
    if (
      parentResult.record.events.length < recordPrefixOffset + durablePrefixLength
      || durableEvents.slice(0, durablePrefixLength).some((event, index) => (
        !sameRecordEvent(event, parentResult.record.events[recordPrefixOffset + index])
      ))
    ) {
      throw new SwarmLiveStoreError(
        "PARENT_PIPELINE_EVENT_MISMATCH",
        "Durable child lifecycle events do not match the authorized parent result."
      );
    }

    const parentRecordEvents = parentResult.record.events.slice(recordPrefixOffset + durablePrefixLength);
    assertAuthorizedParentEventSequence(parentResult, parentRecordEvents, type);
    const integrationInputs = parentRecordEvents.flatMap((event, index) => (
      isParentIntegrationEvent(event)
        ? [recordEventInput(
            event,
            `parent-integration:${resultSha256}:${String(index).padStart(6, "0")}`
          )]
        : []
    ));
    let expectedRevision = options.expectedRevision;
    const expectedInputs: SwarmLiveEventInput[] = [...integrationInputs];
    const globalVerifierEvent = globalVerifierEvents[0];
    if (globalVerifierEvent) {
      expectedInputs.push({
        idempotencyKey: `parent-global-verifier:${this.plan.swarmId}:${resultSha256}`,
        type: globalVerifierEvent.type,
        timestamp: globalVerifierEvent.timestamp,
        payload: clone(globalVerifierEvent.payload)
      });
    }
    expectedInputs.push({
      idempotencyKey: `parent-outcome:${this.plan.swarmId}:${parentResult.outcome.state}:${resultSha256}`,
      type,
      timestamp: terminalEvents[0]?.timestamp ?? parentResult.record.updatedAt,
      payload: {
        reason: parentResult.outcome.reason,
        parentPipelineAuthority: "runParentSwarmPipeline:v1",
        parentPipelineResultSha256: resultSha256,
        ...(globalVerifierEvent ? {
          verificationId: globalVerifierEvent.payload.verificationId,
          integratedTreeHash: globalVerifierEvent.payload.integratedTreeHash
        } : {})
      }
    });

    const durableParentEvents = durableEvents.slice(durablePrefixLength);
    if (
      durableParentEvents.length > expectedInputs.length
      || durableParentEvents.some((event, index) => (
        expectedInputs[index] === undefined || !isExactPersistedParentResultEvent(event, expectedInputs[index])
      ))
    ) {
      throw new SwarmLiveStoreError(
        "PARENT_PIPELINE_EVENT_MISMATCH",
        "Durable parent events do not match this authorized parent result."
      );
    }

    let persisted: SwarmLiveAppendResult | undefined;
    for (const input of expectedInputs) {
      persisted = await this.appendInternal(input, { expectedRevision }, input.type === "SWARM_VERIFIED");
      expectedRevision = persisted.snapshot.revision;
    }
    if (!persisted) {
      throw new SwarmLiveStoreError("PARENT_PIPELINE_EVENT_MISMATCH", "Parent result produced no terminal event.");
    }
    return persisted;
  }

  private async appendInternal(
    input: SwarmLiveEventInput,
    options: SwarmLiveAppendOptions,
    parentAuthorized = false
  ): Promise<SwarmLiveAppendResult> {
    if (input.type === "SWARM_VERIFIED" && !parentAuthorized) {
      throw new SwarmLiveStoreError(
        "PARENT_VERIFIED_AUTHORITY_REQUIRED",
        "SWARM_VERIFIED may only be persisted by the parent/global verifier pipeline."
      );
    }
    if (!validateSwarmLiveRevision(options.expectedRevision)) {
      throw new SwarmLiveStoreError("INVALID_REVISION", "Expected revision must be a nonnegative safe integer.");
    }
    return withLocalWriter(this.storePaths.directory, async () => {
      const events = await loadAuthoritativeEvents(this.storePaths, this.plan);
      const snapshot = replaySnapshot(this.plan, events);
      const duplicate = events.find((event) => event.idempotencyKey === input.idempotencyKey);
      if (duplicate) {
        if (!isExactPersistedParentResultEvent(duplicate, input)) {
          throw new SwarmLiveStoreError(
            "IDEMPOTENCY_CONFLICT",
            "An idempotency key cannot identify two different swarm events.",
            { idempotencyKey: input.idempotencyKey }
          );
        }
        return { event: clone(duplicate), snapshot, duplicate: true };
      }
      if (snapshot.revision !== options.expectedRevision) {
        throw new SwarmLiveStoreError(
          "STALE_REVISION",
          "Live swarm state changed before this append.",
          { expectedRevision: options.expectedRevision, actualRevision: snapshot.revision }
        );
      }
      if (input.type === "SWARM_VERIFIED" && snapshot.cancellation) {
        throw new SwarmLiveStoreError(
          "CANCELLATION_PRECEDES_PARENT_VERIFIED",
          "A durable cancellation request precedes the parent verified claim."
        );
      }
      const event = materializeEvent(this.plan, input, snapshot.lastSequence + 1);
      const validation = validateSwarmLiveEvent(event, this.plan);
      if (!validation.ok) {
        throw new SwarmLiveStoreError("INVALID_EVENT", "Live swarm event validation failed.", {
          errors: validation.errors
        });
      }
      await publishEventClaim(this.storePaths.eventClaims, event);
      const next = reduceSnapshot(snapshot, event);
      await Promise.all([
        writeEventJournalAtomic(this.storePaths.events, [...events, event]),
        writeDerivedJsonAtomic(this.storePaths.snapshot, next)
      ]);
      this.notify(next);
      return { event: clone(event), snapshot: clone(next), duplicate: false };
    });
  }

  async requestCancellation(
    request: SwarmCancellationRequest & { idempotencyKey: string },
    options: SwarmLiveAppendOptions
  ): Promise<SwarmLiveAppendResult> {
    return this.append({
      idempotencyKey: request.idempotencyKey,
      type: "SWARM_CANCEL_REQUESTED",
      timestamp: request.requestedAt,
      payload: {
        reason: request.reason,
        ...(request.requestedBy === undefined ? {} : { requestedBy: request.requestedBy })
      }
    }, options);
  }

  async readSnapshot(): Promise<SwarmLiveSnapshot> {
    return replaySnapshot(this.plan, await loadAuthoritativeEvents(this.storePaths, this.plan));
  }

  async readEvents(): Promise<SwarmLiveEvent[]> {
    return (await loadAuthoritativeEvents(this.storePaths, this.plan)).map(clone);
  }

  async waitForRevision(afterRevision: number, signal?: AbortSignal): Promise<SwarmLiveSnapshot> {
    if (!validateSwarmLiveRevision(afterRevision)) {
      throw new SwarmLiveStoreError("INVALID_REVISION", "Wait revision must be a nonnegative safe integer.");
    }
    if (signal?.aborted) throw abortError(signal.reason);
    return new Promise<SwarmLiveSnapshot>((resolvePromise, rejectPromise) => {
      let settled = false;
      let watcher: FSWatcher | undefined;
      let polling: ReturnType<typeof setInterval> | undefined;
      const listener = (snapshot: SwarmLiveSnapshot): void => {
        if (settled || snapshot.revision <= afterRevision) return;
        settled = true;
        cleanup();
        resolvePromise(clone(snapshot));
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(abortError(signal?.reason));
      };
      const cleanup = (): void => {
        this.#listeners.delete(listener);
        signal?.removeEventListener("abort", onAbort);
        watcher?.close();
        if (polling !== undefined) clearInterval(polling);
      };
      const refresh = (): void => {
        void this.readSnapshot().then(listener, (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          rejectPromise(error);
        });
      };
      this.#listeners.add(listener);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      if (settled) return;
      watcher = watch(this.storePaths.eventClaims, { persistent: false }, refresh);
      watcher.on("error", refresh);
      polling = setInterval(refresh, 100);
      polling.unref?.();
      refresh();
    });
  }

  private notify(snapshot: SwarmLiveSnapshot): void {
    for (const listener of [...this.#listeners]) listener(snapshot);
  }
}

function materializeEvent(
  plan: SwarmLivePlan,
  input: SwarmLiveEventInput,
  sequence: number
): SwarmLiveEvent {
  return {
    schemaVersion: SWARM_SCHEMA_VERSION,
    sequence,
    idempotencyKey: input.idempotencyKey,
    type: input.type,
    swarmId: plan.swarmId,
    timestamp: input.timestamp,
    parentPolicyVersion: plan.parentContract.policyVersion,
    planHash: plan.planHash,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    ...(input.childRunId === undefined ? {} : { childRunId: input.childRunId }),
    ...(input.failureClass === undefined ? {} : { failureClass: input.failureClass }),
    payload: clone(input.payload)
  };
}

function replaySnapshot(plan: SwarmLivePlan, events: SwarmLiveEvent[]): SwarmLiveSnapshot {
  let snapshot: SwarmLiveSnapshot = {
    schemaVersion: SWARM_SCHEMA_VERSION,
    swarmId: plan.swarmId,
    planHash: plan.planHash,
    revision: 0,
    lastSequence: 0,
    eventCount: 0,
    outcome: {
      state: "running",
      reason: "Live swarm execution has not reached a parent terminal decision."
    },
    updatedAt: plan.createdAt
  };
  for (const event of events) snapshot = reduceSnapshot(snapshot, event);
  return snapshot;
}

function reduceSnapshot(snapshot: SwarmLiveSnapshot, event: SwarmLiveEvent): SwarmLiveSnapshot {
  const next: SwarmLiveSnapshot = {
    ...snapshot,
    revision: snapshot.revision + 1,
    lastSequence: event.sequence,
    eventCount: snapshot.eventCount + 1,
    lastEventType: event.type,
    updatedAt: event.timestamp,
    outcome: { ...snapshot.outcome },
    ...(snapshot.cancellation ? { cancellation: { ...snapshot.cancellation } } : {})
  };
  if (event.type === "SWARM_CANCEL_REQUESTED") {
    next.cancellation = {
      requestedAt: event.timestamp,
      reason: textPayload(event.payload.reason, "operator_requested"),
      ...(typeof event.payload.requestedBy === "string"
        ? { requestedBy: event.payload.requestedBy }
        : {})
    };
  } else if (event.type === "SWARM_STOPPED") {
    next.outcome = { state: "stopped", reason: textPayload(event.payload.reason, "Parent stopped the swarm.") };
  } else if (event.type === "SWARM_NEEDS_REVIEW") {
    next.outcome = { state: "needs_review", reason: textPayload(event.payload.reason, "Parent review is required.") };
  } else if (event.type === "SWARM_VERIFIED") {
    next.outcome = {
      state: "verified",
      reason: textPayload(event.payload.reason, "Parent/global verifier passed."),
      verifiedAt: event.timestamp
    };
  }
  return next;
}

async function loadAuthoritativeEvents(
  paths: SwarmLiveStorePaths,
  plan: SwarmLivePlan
): Promise<SwarmLiveEvent[]> {
  return (await loadAuthoritativeEventClaims(paths, plan)).events;
}

async function loadAuthoritativeEventClaims(
  paths: SwarmLiveStorePaths,
  plan: SwarmLivePlan,
  options: { strictEntries?: boolean } = {}
): Promise<{
  events: SwarmLiveEvent[];
  claims: Array<{ path: string; bytes: Buffer }>;
}> {
  let entries: string[];
  try {
    entries = await readdir(paths.eventClaims);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      if (options.strictEntries) {
        throw new SwarmLiveStoreError("MISSING_EVENT_CLAIMS", "Immutable event claim directory is missing.");
      }
      return { events: [], claims: [] };
    }
    throw error;
  }
  const invalidEntries = entries.filter((value) => !/^\d{12}\.json$/u.test(value));
  if (options.strictEntries && invalidEntries.length > 0) {
    throw new SwarmLiveStoreError("MALFORMED_EVENT_CLAIMS", "Event claim directory contains non-canonical entries.", {
      entries: invalidEntries.sort()
    });
  }
  const authoritative: SwarmLiveEvent[] = [];
  const claims: Array<{ path: string; bytes: Buffer }> = [];
  const idempotencyKeys = new Set<string>();
  for (const entry of entries.filter((value) => /^\d{12}\.json$/u.test(value)).sort()) {
    const claimPath = resolve(paths.eventClaims, entry);
    const claimBytes = await readRequiredBytes(claimPath, "MISSING_EVENT_CLAIM");
    const claim = parseRequiredJson<SwarmLiveEvent>(claimBytes, claimPath);
    validatePersistedEvent(claim, plan, `event claim ${entry}`);
    const expectedSequence = authoritative.length + 1;
    const expectedEntry = `${String(expectedSequence).padStart(12, "0")}.json`;
    if (
      entry !== expectedEntry
      || claim.sequence !== expectedSequence
      || idempotencyKeys.has(claim.idempotencyKey)
    ) {
      throw new SwarmLiveStoreError("EVENT_CLAIM_GAP", "Immutable event claims must form a contiguous revision chain.", {
        expectedSequence,
        actualSequence: claim.sequence,
        entry
      });
    }
    idempotencyKeys.add(claim.idempotencyKey);
    authoritative.push(claim);
    claims.push({ path: claimPath, bytes: claimBytes });
  }
  return { events: authoritative, claims };
}

function validatePersistedEvent(event: SwarmLiveEvent, plan: SwarmLivePlan, source: string): void {
  if (
    event.type === "SWARM_VERIFIED"
    && (
      event.payload.parentPipelineAuthority !== "runParentSwarmPipeline:v1"
      || typeof event.payload.parentPipelineResultSha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(event.payload.parentPipelineResultSha256)
    )
  ) {
    throw new SwarmLiveStoreError(
      "PARENT_VERIFIED_AUTHORITY_REQUIRED",
      `Generic operational ${source} cannot authorize SWARM_VERIFIED.`
    );
  }
  const validation = validateSwarmLiveEvent(event, plan);
  if (!validation.ok) {
    throw new SwarmLiveStoreError("MALFORMED_EVENT_LOG", `Invalid persisted swarm event in ${source}.`, {
      errors: validation.errors
    });
  }
}

async function publishEventClaim(directory: string, event: SwarmLiveEvent): Promise<void> {
  await mkdir(directory, { recursive: true });
  const claimPath = resolve(directory, `${String(event.sequence).padStart(12, "0")}.json`);
  const temporary = resolve(
    directory,
    `.${String(event.sequence).padStart(12, "0")}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx");
    await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, claimPath);
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        throw new SwarmLiveStoreError("STALE_REVISION", "Live swarm state changed before this append.", {
          expectedRevision: event.sequence - 1,
          actualRevision: event.sequence
        });
      }
      throw error;
    }
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

async function withLocalWriter<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const prior = writerQueues.get(directory) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const turn = new Promise<void>((resolvePromise) => {
    releaseQueue = resolvePromise;
  });
  const queued = prior.catch(() => undefined).then(() => turn);
  writerQueues.set(directory, queued);
  await prior.catch(() => undefined);
  try {
    return await action();
  } finally {
    releaseQueue();
    if (writerQueues.get(directory) === queued) writerQueues.delete(directory);
  }
}

function resolveStorePaths(rootDir: string, swarmId: string): SwarmLiveStorePaths {
  if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(swarmId)) {
    throw new SwarmLiveStoreError("INVALID_SWARM_ID", "Swarm id is not safe for a contained store path.");
  }
  const directory = resolve(rootDir, "_swarms", swarmId);
  return resolveStorePathsAtDirectory(directory, swarmId);
}

function resolveStorePathsAtDirectory(directory: string, swarmId: string): SwarmLiveStorePaths {
  if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(swarmId)) {
    throw new SwarmLiveStoreError("INVALID_SWARM_ID", "Swarm id is not safe for a contained store path.");
  }
  return {
    directory,
    plan: resolve(directory, "plan.json"),
    events: resolve(directory, "events.jsonl"),
    snapshot: resolve(directory, "snapshot.json"),
    startClaim: resolve(directory, "start-claim.json"),
    writerLock: resolve(directory, "writer.lock"),
    eventClaims: resolve(directory, "event-claims")
  };
}

function assertValidPlan(plan: SwarmLivePlan): void {
  const validation = validateSwarmLivePlan(plan);
  if (!validation.ok) {
    throw new SwarmLiveStoreError("INVALID_PLAN", "Live swarm plan validation failed.", {
      errors: validation.errors
    });
  }
}

async function publishJsonIfAbsent(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx");
    await handle.writeFile(jsonText(value), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, path);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

async function writeDerivedJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, jsonText(value), { contentionSafe: true });
}

async function writeEventJournalAtomic(path: string, events: SwarmLiveEvent[]): Promise<void> {
  await writeTextAtomic(
    path,
    eventJournalText(events),
    { contentionSafe: true }
  );
}

async function writeTextAtomic(
  path: string,
  value: string,
  options: { contentionSafe?: boolean } = {}
): Promise<void> {
  if (options.contentionSafe && await readTextIfPresent(path) === value) return;
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx");
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await rename(temporary, path);
    } catch (error) {
      if (!options.contentionSafe || !isDerivedViewContention(error)) throw error;
      // Claims are authoritative. A competing reconciler may win the derived-view
      // replacement without being allowed to block or roll back live state.
    }
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function isDerivedViewContention(error: unknown): boolean {
  return isNodeError(error, "EPERM") || isNodeError(error, "EACCES") || isNodeError(error, "EBUSY");
}

async function readJsonIfPresent<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    if (error instanceof SyntaxError) {
      throw new SwarmLiveStoreError("MALFORMED_JSON", `Malformed JSON at ${path}.`);
    }
    throw error;
  }
}

async function readRequiredJson<T>(path: string, code: string): Promise<T> {
  const value = await readJsonIfPresent<T>(path);
  if (value === undefined) throw new SwarmLiveStoreError(code, `Required swarm store file is missing: ${path}`);
  return value;
}

async function readRequiredBytes(path: string, code: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new SwarmLiveStoreError(code, `Required swarm store file is missing: ${path}`);
    }
    throw error;
  }
}

function parseRequiredJson<T>(bytes: Buffer, path: string): T {
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SwarmLiveStoreError("MALFORMED_JSON", `Malformed JSON at ${path}.`);
    }
    throw error;
  }
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function eventJournalText(events: SwarmLiveEvent[]): string {
  return events.length === 0 ? "" : `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

/** Internal replay identity seam; intentionally not exported from the Core root. */
export function isExactPersistedParentResultEvent(
  event: SwarmLiveEvent,
  input: SwarmLiveEventInput
): boolean {
  return event.idempotencyKey === input.idempotencyKey
    && event.type === input.type
    && event.timestamp === input.timestamp
    && event.taskId === input.taskId
    && event.agentId === input.agentId
    && event.childRunId === input.childRunId
    && event.failureClass === input.failureClass
    && JSON.stringify(event.payload) === JSON.stringify(input.payload);
}

const PARENT_INTEGRATION_EVENT_TYPES = new Set<SwarmEventType>([
  "CHILD_PATCH_ADMITTED",
  "CHILD_PATCH_REJECTED",
  "INTEGRATION_CONFLICT",
  "INTEGRATION_COMPLETED"
]);

function isParentIntegrationEvent(event: SwarmEvent): boolean {
  return PARENT_INTEGRATION_EVENT_TYPES.has(event.type);
}

function isParentRecordTerminalEvent(event: SwarmEvent): boolean {
  return event.type === "SWARM_STOPPED"
    || event.type === "SWARM_NEEDS_REVIEW"
    || event.type === "SWARM_VERIFIED";
}

function isPersistedParentPipelineEvent(event: SwarmLiveEvent): boolean {
  return event.idempotencyKey.startsWith("parent-integration:")
    || event.idempotencyKey.startsWith(`parent-global-verifier:${event.swarmId}:`)
    || event.idempotencyKey.startsWith(`parent-outcome:${event.swarmId}:`);
}

function sameRecordEvent(
  event: SwarmLiveEvent,
  recordEvent: SwarmEvent | undefined
): boolean {
  if (!recordEvent) return false;
  const typedRecordEvent = recordEvent as SwarmEvent & { failureClass?: FailureClass };
  const identityMatches = event.type === recordEvent.type
    && event.swarmId === recordEvent.swarmId
    && event.timestamp === recordEvent.timestamp
    && event.parentPolicyVersion === recordEvent.parentPolicyVersion
    && event.taskId === recordEvent.taskId
    && event.agentId === recordEvent.agentId
    && event.childRunId === recordEvent.childRunId
    && event.failureClass === typedRecordEvent.failureClass;
  return identityMatches
    && JSON.stringify(event.payload) === JSON.stringify(recordEvent.payload);
}

function canonicalUndurableBootstrapOffset(
  record: RunParentSwarmPipelineResult["record"],
  durablePrefix: readonly SwarmLiveEvent[]
): 0 | 1 {
  const bootstrap = record.events[0];
  if (
    durablePrefix.length === 0
    || !bootstrap
    || bootstrap.type !== "SWARM_CREATED"
    || bootstrap.swarmId !== record.swarmId
    || bootstrap.parentPolicyVersion !== record.parentContract.policyVersion
    || JSON.stringify(bootstrap.payload) !== "{}"
    || bootstrap.taskId !== undefined
    || bootstrap.agentId !== undefined
    || bootstrap.childRunId !== undefined
    || Date.parse(bootstrap.timestamp) > Date.parse(durablePrefix[0]!.timestamp)
    || !sameRecordEvent(durablePrefix[0]!, record.events[1])
  ) return 0;
  return 1;
}

function recordEventInput(event: SwarmEvent, idempotencyKey: string): SwarmLiveEventInput {
  const typedEvent = event as SwarmEvent & { failureClass?: FailureClass };
  return {
    idempotencyKey,
    type: event.type,
    timestamp: event.timestamp,
    ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
    ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
    ...(event.childRunId === undefined ? {} : { childRunId: event.childRunId }),
    ...(typedEvent.failureClass === undefined ? {} : { failureClass: typedEvent.failureClass }),
    payload: clone(event.payload)
  };
}

function assertAuthorizedParentEventSequence(
  result: RunParentSwarmPipelineResult,
  events: readonly SwarmEvent[],
  terminalType: "SWARM_STOPPED" | "SWARM_NEEDS_REVIEW" | "SWARM_VERIFIED"
): void {
  let phase: "integration" | "verifier" | "terminal" = "integration";
  const admittedCandidateIds: string[] = [];
  const seenCandidateIds = new Set<string>();
  let integrationCompleted = false;
  for (const event of events) {
    if (
      event.swarmId !== result.record.swarmId
      || event.parentPolicyVersion !== result.record.parentContract.policyVersion
    ) {
      throw parentPipelineEventMismatch("Parent event identity does not match the authorized record.");
    }
    if (isParentIntegrationEvent(event)) {
      if (phase !== "integration") {
        throw parentPipelineEventMismatch("Integration events must precede verifier and terminal events.");
      }
      if (event.type === "INTEGRATION_COMPLETED") {
        if (integrationCompleted) {
          throw parentPipelineEventMismatch("Integration completion may be persisted only once.");
        }
        integrationCompleted = true;
      }
      assertIntegrationEventBinding(result, event, admittedCandidateIds, seenCandidateIds);
      continue;
    }
    if (event.type === "GLOBAL_VERIFIER_PASSED" || event.type === "GLOBAL_VERIFIER_FAILED") {
      if (phase !== "integration") {
        throw parentPipelineEventMismatch("The parent result contains a repeated or reordered verifier event.");
      }
      phase = "verifier";
      continue;
    }
    if (isParentRecordTerminalEvent(event)) {
      if (phase === "terminal" || event.type !== terminalType || event !== events.at(-1)) {
        throw parentPipelineEventMismatch("The parent terminal event is missing, contradictory, or reordered.");
      }
      phase = "terminal";
      continue;
    }
    throw parentPipelineEventMismatch("The parent result contains an event outside the closed integration sequence.");
  }
  if (JSON.stringify(admittedCandidateIds) !== JSON.stringify(result.integration.admittedCandidateIds)) {
    throw parentPipelineEventMismatch("Admitted integration events do not match the authorized candidate order.");
  }
}

function assertIntegrationEventBinding(
  result: RunParentSwarmPipelineResult,
  event: SwarmEvent,
  admittedCandidateIds: string[],
  seenCandidateIds: Set<string>
): void {
  if (event.type === "INTEGRATION_COMPLETED") {
    if (
      !result.integration.completed
      || (event.payload.integratedTreeHash !== result.integration.finalTreeHash
        && event.payload.finalTreeHash !== result.integration.finalTreeHash)
    ) {
      throw parentPipelineEventMismatch("Integration completion does not bind the authorized final tree.");
    }
    return;
  }
  const candidateId = event.payload.candidateId;
  if (typeof candidateId !== "string" || candidateId.trim().length === 0 || seenCandidateIds.has(candidateId)) {
    throw parentPipelineEventMismatch("Integration candidate identity is missing or replayed.");
  }
  seenCandidateIds.add(candidateId);
  const task = result.record.tasks.find((entry) => entry.taskId === event.taskId);
  const agent = result.record.agents.find((entry) => entry.agentId === event.agentId);
  if (!task || !agent || !event.childRunId || agent.childRunId !== event.childRunId) {
    throw parentPipelineEventMismatch("Integration event task, agent, or child identity is not in the authorized record.");
  }
  if (event.type === "CHILD_PATCH_ADMITTED") {
    if (!result.integration.admittedCandidateIds.includes(candidateId)) {
      throw parentPipelineEventMismatch("Admitted integration event is absent from the authorized candidate set.");
    }
    admittedCandidateIds.push(candidateId);
    return;
  }
  if (result.integration.admittedCandidateIds.includes(candidateId)) {
    throw parentPipelineEventMismatch("A candidate cannot be both admitted and rejected by the parent result.");
  }
  if (event.type === "INTEGRATION_CONFLICT" && !result.record.conflicts.some((conflict) => (
    conflict.candidateId === candidateId
    && conflict.agentId === event.agentId
    && conflict.childRunId === event.childRunId
    && conflict.taskIds.includes(event.taskId ?? "")
  ))) {
    throw parentPipelineEventMismatch("Integration conflict does not match the authorized conflict record.");
  }
}

function parentPipelineEventMismatch(message: string): SwarmLiveStoreError {
  return new SwarmLiveStoreError("PARENT_PIPELINE_EVENT_MISMATCH", message);
}

function textPayload(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function isParentTerminalEvent(event: SwarmLiveEvent): boolean {
  return event.type === "SWARM_STOPPED"
    || event.type === "SWARM_NEEDS_REVIEW"
    || event.type === "SWARM_VERIFIED";
}

function abortError(reason: unknown): Error {
  const error = new Error(reason instanceof Error ? reason.message : "Live swarm revision wait was aborted.");
  error.name = "AbortError";
  return error;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
