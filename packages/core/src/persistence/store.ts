/// <reference types="node" />
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { LoopBudget, LoopTask, MachineState } from "@martin/contracts";

import { type LedgerEvent } from "./ledger.js";

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
  /** Unified diff string from the patch (optional) */
  diff?: string;
  /** Raw verifier command output (optional) */
  verifierOutput?: string;
  /** Grounding scan result (optional) */
  groundingScan?: unknown;
}

// ─── RunStore interface ───────────────────────────────────────────────────────

/**
 * RunStore isolates all filesystem persistence from orchestration logic.
 * runMartin accepts an optional store; when provided, every lifecycle event
 * is durably written before the run proceeds to the next step.
 */
export interface RunStore {
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
}

// ─── FileRunStore implementation ─────────────────────────────────────────────

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
 */
export function createFileRunStore(options: { runsRoot?: string } = {}): RunStore {
  const runsRoot = options.runsRoot ?? resolveRunsRoot();

  return {
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

      if (artifacts.diff !== undefined) {
        await writeFile(join(dir, "diff.patch"), artifacts.diff, "utf8");
      }
      if (artifacts.verifierOutput !== undefined) {
        await writeFile(join(dir, "verifier-output.txt"), artifacts.verifierOutput, "utf8");
      }
      if (artifacts.groundingScan !== undefined) {
        await writeJsonFile(join(dir, "grounding-scan.json"), artifacts.groundingScan);
      }
    }
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
