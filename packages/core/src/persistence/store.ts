/// <reference types="node" />
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { LoopBudget, LoopRecord, LoopTask, MachineState } from "@martin/contracts";

import { type LedgerEvent } from "./ledger.js";
import { acquirePersistenceLease } from "./lease.js";
import {
  recoverReceiptIntegrityTransactionAssumeLeaseHeld,
  writeReceiptIntegrityMaterial,
  writeReceiptIntegrityTransactionAssumeLeaseHeld
} from "./integrity.js";

// ─── Run contract (immutable after initRun) ──────────────────────────────────

export interface RunContract {
  runId: string;
  workspaceId: string;
  projectId: string;
  task: LoopTask;
  budget: LoopBudget;
  createdAt: string;
  metadata?: Record<string, string>;
}

// ─── Per-attempt artifact bundle ─────────────────────────────────────────────

export interface AttemptArtifacts {
  /** Compiled PromptPacket written as compiled-context.json */
  compiledContext: unknown;
  /** Structured verification evidence captured from the authoritative MartinLoop verifier (optional) */
  verification?: unknown;
  /** Unified diff string from the patch (optional) */
  diff?: string;
  /** Raw verifier command output (optional) */
  verifierOutput?: string;
  /** Grounding scan result (optional) */
  groundingScan?: unknown;
  /** Safety leash artifact captured for a blocked or escalated attempt (optional) */
  leash?: unknown;
  /** Patch score artifact captured for Phase 10 patch-truth decisions (optional) */
  patchScore?: unknown;
  /** Patch keep/discard/escalate decision artifact (optional) */
  patchDecision?: unknown;
  /** Rollback boundary captured before an attempt mutates the repo (optional) */
  rollbackBoundary?: unknown;
  /** Rollback restore outcome captured after discard/escalation/failure (optional) */
  rollbackOutcome?: unknown;
}

// ─── RunStore interface ───────────────────────────────────────────────────────

/**
 * RunStore isolates all filesystem persistence from orchestration logic.
 * runMartin accepts an optional store; when provided, every lifecycle event
 * is durably written before the run proceeds to the next step.
 */
export interface RunStore {
  /**
   * Optional runs root hint for filesystem-backed stores.
   * Orchestration should prefer this over recomputing the default home store.
   */
  runsRoot?: string;

  /**
   * Write contract.json for a new run. Called once at run start.
   * The contract is immutable after this point.
   */
  initRun(contract: RunContract): Promise<void>;

  /**
   * Overwrite state.json with the current MachineState.
   * Called on every phase transition.
   */
  updateState(runId: string, state: MachineState): Promise<void>;

  /**
   * Append one event line to ledger.jsonl. Append-only — never rewrites.
   */
  appendLedger(runId: string, event: LedgerEvent): Promise<void>;

  /**
   * Write artifacts for a completed attempt to artifacts/attempt-<n>/.
   */
  writeAttemptArtifacts(
    runId: string,
    attemptIndex: number,
    artifacts: AttemptArtifacts
  ): Promise<void>;

  /**
   * Persist the latest canonical loop record snapshot when the caller has one.
   * Optional to avoid breaking custom RunStore implementations.
   */
  writeLoopRecord?(runId: string, loop: LoopRecord): Promise<void>;

  /**
   * Durably checkpoint a completed provider attempt as one idempotent store
   * operation. Implementations must not return until artifacts, settlement
   * ledger entries, the canonical loop snapshot, and receipt integrity agree.
   */
  commitAttemptSettlement?(
    runId: string,
    attemptIndex: number,
    loop: LoopRecord,
    artifacts: AttemptArtifacts,
    ledgerEvents: LedgerEvent[]
  ): Promise<void>;

  /** Commit later ledger evidence and its canonical loop snapshot coherently. */
  commitRunCheckpoint?(
    runId: string,
    loop: LoopRecord,
    ledgerEvents: LedgerEvent[]
  ): Promise<void>;
}

// ─── FileRunStore implementation ─────────────────────────────────────────────

const RUN_INDEX_FILENAME = "run-index.ndjson";

export function resolveRunsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return (env["MARTIN_RUNS_DIR"] as string | undefined)?.trim() ??
    join(homedir(), ".martin", "runs");
}

export function runDir(runsRoot: string, runId: string): string {
  return join(runsRoot, runId);
}

export function artifactDir(runsRoot: string, runId: string, attemptIndex: number): string {
  return join(runsRoot, runId, "artifacts", `attempt-${String(attemptIndex).padStart(3, "0")}`);
}

/**
 * Filesystem-backed RunStore. Writes to:
 *   <runsRoot>/<runId>/contract.json
 *   <runsRoot>/<runId>/state.json
 *   <runsRoot>/<runId>/ledger.jsonl
 *   <runsRoot>/<runId>/artifacts/attempt-<n>/compiled-context.json
 *   <runsRoot>/<runId>/artifacts/attempt-<n>/diff.patch (if diff provided)
 *   <runsRoot>/<runId>/artifacts/attempt-<n>/verifier-output.txt (if provided)
 *   <runsRoot>/<runId>/artifacts/attempt-<n>/grounding-scan.json (if provided)
 *   <runsRoot>/<runId>/artifacts/attempt-<n>/leash.json (if leash provided)
 *   <runsRoot>/<runId>/artifacts/attempt-<n>/patch-score.json (if patchScore provided)
 *   <runsRoot>/<runId>/artifacts/attempt-<n>/patch-decision.json (if patchDecision provided)
 *   <runsRoot>/<runId>/artifacts/attempt-<n>/rollback-boundary.json (if rollbackBoundary provided)
 *   <runsRoot>/<runId>/artifacts/attempt-<n>/rollback-outcome.json (if rollbackOutcome provided)
 */
export function createFileRunStore(options: { runsRoot?: string } = {}): RunStore {
  if (Object.prototype.hasOwnProperty.call(options, "recordedRunsRoot")) {
    throw Object.assign(new Error("Public FileRunStore cannot override recorded path authority."), {
      code: "RUN_STORE_RECORDED_PATH_AUTHORITY_FORBIDDEN",
    });
  }
  return createFileRunStoreInternal({ ...(options.runsRoot ? { runsRoot: options.runsRoot } : {}) });
}

export interface RecordedPathAuthorityRunStore extends RunStore {
  sealRecordedPathAuthority(runId: string): Promise<void>;
}

/** Internal source-level fixture seam; intentionally absent from package-root exports. */
export function createFileRunStoreWithRecordedPathAuthorityForTest(options: {
  runsRoot: string;
  recordedRunsRoot: string;
}): RecordedPathAuthorityRunStore {
  return createFileRunStoreInternal(options) as RecordedPathAuthorityRunStore;
}

function createFileRunStoreInternal(options: {
  runsRoot?: string;
  recordedRunsRoot?: string;
}): RunStore & Partial<RecordedPathAuthorityRunStore> {
  const runsRoot = resolve(options.runsRoot ?? resolveRunsRoot());
  const recordedRunsRoot = options.recordedRunsRoot === undefined
    ? undefined
    : assertCanonicalAbsoluteRecordedRoot(options.recordedRunsRoot);
  const latestLoops = new Map<string, LoopRecord>();
  const settlementQueues = new Map<string, Promise<void>>();

  const persistLoop = async (runId: string, loop: LoopRecord): Promise<void> => {
    const dir = runDir(runsRoot, runId);
    await mkdir(dir, { recursive: true });
    await writeJsonFile(join(dir, "loop-record.json"), loop);
    await appendRunIndexRecord(runsRoot, loop);
    const ledgerPath = join(dir, "ledger.jsonl");
    await appendFile(ledgerPath, "", "utf8");
    const ledgerRaw = await readFile(ledgerPath, "utf8");
    const ledgerEntries = ledgerRaw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
    await writeReceiptIntegrityMaterial({
      runId,
      runsRoot,
      loopRecord: loop,
      ledgerEntries,
      scope:
        loop.receiptScope ??
        {
          ...(loop.task.repoRoot ? { repoRoot: loop.task.repoRoot } : {}),
          ...(loop.task.repoRoot ? { workingDirectory: loop.task.repoRoot } : {}),
          runsRoot: recordedRunsRoot ?? runsRoot
        },
      signedAt: loop.updatedAt
    });
  };

  const enqueueSettlement = async (runId: string, operation: () => Promise<void>): Promise<void> => {
    const previous = settlementQueues.get(runId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const release = await acquirePersistenceLease(runsRoot, runId);
      try {
        await operation();
      } finally {
        await release();
      }
    });
    settlementQueues.set(runId, current);
    try {
      await current;
    } finally {
      if (settlementQueues.get(runId) === current) settlementQueues.delete(runId);
    }
  };

  const commitCheckpoint = async (
    runId: string,
    loop: LoopRecord,
    ledgerEvents: LedgerEvent[],
    beforeCommit?: (outcome: "committed" | "noop") => Promise<void>
  ): Promise<"committed" | "noop"> => {
    await recoverReceiptIntegrityTransactionAssumeLeaseHeld({ runId, runsRoot });
    const directory = runDir(runsRoot, runId);
    const ledgerPath = join(directory, "ledger.jsonl");
    const canonicalLoop = JSON.parse(
      await readFile(join(directory, "loop-record.json"), "utf8")
    ) as LoopRecord;
    const existingRaw = await readFile(ledgerPath, "utf8").catch(() => "");
    const existing = existingRaw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LedgerEvent);
    const existingByIdentity = new Map<string, LedgerEvent>();
    for (const event of existing) {
      const identity = settlementEventIdentity(event);
      if (existingByIdentity.has(identity) && isIdempotentCheckpointKind(event.kind)) {
        throw Object.assign(new Error(`Duplicate persisted run checkpoint event: ${identity}`), {
          code: "RUN_STORE_SETTLEMENT_DUPLICATE"
        });
      }
      existingByIdentity.set(identity, event);
    }
    const targetLedger = [...existing];
    let newEventCount = 0;
    for (const event of ledgerEvents) {
      const identity = settlementEventIdentity(event);
      const prior = existingByIdentity.get(identity);
      if (prior) {
        if (!sameCheckpointEvent(prior, event)) {
          throw Object.assign(new Error(`Conflicting run checkpoint event: ${identity}`), {
            code: "RUN_STORE_SETTLEMENT_CONFLICT"
          });
        }
        continue;
      }
      targetLedger.push(event);
      existingByIdentity.set(identity, event);
      newEventCount += 1;
    }
    if (ledgerEvents.length > 0 && newEventCount === 0) {
      await beforeCommit?.("noop");
      return "noop";
    }
    if (isStaleCheckpointLoop(loop, canonicalLoop)) {
      throw Object.assign(new Error(`Stale run checkpoint rejected: ${runId}`), {
        code: "RUN_STORE_STALE_CHECKPOINT"
      });
    }
    await beforeCommit?.("committed");
    await writeReceiptIntegrityTransactionAssumeLeaseHeld({
      runId,
      runsRoot,
      targetLoopRecord: loop,
      targetLedgerEntries: targetLedger,
      scope: loop.receiptScope ?? {
        ...(loop.task.repoRoot ? { repoRoot: loop.task.repoRoot, workingDirectory: loop.task.repoRoot } : {}),
        runsRoot: recordedRunsRoot ?? runsRoot
      },
      createdAt: loop.updatedAt
    });
    await recoverReceiptIntegrityTransactionAssumeLeaseHeld({ runId, runsRoot });
    await appendRunIndexRecord(runsRoot, loop);
    return "committed";
  };

  return {
    runsRoot,

    async initRun(contract: RunContract): Promise<void> {
      const dir = runDir(runsRoot, contract.runId);
      await mkdir(dir, { recursive: true });
      await writeJsonFile(join(dir, "contract.json"), contract);
    },

    async updateState(runId: string, state: MachineState): Promise<void> {
      const dir = runDir(runsRoot, runId);
      await mkdir(dir, { recursive: true });
      await writeJsonFile(join(dir, "state.json"), state);
    },

    async appendLedger(runId: string, event: LedgerEvent): Promise<void> {
      await enqueueSettlement(runId, async () => {
        await recoverReceiptIntegrityTransactionAssumeLeaseHeld({ runId, runsRoot });
        const dir = runDir(runsRoot, runId);
        await mkdir(dir, { recursive: true });
        const loopRaw = await readFile(join(dir, "loop-record.json"), "utf8").catch(() => undefined);
        if (loopRaw === undefined) {
          await appendFile(join(dir, "ledger.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
          return;
        }
        await commitCheckpoint(runId, JSON.parse(loopRaw) as LoopRecord, [event]);
      });
    },

    async writeAttemptArtifacts(
      runId: string,
      attemptIndex: number,
      artifacts: AttemptArtifacts
    ): Promise<void> {
      const dir = artifactDir(runsRoot, runId, attemptIndex);
      await mkdir(dir, { recursive: true });

      await writeJsonFile(join(dir, "compiled-context.json"), artifacts.compiledContext);
      if (artifacts.verification !== undefined) {
        await writeJsonFile(join(dir, "verification.json"), artifacts.verification);
      }

      if (artifacts.diff !== undefined) {
        await writeFile(join(dir, "diff.patch"), artifacts.diff, "utf8");
      }
      if (artifacts.verifierOutput !== undefined) {
        await writeFile(join(dir, "verifier-output.txt"), artifacts.verifierOutput, "utf8");
      }
      if (artifacts.groundingScan !== undefined) {
        await writeJsonFile(join(dir, "grounding-scan.json"), artifacts.groundingScan);
      }
      if (artifacts.leash !== undefined) {
        await writeJsonFile(join(dir, "leash.json"), artifacts.leash);
      }
      if (artifacts.patchScore !== undefined) {
        await writeJsonFile(join(dir, "patch-score.json"), artifacts.patchScore);
      }
      if (artifacts.patchDecision !== undefined) {
        await writeJsonFile(join(dir, "patch-decision.json"), artifacts.patchDecision);
      }
      if (artifacts.rollbackBoundary !== undefined) {
        await writeJsonFile(join(dir, "rollback-boundary.json"), artifacts.rollbackBoundary);
      }
      if (artifacts.rollbackOutcome !== undefined) {
        await writeJsonFile(join(dir, "rollback-outcome.json"), artifacts.rollbackOutcome);
      }
    },

    async writeLoopRecord(runId: string, loop: LoopRecord): Promise<void> {
      if (recordedRunsRoot) latestLoops.set(runId, structuredClone(loop));
      await enqueueSettlement(runId, async () => {
        await recoverReceiptIntegrityTransactionAssumeLeaseHeld({ runId, runsRoot });
        const existingLoop = await readFile(join(runDir(runsRoot, runId), "loop-record.json"), "utf8").catch(() => undefined);
        if (existingLoop === undefined) {
          await persistLoop(runId, loop);
          return;
        }
        await commitCheckpoint(runId, loop, []);
      });
    },

    async commitAttemptSettlement(runId, attemptIndex, loop, artifacts, ledgerEvents) {
      await enqueueSettlement(runId, async () => {
        await commitCheckpoint(
          runId,
          loop,
          ledgerEvents,
          (outcome) => ensureAttemptArtifacts(runsRoot, runId, attemptIndex, artifacts, outcome === "noop")
        );
      });
    },

    async commitRunCheckpoint(runId, loop, ledgerEvents) {
      await enqueueSettlement(runId, async () => {
        await commitCheckpoint(runId, loop, ledgerEvents);
      });
    },

    ...(recordedRunsRoot
      ? {
          async sealRecordedPathAuthority(runId: string): Promise<void> {
            const loop = latestLoops.get(runId);
            if (!loop) {
              throw new Error(`No durable loop record is available for recorded path authority: ${runId}`);
            }
            const ledgerPath = join(runDir(runsRoot, runId), "ledger.jsonl");
            const ledgerRaw = await readFile(ledgerPath, "utf8").catch(() => undefined);
            if (ledgerRaw !== undefined) {
              const mappedLedger = ledgerRaw
                .split(/\r?\n/u)
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => JSON.stringify(mapLedgerEventForEvidence(
                  JSON.parse(line) as LedgerEvent,
                  runsRoot,
                  recordedRunsRoot
                )))
                .join("\n");
              await writeFile(ledgerPath, mappedLedger ? `${mappedLedger}\n` : "", "utf8");
            }
            await persistLoop(runId, mapLoopRecordForEvidence(loop, runsRoot, recordedRunsRoot));
          },
        }
      : {}),
  };
}

function settlementEventIdentity(event: LedgerEvent): string {
  if (isIdempotentCheckpointKind(event.kind)) {
    return `${event.kind}:${event.attemptIndex ?? "run"}`;
  }
  return `${event.kind}:${event.attemptIndex ?? "run"}:${event.timestamp}:${JSON.stringify(event.payload)}`;
}

function isIdempotentCheckpointKind(kind: LedgerEvent["kind"]): boolean {
  return kind === "patch.generated" || kind === "budget.settled" || kind === "verification.completed"
    || kind === "soft_limit_warning";
}

function sameCheckpointEvent(left: LedgerEvent, right: LedgerEvent): boolean {
  return left.runId === right.runId
    && left.kind === right.kind
    && left.attemptIndex === right.attemptIndex
    && JSON.stringify(left.payload) === JSON.stringify(right.payload);
}

function isStaleCheckpointLoop(candidate: LoopRecord, canonical: LoopRecord): boolean {
  if (candidate.attempts.length < canonical.attempts.length) return true;
  for (let index = 0; index < canonical.attempts.length; index += 1) {
    const current = canonical.attempts[index];
    const next = candidate.attempts[index];
    if (!current || !next || current.attemptId !== next.attemptId || current.index !== next.index) return true;
  }
  return Boolean(canonical.terminationEnvelope && !candidate.terminationEnvelope);
}

function assertCanonicalAbsoluteRecordedRoot(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error("Recorded runs root must be a canonical absolute path.");
  }
  return path;
}

function mapLoopRecordForEvidence(
  loop: LoopRecord,
  physicalRunsRoot: string,
  recordedRunsRoot: string
): LoopRecord {
  const mapPath = (value: string | undefined): string | undefined => (
    value === undefined ? undefined : mapStructuralPath(value, physicalRunsRoot, recordedRunsRoot)
  );
  const receiptScope = loop.receiptScope === undefined
    ? undefined
    : {
        ...loop.receiptScope,
        ...(loop.receiptScope.repoRoot ? { repoRoot: mapPath(loop.receiptScope.repoRoot)! } : {}),
        ...(loop.receiptScope.workingDirectory
          ? { workingDirectory: mapPath(loop.receiptScope.workingDirectory)! }
          : {}),
        ...(loop.receiptScope.invocationRoot
          ? { invocationRoot: mapPath(loop.receiptScope.invocationRoot)! }
          : {}),
        ...(loop.receiptScope.runsRoot ? { runsRoot: mapPath(loop.receiptScope.runsRoot)! } : {}),
        ...(loop.receiptScope.writableRoot ? { writableRoot: mapPath(loop.receiptScope.writableRoot)! } : {}),
      };
  return {
    ...loop,
    task: {
      ...loop.task,
      ...(loop.task.repoRoot ? { repoRoot: mapPath(loop.task.repoRoot)! } : {}),
    },
    events: loop.events.map((event) => mapVerificationEventBinding(event, physicalRunsRoot, recordedRunsRoot)),
    ...(receiptScope ? { receiptScope } : {}),
  };
}

function mapLedgerEventForEvidence(
  event: LedgerEvent,
  physicalRunsRoot: string,
  recordedRunsRoot: string
): LedgerEvent {
  if (event.kind !== "verification.completed") return structuredClone(event);
  return {
    ...event,
    payload: mapVerificationBindingPayload(event.payload, physicalRunsRoot, recordedRunsRoot),
  };
}

function mapVerificationEventBinding(
  event: LoopRecord["events"][number],
  physicalRunsRoot: string,
  recordedRunsRoot: string
): LoopRecord["events"][number] {
  if (event.type !== "verification.completed") return structuredClone(event);
  return {
    ...event,
    payload: mapVerificationBindingPayload(event.payload, physicalRunsRoot, recordedRunsRoot),
  };
}

function mapVerificationBindingPayload(
  payload: Record<string, unknown>,
  physicalRunsRoot: string,
  recordedRunsRoot: string
): Record<string, unknown> {
  const binding = payload["binding"];
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return structuredClone(payload);
  const record = binding as Record<string, unknown>;
  return {
    ...structuredClone(payload),
    binding: {
      ...structuredClone(record),
      ...(typeof record["cwd"] === "string"
        ? { cwd: mapStructuralPath(record["cwd"], physicalRunsRoot, recordedRunsRoot) }
        : {}),
      ...(typeof record["runsRoot"] === "string"
        ? { runsRoot: mapStructuralPath(record["runsRoot"], physicalRunsRoot, recordedRunsRoot) }
        : {}),
    },
  };
}

function mapStructuralPath(value: string, physicalRunsRoot: string, recordedRunsRoot: string): string {
  if (!isAbsolute(value)) return value;
  const canonical = resolve(value);
  const relation = relative(physicalRunsRoot, canonical);
  if (relation === "") return recordedRunsRoot;
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) return value;
  return join(recordedRunsRoot, relation);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function ensureAttemptArtifacts(
  runsRoot: string,
  runId: string,
  attemptIndex: number,
  artifacts: AttemptArtifacts,
  preserveExisting: boolean
): Promise<void> {
  const directory = artifactDir(runsRoot, runId, attemptIndex);
  await mkdir(directory, { recursive: true });
  const files: Array<[string, string]> = [
    ["compiled-context.json", `${JSON.stringify(artifacts.compiledContext, null, 2)}\n`]
  ];
  const jsonArtifacts: Array<[string, unknown]> = [
    ["verification.json", artifacts.verification],
    ["grounding-scan.json", artifacts.groundingScan],
    ["leash.json", artifacts.leash],
    ["patch-score.json", artifacts.patchScore],
    ["patch-decision.json", artifacts.patchDecision],
    ["rollback-boundary.json", artifacts.rollbackBoundary],
    ["rollback-outcome.json", artifacts.rollbackOutcome]
  ];
  for (const [name, value] of jsonArtifacts) {
    if (value !== undefined) files.push([name, `${JSON.stringify(value, null, 2)}\n`]);
  }
  if (artifacts.diff !== undefined) files.push(["diff.patch", artifacts.diff]);
  if (artifacts.verifierOutput !== undefined) files.push(["verifier-output.txt", artifacts.verifierOutput]);
  for (const [name, content] of files) {
    const path = join(directory, name);
    try {
      await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (preserveExisting) continue;
      if (await readFile(path, "utf8") !== content) {
        throw Object.assign(new Error(`Conflicting attempt artifact: ${name}`), {
          code: "RUN_STORE_ARTIFACT_CONFLICT"
        });
      }
    }
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function appendRunIndexRecord(runsRoot: string, loop: LoopRecord): Promise<void> {
  const line = JSON.stringify({
    loopId: loop.loopId,
    workspaceId: loop.workspaceId,
    projectId: loop.projectId,
    status: loop.status,
    lifecycleState: loop.lifecycleState,
    updatedAt: loop.updatedAt
  });

  await appendFile(join(runsRoot, RUN_INDEX_FILENAME), `${line}\n`, "utf8");
}
