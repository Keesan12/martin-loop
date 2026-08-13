/// <reference types="node" />
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { LoopBudget, LoopRecord, LoopTask, MachineState } from "@martin/contracts";

import { type LedgerEvent } from "./ledger.js";
import { writeReceiptIntegrityMaterial } from "./integrity.js";

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
  const runsRoot = options.runsRoot ?? resolveRunsRoot();

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
      const dir = runDir(runsRoot, runId);
      await mkdir(dir, { recursive: true });
      await appendFile(
        join(dir, "ledger.jsonl"),
        `${JSON.stringify(event)}\n`,
        "utf8"
      );
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
      const dir = runDir(runsRoot, runId);
      await mkdir(dir, { recursive: true });
      await writeJsonFile(join(dir, "loop-record.json"), loop);
      await appendRunIndexRecord(runsRoot, loop);
      const ledgerRaw = await readFile(join(dir, "ledger.jsonl"), "utf8").catch(() => "");
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
            runsRoot
          },
        signedAt: loop.updatedAt
      });
    }
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
