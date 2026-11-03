import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import {
  readExitSignal,
  readActiveRunExecutionLease,
  writeExitSignal,
  type RunControlApplication,
  type RunControlSnapshot,
  type RunControlSource
} from "@martin/core";

import {
  invalidArgumentsError,
  storeUnreadableError,
  unsupportedOperationError
} from "./tool-errors.js";
import { loadDetailedLoopRecord, type DetailedLoopSource } from "./run-store.js";

export type MartinControlAction = "pause" | "cancel" | "continue";

export interface MartinRunControlRequestInput {
  file?: string;
  loopId?: string;
  runsDir?: string;
  latest?: boolean;
  reason?: string;
  /** Injected by the server; never accepted from MCP tool arguments. */
  authority?: { transport: "local_stdio" | "untrusted_remote" };
}

export interface MartinRunControlReceipt {
  schemaVersion: "martin.run-control.v2";
  controlId: string;
  loopId: string;
  action: MartinControlAction;
  requestedAt: string;
  authorityBoundary: "local_os_user";
  principal: "local_mcp_client";
  executorLeaseToken: string;
  workspaceId?: string;
  projectId?: string;
  expectedPreviousControlId?: string;
  reason?: string;
  previousReceiptHash?: string;
  receiptHash: string;
}

interface RunControlPublication {
  schemaVersion: "martin.run-control-publication.v1";
  loopId: string;
  controlId: string;
  receiptHash: string;
  signalState: "created" | "already_exists";
  recordedAt: string;
  previousPublicationHash?: string;
  publicationHash: string;
}

interface StoredRunControlApplication extends RunControlApplication {
  schemaVersion: "martin.run-control-application.v2";
  previousApplicationHash?: string;
  applicationHash: string;
}

interface RunTerminalIntent {
  schemaVersion: "martin.run-terminal-intent.v1";
  loopId: string;
  recordedAt: string;
  intentHash: string;
}

export interface MartinRunControlState {
  requestedState: "active" | "paused" | "cancellation_requested" | "terminal";
  latestReceipt?: MartinRunControlReceipt;
  approvalState: "not_required" | "resume_requested";
  appliedState: "active" | "paused" | "cancellation_pending" | "terminal";
  receipts: MartinRunControlReceipt[];
  applications: StoredRunControlApplication[];
  publications: RunControlPublication[];
  receiptPath?: string;
  applicationPath?: string;
}

export interface MartinRunControlOutput {
  ok: boolean;
  summary: string;
  loopId: string;
  requestedAction: MartinControlAction;
  state: MartinRunControlState;
  // The receipt recorded by this request.
  action: MartinControlAction;
  controlId: string;
  requestedAt: string;
  publicationState: "published" | "already_requested" | "receipt_recorded" | "published_audit_pending";
  applicationState: "pending_observation" | "requested_only" | "terminal_reconciled";
  reason?: string;
  authorityBoundary: "local_os_user";
  principal: "local_mcp_client";
  receiptHash: string;
}

export async function createRunControlReceipt(
  action: MartinControlAction,
  input: MartinRunControlRequestInput,
  testHooks?: {
    beforeLockedReload?: () => Promise<void>;
    afterJournalOpen?: (journalPath: string) => Promise<void>;
    lockMaxRetries?: number;
  }
): Promise<MartinRunControlOutput> {
  if (input.authority?.transport !== "local_stdio") {
    throw unsupportedOperationError(
      "Run controls are available only over the local stdio transport.",
      "Use a local MartinLoop MCP stdio session; remote HTTP control requires authenticated principal support."
    );
  }
  const initialDetail = await loadDetailedLoopRecord(input);
  if (!initialDetail.canonicalRunDirectory) {
    throw unsupportedOperationError(
      "Run control receipts require a canonical run directory.",
      "Use a canonical loopId-backed Martin run before writing control receipts."
    );
  }
  return withRunControlLock(
    initialDetail.canonicalRunDirectory,
    async () => {
      await testHooks?.beforeLockedReload?.();
      const detail = await loadDetailedLoopRecord(input);
      if (detail.canonicalRunDirectory !== initialDetail.canonicalRunDirectory) {
        throw controlReceiptIntegrityError();
      }
      return createRunControlReceiptLocked(action, input, detail, testHooks);
    },
    testHooks?.lockMaxRetries
  );
}

async function createRunControlReceiptLocked(
  action: MartinControlAction,
  input: MartinRunControlRequestInput,
  detail: DetailedLoopSource,
  _testHooks?: { afterJournalOpen?: (journalPath: string) => Promise<void> }
): Promise<MartinRunControlOutput> {
  if (!detail.canonicalRunDirectory) {
    throw unsupportedOperationError(
      "Run control receipts require a canonical run directory.",
      "Use a canonical loopId-backed Martin run before writing control receipts."
    );
  }
  if (isTerminalRun(detail.loop)) {
    throw unsupportedOperationError(
      `Run ${detail.loop.loopId} is already terminal and cannot accept ${action}.`,
      "Inspect the terminal run evidence instead of recording a new control request."
    );
  }
  if (await readRunTerminalIntent(detail.canonicalRunDirectory, detail.loop.loopId)) {
    throw unsupportedOperationError(
      `Run ${detail.loop.loopId} is entering terminal persistence and cannot accept ${action}.`,
      "Inspect the terminal run evidence instead of recording a new control request."
    );
  }
  const executionLease = await readActiveRunExecutionLease({
    runsRoot: detail.runsRoot,
    runId: detail.loop.loopId
  }).catch(() => undefined);
  if (!executionLease) {
    throw unsupportedOperationError(
      `Run ${detail.loop.loopId} has no live control-capable executor lease.`,
      "Start or resume the run through a supported MartinLoop executor before requesting controls."
    );
  }

  const priorState = await readRunControlStateUnlocked(detail);
  const priorCancellation = priorState.receipts.find((candidate) => candidate.action === "cancel");
  if (action === "cancel" && priorCancellation) {
    return publishCancellation(detail, priorCancellation, priorState, _testHooks);
  }
  if (action === "pause" && priorState.requestedState === "paused") {
    throw unsupportedOperationError(
      "The run already has a pending pause request.",
      "Continue the existing pause before requesting another pause."
    );
  }
  if (action === "pause" && priorState.appliedState === "paused") {
    throw unsupportedOperationError(
      "The previous pause is still applied by the executor.",
      "Wait until the matching continue application is visible before requesting another pause."
    );
  }
  if (action !== "cancel" && priorState.requestedState === "cancellation_requested") {
    throw unsupportedOperationError(
      "The run already has a cancellation request.",
      "Wait for the active executor to record terminal cancellation evidence."
    );
  }
  const expectedPreviousControlId =
    action === "continue"
      ? requirePendingPauseControlId(priorState)
      : undefined;

  const unsignedReceipt = {
    schemaVersion: "martin.run-control.v2" as const,
    controlId: `ctl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    loopId: detail.loop.loopId,
    action,
    requestedAt: nextControlRequestedAt(priorState),
    authorityBoundary: "local_os_user" as const,
    principal: "local_mcp_client" as const,
    executorLeaseToken: executionLease.lease.token,
    ...(typeof detail.loop.workspaceId === "string" ? { workspaceId: detail.loop.workspaceId } : {}),
    ...(expectedPreviousControlId ? { expectedPreviousControlId } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(priorState.receipts.at(-1)?.receiptHash
      ? { previousReceiptHash: priorState.receipts.at(-1)!.receiptHash }
      : {})
  };
  const receipt: MartinRunControlReceipt = {
    ...unsignedReceipt,
    receiptHash: hashCanonical(unsignedReceipt)
  };

  const currentDetail = await loadDetailedLoopRecord(input);
  if (
    currentDetail.canonicalRunDirectory !== detail.canonicalRunDirectory ||
    isTerminalRun(currentDetail.loop) ||
    await readRunTerminalIntent(detail.canonicalRunDirectory, detail.loop.loopId)
  ) {
    throw unsupportedOperationError(
      `Run ${detail.loop.loopId} is already terminal and cannot accept ${action}.`,
      "Inspect the terminal run evidence instead of recording a new control request."
    );
  }
  const currentLease = await readActiveRunExecutionLease({
    runsRoot: currentDetail.runsRoot,
    runId: currentDetail.loop.loopId
  });
  if (currentLease?.lease.token !== executionLease.lease.token) {
    throw controlReceiptIntegrityError();
  }
  const receiptPath = path.join(detail.canonicalRunDirectory, "controls.jsonl");
  await safeAppendJournal(
    detail.canonicalRunDirectory,
    receiptPath,
    `${JSON.stringify(receipt)}\n`,
    _testHooks?.afterJournalOpen
  );
  const receiptState = await readRunControlStateUnlocked(detail);
  if (action === "cancel") {
    return publishCancellation(detail, receipt, receiptState, _testHooks);
  }
  const latestDetail = await loadDetailedLoopRecord(input);
  const state = await readRunControlStateUnlocked(latestDetail);
  const terminal = isTerminalRun(latestDetail.loop);

  return {
    ok: true,
    summary:
      terminal
        ? `Run ${detail.loop.loopId} became terminal while the control was recorded; terminal evidence wins.`
        : action === "pause"
          ? `Pause requested for ${detail.loop.loopId}; application waits for the next safe attempt boundary.`
          : `Continue request bound to pause ${expectedPreviousControlId} for ${detail.loop.loopId}.`,
    loopId: detail.loop.loopId,
    requestedAction: action,
    state,
    action: receipt.action,
    controlId: receipt.controlId,
    requestedAt: receipt.requestedAt,
    publicationState: "receipt_recorded",
    applicationState: terminal ? "terminal_reconciled" : "requested_only",
    ...(receipt.reason ? { reason: receipt.reason } : {}),
    authorityBoundary: receipt.authorityBoundary,
    principal: receipt.principal,
    receiptHash: receipt.receiptHash
  };
}

async function publishCancellation(
  detail: DetailedLoopSource,
  receipt: MartinRunControlReceipt,
  state: MartinRunControlState,
  testHooks?: { afterJournalOpen?: (journalPath: string) => Promise<void> }
): Promise<MartinRunControlOutput> {
  const existingPublication = state.publications.find(
    (candidate) => candidate.controlId === receipt.controlId
  );
  const expectedSignal = {
    schemaVersion: "exit-signal/1" as const,
    kind: "human_interrupt" as const,
    runId: detail.loop.loopId,
    requestedAt: receipt.requestedAt,
    requestedBy: "local_mcp_client",
    reason: receipt.reason ?? "Cancellation requested through martin_cancel."
  };
  // A publication receipt never substitutes for the canonical signal. This
  // repairs a missing signal and fails closed if first-writer-wins preserved a
  // different signal payload in the canonical slot.
  const signalState = await writeExitSignal(detail.runsRoot, expectedSignal);
  const durableSignal = await readExitSignal(detail.runsRoot, detail.loop.loopId, "human_interrupt");
  if (
    !durableSignal ||
    durableSignal.schemaVersion !== expectedSignal.schemaVersion ||
    durableSignal.kind !== expectedSignal.kind ||
    durableSignal.runId !== expectedSignal.runId ||
    durableSignal.requestedAt !== expectedSignal.requestedAt ||
    durableSignal.requestedBy !== expectedSignal.requestedBy ||
    durableSignal.reason !== expectedSignal.reason
  ) {
    throw controlReceiptIntegrityError();
  }
  let publicationState: MartinRunControlOutput["publicationState"] = "already_requested";
  if (!existingPublication) {
    const previous = state.publications.at(-1);
    const unsigned = {
      schemaVersion: "martin.run-control-publication.v1" as const,
      loopId: receipt.loopId,
      controlId: receipt.controlId,
      receiptHash: receipt.receiptHash,
      signalState,
      recordedAt: new Date().toISOString(),
      ...(previous ? { previousPublicationHash: previous.publicationHash } : {})
    };
    const publication: RunControlPublication = {
      ...unsigned,
      publicationHash: hashCanonical(unsigned)
    };
    try {
      await safeAppendJournal(
        detail.canonicalRunDirectory!,
        path.join(detail.canonicalRunDirectory!, "control-publications.jsonl"),
        `${JSON.stringify(publication)}\n`,
        testHooks?.afterJournalOpen
      );
      publicationState = signalState === "created" ? "published" : "already_requested";
    } catch {
      publicationState = "published_audit_pending";
    }
  }
  const currentDetail = await loadDetailedLoopRecord({
    loopId: detail.loop.loopId,
    runsDir: detail.runsRoot
  });
  const currentState = await readRunControlStateUnlocked(currentDetail);
  const terminal = isTerminalRun(currentDetail.loop) || currentState.requestedState === "terminal";
  return {
    ok: true,
    summary: terminal
      ? `Run ${detail.loop.loopId} is terminal; terminal evidence wins over pending cancellation state.`
      : publicationState === "published_audit_pending"
        ? `Cancellation signal is live for ${detail.loop.loopId}; publication audit is pending a safe retry.`
        : `Cancellation signal is authoritative for ${detail.loop.loopId}; executor observation is pending.`,
    loopId: detail.loop.loopId,
    requestedAction: "cancel",
    state: currentState,
    action: "cancel",
    controlId: receipt.controlId,
    requestedAt: receipt.requestedAt,
    publicationState,
    applicationState: terminal ? "terminal_reconciled" : "pending_observation",
    ...(receipt.reason ? { reason: receipt.reason } : {}),
    authorityBoundary: receipt.authorityBoundary,
    principal: receipt.principal,
    receiptHash: receipt.receiptHash
  };
}

export async function readRunControlState(
  detailOrInput: DetailedLoopSource | MartinRunControlRequestInput
): Promise<MartinRunControlState> {
  const detail =
    isDetailedLoopSource(detailOrInput)
      ? detailOrInput
      : await loadDetailedLoopRecord(detailOrInput);

  return detail.canonicalRunDirectory
    ? withRunControlLock(detail.canonicalRunDirectory, () => readRunControlStateUnlocked(detail))
    : readRunControlStateUnlocked(detail);
}

async function readRunControlStateUnlocked(
  detail: DetailedLoopSource
): Promise<MartinRunControlState> {
  const receiptPath = detail.canonicalRunDirectory
    ? path.join(detail.canonicalRunDirectory, "controls.jsonl")
    : undefined;
  const receipts = receiptPath
    ? await readControlReceipts(receiptPath, detail.loop.loopId)
    : [];
  const applicationPath = detail.canonicalRunDirectory
    ? path.join(detail.canonicalRunDirectory, "control-applications.jsonl")
    : undefined;
  const applications = applicationPath
    ? await readRunControlApplications(applicationPath, detail.loop.loopId)
    : [];
  const publicationPath = detail.canonicalRunDirectory
    ? path.join(detail.canonicalRunDirectory, "control-publications.jsonl")
    : undefined;
  const publications = publicationPath
    ? await readRunControlPublications(publicationPath, detail.loop.loopId)
    : [];
  const terminalIntent = detail.canonicalRunDirectory
    ? await readRunTerminalIntent(detail.canonicalRunDirectory, detail.loop.loopId)
    : undefined;
  const latestReceipt = receipts.at(-1);
  const snapshot = resolveRunControlSnapshot(receipts);
  const reconciledAppliedState = reconcileRunControlApplications(receipts, applications);
  reconcileRunControlPublications(receipts, publications);

  return {
    requestedState:
      isTerminalRun(detail.loop) || terminalIntent !== undefined
        ? "terminal"
        : latestReceipt?.action === "cancel"
        ? "cancellation_requested"
        : snapshot.pause
        ? "paused"
        : "active",
    ...(latestReceipt ? { latestReceipt } : {}),
    approvalState: "not_required",
    appliedState:
      isTerminalRun(detail.loop) || terminalIntent !== undefined
        ? "terminal"
        : latestReceipt?.action === "cancel"
        ? "cancellation_pending"
        : reconciledAppliedState,
    receipts,
    applications,
    publications,
    ...(receiptPath ? { receiptPath } : {}),
    ...(applicationPath ? { applicationPath } : {})
  };
}

function reconcileRunControlPublications(
  receipts: readonly MartinRunControlReceipt[],
  publications: readonly RunControlPublication[]
): void {
  const receiptsById = new Map(receipts.map((receipt) => [receipt.controlId, receipt] as const));
  const seen = new Set<string>();
  for (const publication of publications) {
    if (seen.has(publication.controlId)) throw controlReceiptIntegrityError();
    seen.add(publication.controlId);
    const receipt = receiptsById.get(publication.controlId);
    if (
      receipt?.action !== "cancel" ||
      publication.loopId !== receipt.loopId ||
      publication.receiptHash !== receipt.receiptHash
    ) {
      throw controlReceiptIntegrityError();
    }
  }
}

export function createFileRunControlSource(runsRoot: string): RunControlSource {
  return {
    async poll(runId): Promise<RunControlSnapshot> {
      const runDirectory = path.join(runsRoot, runId);
      const runDirectoryEntry = await lstat(runDirectory).catch((error: unknown) => {
        if (isNodeError(error, "ENOENT")) return undefined;
        throw storeUnreadableError();
      });
      if (!runDirectoryEntry) return {};
      if (!runDirectoryEntry.isDirectory() || runDirectoryEntry.isSymbolicLink()) {
        throw controlReceiptIntegrityError();
      }
      return withRunControlLock(runDirectory, async () => {
        if (await readRunTerminalIntent(runDirectory, runId)) return {};
        const receipts = await readControlReceipts(
          path.join(runDirectory, "controls.jsonl"),
          runId
        );
        return resolveRunControlSnapshot(receipts);
      });
    },
    async recordApplication(application): Promise<void> {
      const runDirectory = path.join(runsRoot, application.loopId);
      await withRunControlLock(runDirectory, async () => {
        const receiptPath = path.join(runDirectory, "controls.jsonl");
        const applicationPath = path.join(runDirectory, "control-applications.jsonl");
        const receipts = await readControlReceipts(receiptPath, application.loopId);
        resolveRunControlSnapshot(receipts);
        const existing = await readRunControlApplications(applicationPath, application.loopId);
        reconcileRunControlApplications(receipts, existing);
        if (
          existing.some(
            (candidate) =>
              candidate.controlId === application.controlId &&
              candidate.action === application.action
          )
        ) {
          return;
        }
        const previousApplicationHash = existing.at(-1)?.applicationHash;
        const unsigned = {
          schemaVersion: "martin.run-control-application.v2" as const,
          ...application,
          ...(previousApplicationHash ? { previousApplicationHash } : {})
        };
        const stored: StoredRunControlApplication = {
          ...unsigned,
          applicationHash: hashCanonical(unsigned)
        };
        reconcileRunControlApplications(receipts, [...existing, stored]);
        await safeAppendJournal(
          runDirectory,
          applicationPath,
          `${JSON.stringify(stored)}\n`
        );
      });
    },
    async recordTerminalIntent(runId): Promise<void> {
      const runDirectory = path.join(runsRoot, runId);
      await withRunControlLock(runDirectory, async () => {
        if (await readRunTerminalIntent(runDirectory, runId)) return;
        const unsigned = {
          schemaVersion: "martin.run-terminal-intent.v1" as const,
          loopId: runId,
          recordedAt: new Date().toISOString()
        };
        const intent: RunTerminalIntent = {
          ...unsigned,
          intentHash: hashCanonical(unsigned)
        };
        await safeAppendJournal(
          runDirectory,
          path.join(runDirectory, "terminal-intent.jsonl"),
          `${JSON.stringify(intent)}\n`
        );
      });
    }
  };
}

export function reconcileRunControlApplications(
  receipts: readonly MartinRunControlReceipt[],
  applications: readonly StoredRunControlApplication[]
): "active" | "paused" {
  const receiptPositions = new Map(
    receipts.map((receipt, index) => [receipt.controlId, { receipt, index }] as const)
  );
  const seenApplications = new Set<string>();
  let appliedPauseId: string | undefined;
  let lastReceiptPosition = -1;
  let lastAppliedAt = -Infinity;

  for (const application of applications) {
    const identity = `${application.action}:${application.controlId}`;
    if (seenApplications.has(identity)) throw controlReceiptIntegrityError();
    seenApplications.add(identity);

    const matched = receiptPositions.get(application.controlId);
    if (!matched || matched.index < lastReceiptPosition) throw controlReceiptIntegrityError();
    if (application.receiptHash !== matched.receipt.receiptHash) {
      throw controlReceiptIntegrityError();
    }
    const appliedAt = Date.parse(application.appliedAt);
    if (appliedAt < Date.parse(matched.receipt.requestedAt) || appliedAt < lastAppliedAt) {
      throw controlReceiptIntegrityError();
    }
    if (
      receipts
        .slice(matched.index + 1)
        .some((receipt) => Date.parse(receipt.requestedAt) <= appliedAt)
    ) {
      throw controlReceiptIntegrityError();
    }

    if (application.action === "pause_applied") {
      if (
        matched.receipt.action !== "pause" ||
        application.relatedControlId !== undefined ||
        appliedPauseId !== undefined
      ) {
        throw controlReceiptIntegrityError();
      }
      appliedPauseId = matched.receipt.controlId;
    } else {
      if (
        matched.receipt.action !== "continue" ||
        matched.receipt.expectedPreviousControlId !== application.relatedControlId ||
        appliedPauseId !== application.relatedControlId
      ) {
        throw controlReceiptIntegrityError();
      }
      appliedPauseId = undefined;
    }

    lastReceiptPosition = matched.index;
    lastAppliedAt = appliedAt;
  }

  return appliedPauseId ? "paused" : "active";
}

export function resolveRunControlSnapshot(
  receipts: readonly MartinRunControlReceipt[]
): RunControlSnapshot {
  type CooperativeReceipt = MartinRunControlReceipt & { action: "pause" | "continue" };
  let pause: CooperativeReceipt | undefined;
  let continuedBy: CooperativeReceipt | undefined;
  let cancellationRequested = false;
  const controlIds = new Set<string>();
  let lastRequestedAt = -Infinity;

  for (const receipt of receipts) {
    if (controlIds.has(receipt.controlId)) throw controlReceiptIntegrityError();
    controlIds.add(receipt.controlId);
    const requestedAt = Date.parse(receipt.requestedAt);
    if (requestedAt < lastRequestedAt) throw controlReceiptIntegrityError();
    lastRequestedAt = requestedAt;
    if (receipt.action === "cancel") {
      cancellationRequested = true;
      pause = undefined;
      continuedBy = undefined;
      continue;
    }
    if (cancellationRequested) {
      throw controlReceiptIntegrityError();
    }
    if (receipt.action === "pause") {
      if (pause) throw controlReceiptIntegrityError();
      pause = receipt as CooperativeReceipt;
      continuedBy = undefined;
      continue;
    }
    if (!pause || receipt.expectedPreviousControlId !== pause.controlId) {
      throw controlReceiptIntegrityError();
    }
    continuedBy = receipt as CooperativeReceipt;
    pause = undefined;
  }

  return {
    ...(pause ? { pause } : {}),
    ...(!pause && continuedBy ? { continuedBy } : {})
  };
}

export async function readRunControlApplications(
  applicationPath: string,
  expectedLoopId?: string
): Promise<StoredRunControlApplication[]> {
  let contents: string;
  try {
    contents = await safeReadJournal(path.dirname(applicationPath), applicationPath);
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw controlReceiptIntegrityError();
  }

  const applications: StoredRunControlApplication[] = [];
  for (const line of contents.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)) {
    let candidate: unknown;
    try {
      candidate = JSON.parse(line);
    } catch {
      throw controlReceiptIntegrityError();
    }
    if (!isRunControlApplication(candidate, expectedLoopId)) {
      throw controlReceiptIntegrityError();
    }
    const previous = applications.at(-1);
    if (candidate.previousApplicationHash !== previous?.applicationHash) {
      throw controlReceiptIntegrityError();
    }
    applications.push(candidate);
  }
  return applications;
}

export async function readControlReceipts(
  receiptPath: string,
  expectedLoopId?: string
): Promise<MartinRunControlReceipt[]> {
  let contents: string;
  try {
    contents = await safeReadJournal(path.dirname(receiptPath), receiptPath);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return [];
    }
    throw storeUnreadableError();
  }

  const receipts: MartinRunControlReceipt[] = [];
  for (const line of contents.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)) {
    let candidate: unknown;
    try {
      candidate = JSON.parse(line);
    } catch {
      throw controlReceiptIntegrityError();
    }

    if (!isRunControlReceipt(candidate)) {
      throw controlReceiptIntegrityError();
    }
    if (expectedLoopId !== undefined && candidate.loopId !== expectedLoopId) {
      throw controlReceiptIntegrityError();
    }
    const previous = receipts.at(-1);
    if (candidate.previousReceiptHash !== previous?.receiptHash) {
      throw controlReceiptIntegrityError();
    }
    receipts.push(candidate);
  }
  return receipts;
}

async function readRunControlPublications(
  publicationPath: string,
  expectedLoopId: string
): Promise<RunControlPublication[]> {
  let contents: string;
  try {
    contents = await safeReadJournal(path.dirname(publicationPath), publicationPath);
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw controlReceiptIntegrityError();
  }
  const publications: RunControlPublication[] = [];
  for (const line of contents.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)) {
    let candidate: unknown;
    try {
      candidate = JSON.parse(line);
    } catch {
      throw controlReceiptIntegrityError();
    }
    if (!isRunControlPublication(candidate, expectedLoopId)) {
      throw controlReceiptIntegrityError();
    }
    const previous = publications.at(-1);
    if (candidate.previousPublicationHash !== previous?.publicationHash) {
      throw controlReceiptIntegrityError();
    }
    publications.push(candidate);
  }
  return publications;
}

async function readRunTerminalIntent(
  runDirectory: string,
  expectedLoopId: string
): Promise<RunTerminalIntent | undefined> {
  const intentPath = path.join(runDirectory, "terminal-intent.jsonl");
  let contents: string;
  try {
    contents = await safeReadJournal(runDirectory, intentPath);
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    throw controlReceiptIntegrityError();
  }
  const lines = contents.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  if (lines.length !== 1) throw controlReceiptIntegrityError();
  let candidate: unknown;
  try {
    candidate = JSON.parse(lines[0]!);
  } catch {
    throw controlReceiptIntegrityError();
  }
  if (typeof candidate !== "object" || candidate === null) throw controlReceiptIntegrityError();
  const intent = candidate as Partial<RunTerminalIntent>;
  if (
    !hasOnlyOwnKeys(intent, ["schemaVersion", "loopId", "recordedAt", "intentHash"]) ||
    intent.schemaVersion !== "martin.run-terminal-intent.v1" ||
    intent.loopId !== expectedLoopId ||
    !isIsoTimestamp(intent.recordedAt) ||
    !isSha256(intent.intentHash)
  ) {
    throw controlReceiptIntegrityError();
  }
  const { intentHash, ...unsigned } = intent as RunTerminalIntent;
  if (intentHash !== hashCanonical(unsigned)) throw controlReceiptIntegrityError();
  return intent as RunTerminalIntent;
}

function isDetailedLoopSource(value: unknown): value is DetailedLoopSource {
  return typeof value === "object" && value !== null && "loop" in value && "runsRoot" in value;
}

function isTerminalRun(loop: DetailedLoopSource["loop"]): boolean {
  return (
    loop.terminationEnvelope !== undefined ||
    !["queued", "running", "verifying"].includes(loop.status) ||
    !["created", "running", "verifying"].includes(loop.lifecycleState)
  );
}

function isRunControlReceipt(value: unknown): value is MartinRunControlReceipt {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as {
    schemaVersion?: unknown;
    controlId?: unknown;
    loopId?: unknown;
    action?: unknown;
    requestedAt?: unknown;
    expectedPreviousControlId?: unknown;
    reason?: unknown;
    authorityBoundary?: unknown;
    principal?: unknown;
    executorLeaseToken?: unknown;
    workspaceId?: unknown;
    projectId?: unknown;
    previousReceiptHash?: unknown;
    receiptHash?: unknown;
  };
  const structurallyValid = (
    hasOnlyOwnKeys(candidate, [
      "schemaVersion",
      "controlId",
      "loopId",
      "action",
      "requestedAt",
      "authorityBoundary",
      "principal",
      "executorLeaseToken",
      "workspaceId",
      "projectId",
      "expectedPreviousControlId",
      "reason",
      "previousReceiptHash",
      "receiptHash"
    ]) &&
    candidate.schemaVersion === "martin.run-control.v2" &&
    isNonEmptyString(candidate.controlId) &&
    isNonEmptyString(candidate.loopId) &&
    isControlAction(candidate.action) &&
    isIsoTimestamp(candidate.requestedAt) &&
    (candidate.expectedPreviousControlId === undefined ||
      isNonEmptyString(candidate.expectedPreviousControlId)) &&
    (candidate.action === "continue"
      ? isNonEmptyString(candidate.expectedPreviousControlId)
      : candidate.expectedPreviousControlId === undefined) &&
    candidate.authorityBoundary === "local_os_user" &&
    candidate.principal === "local_mcp_client" &&
    isNonEmptyString(candidate.executorLeaseToken) &&
    (candidate.workspaceId === undefined || isNonEmptyString(candidate.workspaceId)) &&
    (candidate.projectId === undefined || isNonEmptyString(candidate.projectId)) &&
    (candidate.reason === undefined || isNonEmptyString(candidate.reason)) &&
    (candidate.previousReceiptHash === undefined || isSha256(candidate.previousReceiptHash)) &&
    isSha256(candidate.receiptHash)
  );
  if (!structurallyValid) return false;
  const { receiptHash, ...unsigned } = value as MartinRunControlReceipt;
  return receiptHash === hashCanonical(unsigned);
}

function isRunControlApplication(
  value: unknown,
  expectedLoopId?: string
): value is StoredRunControlApplication {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    schemaVersion?: unknown;
    loopId?: unknown;
    controlId?: unknown;
    action?: unknown;
    appliedAt?: unknown;
    relatedControlId?: unknown;
    receiptHash?: unknown;
    previousApplicationHash?: unknown;
    applicationHash?: unknown;
  };
  const structurallyValid = (
    hasOnlyOwnKeys(candidate, [
      "schemaVersion",
      "loopId",
      "controlId",
      "action",
      "appliedAt",
      "relatedControlId",
      "receiptHash",
      "previousApplicationHash",
      "applicationHash"
    ]) &&
    candidate.schemaVersion === "martin.run-control-application.v2" &&
    isNonEmptyString(candidate.loopId) &&
    (expectedLoopId === undefined || candidate.loopId === expectedLoopId) &&
    isNonEmptyString(candidate.controlId) &&
    (candidate.action === "pause_applied" || candidate.action === "continue_applied") &&
    isIsoTimestamp(candidate.appliedAt) &&
    (candidate.relatedControlId === undefined || isNonEmptyString(candidate.relatedControlId)) &&
    (candidate.action === "continue_applied"
      ? isNonEmptyString(candidate.relatedControlId)
      : candidate.relatedControlId === undefined) &&
    isSha256(candidate.receiptHash) &&
    (candidate.previousApplicationHash === undefined || isSha256(candidate.previousApplicationHash)) &&
    isSha256(candidate.applicationHash)
  );
  if (!structurallyValid) return false;
  const { applicationHash, ...unsigned } = value as StoredRunControlApplication;
  return applicationHash === hashCanonical(unsigned);
}

function isRunControlPublication(value: unknown, expectedLoopId: string): value is RunControlPublication {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RunControlPublication>;
  const structurallyValid =
    hasOnlyOwnKeys(candidate, [
      "schemaVersion",
      "loopId",
      "controlId",
      "receiptHash",
      "signalState",
      "recordedAt",
      "previousPublicationHash",
      "publicationHash"
    ]) &&
    candidate.schemaVersion === "martin.run-control-publication.v1" &&
    candidate.loopId === expectedLoopId &&
    isNonEmptyString(candidate.controlId) &&
    isSha256(candidate.receiptHash) &&
    (candidate.signalState === "created" || candidate.signalState === "already_exists") &&
    isIsoTimestamp(candidate.recordedAt) &&
    (candidate.previousPublicationHash === undefined || isSha256(candidate.previousPublicationHash)) &&
    isSha256(candidate.publicationHash);
  if (!structurallyValid) return false;
  const { publicationHash, ...unsigned } = value as RunControlPublication;
  return publicationHash === hashCanonical(unsigned);
}

function requirePendingPauseControlId(state: MartinRunControlState): string {
  const latest = state.latestReceipt;
  if (latest?.action !== "pause") {
    throw unsupportedOperationError(
      "Continue requires one pending pause request.",
      "Pause the active run first, then continue the exact pause returned by MartinLoop."
    );
  }
  return latest.controlId;
}

function nextControlRequestedAt(state: MartinRunControlState): string {
  let latestEvidenceMs = -Infinity;
  for (const receipt of state.receipts) {
    latestEvidenceMs = Math.max(latestEvidenceMs, Date.parse(receipt.requestedAt));
  }
  for (const application of state.applications) {
    latestEvidenceMs = Math.max(latestEvidenceMs, Date.parse(application.appliedAt));
  }
  return new Date(Math.max(Date.now(), latestEvidenceMs + 1)).toISOString();
}

function isControlAction(value: unknown): value is MartinControlAction {
  return value === "pause" || value === "cancel" || value === "continue";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOnlyOwnKeys(value: object, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function controlReceiptIntegrityError() {
  return storeUnreadableError("Run control receipt integrity check failed.");
}

function sameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint }
): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

async function assertSafeRunDirectory(runDirectory: string): Promise<void> {
  const parentDirectory = path.dirname(runDirectory);
  const parentEntry = await lstat(parentDirectory);
  if (!parentEntry.isDirectory() || parentEntry.isSymbolicLink()) throw controlReceiptIntegrityError();
  const entry = await lstat(runDirectory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw controlReceiptIntegrityError();
  const canonical = path.resolve(await realpath(runDirectory));
  const canonicalParent = path.resolve(await realpath(parentDirectory));
  // Compare the leaf against the canonical parent rather than the lexical
  // absolute path. macOS exposes /var through the trusted /private/var system
  // alias; canonicalizing the parent preserves that platform behavior while
  // still rejecting a linked runs-root or run-directory leaf.
  const expected = path.join(canonicalParent, path.basename(runDirectory));
  const isSamePath = process.platform === "win32"
    ? canonical.toLowerCase() === expected.toLowerCase()
    : canonical === expected;
  if (!isSamePath) {
    throw controlReceiptIntegrityError();
  }
}

async function safeReadJournal(runDirectory: string, journalPath: string): Promise<string> {
  await assertSafeRunDirectory(runDirectory);
  const before = await lstat(journalPath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw controlReceiptIntegrityError();
  }
  const handle = await open(journalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFileIdentity(before, opened)) {
      throw controlReceiptIntegrityError();
    }
    const contents = await handle.readFile({ encoding: "utf8" });
    const after = await lstat(journalPath);
    await assertSafeRunDirectory(runDirectory);
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || !sameFileIdentity(opened, after)) {
      throw controlReceiptIntegrityError();
    }
    return contents;
  } finally {
    await handle.close();
  }
}

async function safeAppendJournal(
  runDirectory: string,
  journalPath: string,
  contents: string,
  afterOpen?: (journalPath: string) => Promise<void>
): Promise<void> {
  await assertSafeRunDirectory(runDirectory);
  const before = await lstat(journalPath).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)) {
    throw controlReceiptIntegrityError();
  }
  const flags = constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0) |
    (before ? 0 : constants.O_CREAT | constants.O_EXCL);
  const handle = await open(journalPath, flags, 0o600);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || (before && !sameFileIdentity(before, opened))) {
      throw controlReceiptIntegrityError();
    }
    await afterOpen?.(journalPath);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    const after = await lstat(journalPath);
    await assertSafeRunDirectory(runDirectory);
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || !sameFileIdentity(opened, after)) {
      throw controlReceiptIntegrityError();
    }
  } finally {
    await handle.close();
  }
}

const RUN_CONTROL_LOCK_RETRY_MS = 25;
const RUN_CONTROL_LOCK_MAX_RETRIES = 200;

interface RunControlLockLease {
  schemaVersion: "martin.run-control-lock.v1";
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  heartbeatAt: string;
}

async function withRunControlLock<T>(
  runDirectory: string,
  operation: () => Promise<T>,
  maxRetries = RUN_CONTROL_LOCK_MAX_RETRIES
): Promise<T> {
  await assertSafeRunDirectory(runDirectory);
  const lockPath = path.join(runDirectory, ".run-control.lock");
  const token = randomBytes(16).toString("hex");
  let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
  let lease: RunControlLockLease | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      lockHandle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      const now = new Date().toISOString();
      lease = {
        schemaVersion: "martin.run-control-lock.v1",
        token,
        pid: process.pid,
        hostname: hostname(),
        acquiredAt: now,
        heartbeatAt: now
      };
      await lockHandle.writeFile(`${JSON.stringify(lease)}\n`, "utf8");
      await lockHandle.sync();
      break;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw storeUnreadableError();
      try {
        const before = await lstat(lockPath);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
          throw storeUnreadableError();
        }
        const raw = await safeReadJournal(runDirectory, lockPath);
        const existing = JSON.parse(raw) as Partial<RunControlLockLease>;
        if (
          existing.schemaVersion === "martin.run-control-lock.v1" &&
          typeof existing.token === "string" &&
          existing.hostname === hostname() &&
          typeof existing.pid === "number" &&
          !isProcessAlive(existing.pid)
        ) {
          if (await reclaimDeadRunControlLock(runDirectory, lockPath, raw, before, existing.token)) {
            continue;
          }
        }
      } catch (inspectionError) {
        if (isNodeError(inspectionError, "ENOENT")) continue;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, RUN_CONTROL_LOCK_RETRY_MS));
    }
  }
  if (!lockHandle || !lease) {
    throw storeUnreadableError("Run control journal is busy; no control was recorded.");
  }
  let heartbeatRunning = false;
  const heartbeat = setInterval(() => {
    if (!lockHandle || !lease || heartbeatRunning) return;
    heartbeatRunning = true;
    lease = { ...lease, heartbeatAt: new Date().toISOString() };
    const serializedLease = `${JSON.stringify(lease)}\n`;
    void lockHandle.truncate(0)
      // FileHandle.writeFile() writes from the handle's current position. The
      // explicit position prevents a heartbeat from leaving a sparse prefix
      // after truncate(), which would make the ownership record unreadable.
      .then(() => lockHandle!.write(serializedLease, 0, "utf8"))
      .then(() => lockHandle!.sync())
      .catch(() => undefined)
      .finally(() => {
        heartbeatRunning = false;
      });
  }, 1_000);
  heartbeat.unref();
  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    await lockHandle.close();
    const raw = await safeReadJournal(runDirectory, lockPath).catch(() => undefined);
    if (raw) {
      try {
        const current = JSON.parse(raw) as Partial<RunControlLockLease>;
        if (current.token === token) await unlink(lockPath);
      } catch {
        // A replaced/corrupt lock is never deleted by a former owner.
      }
    }
  }
}

async function reclaimDeadRunControlLock(
  runDirectory: string,
  lockPath: string,
  observedRaw: string,
  observed: { dev: number | bigint; ino: number | bigint },
  staleToken: string
): Promise<boolean> {
  const claimPath = path.join(
    runDirectory,
    `.run-control.reclaim-${createHash("sha256").update(staleToken).digest("hex").slice(0, 24)}`
  );
  try {
    // A hard-link is an atomic compare token for the observed inode. Exactly
    // one concurrent reclaimer can create this deterministic claim.
    await link(lockPath, claimPath);
  } catch (error) {
    if (isNodeError(error, "EEXIST") || isNodeError(error, "ENOENT")) return false;
    throw error;
  }

  try {
    const claimed = await lstat(claimPath);
    const current = await lstat(lockPath).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    });
    if (
      !current ||
      !claimed.isFile() ||
      claimed.isSymbolicLink() ||
      !sameFileIdentity(observed, claimed) ||
      !sameFileIdentity(claimed, current)
    ) {
      return false;
    }
    const handle = await open(claimPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let claimRaw: string;
    try {
      const opened = await handle.stat();
      if (!sameFileIdentity(claimed, opened)) return false;
      claimRaw = await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
    if (claimRaw !== observedRaw) return false;

    // Only the successful claim creator may unlink. Other reclaimers wait for
    // the claim to disappear, preventing a second stale observer from deleting
    // a newly acquired lock after the first reclaimer succeeds.
    const beforeUnlink = await lstat(lockPath).catch(() => undefined);
    if (!beforeUnlink || !sameFileIdentity(claimed, beforeUnlink)) return false;
    await unlink(lockPath);
    return true;
  } finally {
    await unlink(claimPath).catch(() => undefined);
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

export function validateControlReason(value?: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw invalidArgumentsError("Invalid reason.");
  }
  return trimmed;
}
