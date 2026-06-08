import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { assessTrajectory, decideCircuitBreak, resolveRunsRoot, verifyReceiptIntegrityFromFiles } from "@martin/core";
import type {
  ChangeObservationReconciliation,
  LoopArtifact,
  LoopEvent,
  LoopRecord,
  MartinRunListFilters,
  MartinRunSelector,
  ReceiptIntegritySummary,
  ReceiptScope
} from "@martin/contracts";

import { CliCommandError } from "./ux.js";

const LOOP_RECORD_TOP_LEVEL_KEYS = new Set([
  "loopId",
  "workspaceId",
  "projectId",
  "teamId",
  "status",
  "lifecycleState",
  "task",
  "budget",
  "cost",
  "artifacts",
  "attempts",
  "events",
  "metadata",
  "createdAt",
  "updatedAt",
  "receiptScope",
  "receiptIntegrity"
]);

// ---------------------------------------------------------------------------
// Local run-history hotspot reader (Layer 5 — proactive issue detection)
// Uses persisted Martin run-store evidence only; no hidden machine corpus.
// ---------------------------------------------------------------------------

export interface LocalRunHistoryHotspot {
  scopeFingerprint: string;
  failureRate: number;
  sampleSize: number;
  riskScore: number;
  commonFailureClasses: string[];
}

export interface LocalRunHistoryRisk {
  hotspots: LocalRunHistoryHotspot[];
  runRecords: number;
  runsRoot: string;
}

export interface LocalCorpusRisk {
  hotspots: LocalRunHistoryHotspot[];
  corpusRecords: number;
  corpusPath: string;
}

type RunsDirEntry = {
  name: string | { toString(): string };
  isFile(): boolean;
  isDirectory(): boolean;
};

export async function readLocalRunHistoryRisk(
  options: {
    runsDir?: string;
    invocationRoot?: string;
    minSampleSize?: number;
    minRiskScore?: number;
    maxEntries?: number;
  } = {}
): Promise<LocalRunHistoryRisk> {
  const runsRoot = resolveRunsRootPath(options.runsDir, options.invocationRoot);
  const minSampleSize = options.minSampleSize ?? 3;
  const minRiskScore = options.minRiskScore ?? 0.4;
  const { loops } = await collectPersistedLoops(runsRoot, { maxEntries: options.maxEntries ?? 200 });

  const byScope = new Map<string, LoopRecord[]>();
  for (const loop of loops) {
    if (!loop.task.repoRoot) {
      continue;
    }

    const scopeFingerprint = computeScopeFingerprint(loop.task.repoRoot);
    byScope.set(scopeFingerprint, [...(byScope.get(scopeFingerprint) ?? []), loop]);
  }

  const hotspots = [...byScope.entries()]
    .map(([scopeFingerprint, group]): LocalRunHistoryHotspot => {
      const failures = group.filter((loop) => isHighRiskLoopOutcome(loop));
      const failureRate = failures.length / group.length;
      const riskScore = Math.min(1, failureRate + Math.min(0.25, group.length / 12));
      return {
        scopeFingerprint,
        failureRate: Number(failureRate.toFixed(2)),
        sampleSize: group.length,
        riskScore: Number(riskScore.toFixed(2)),
        commonFailureClasses: [...new Set(failures.flatMap(collectFailureClasses))].slice(0, 3)
      };
    })
    .filter((hotspot) => hotspot.sampleSize >= minSampleSize && hotspot.riskScore >= minRiskScore)
    .sort((left, right) => right.riskScore - left.riskScore);

  return { hotspots, runRecords: loops.length, runsRoot };
}

export async function readLocalCorpusRisk(
  options: {
    corpusPath?: string;
    runsDir?: string;
    invocationRoot?: string;
    minSampleSize?: number;
    minRiskScore?: number;
    maxEntries?: number;
  } = {}
): Promise<LocalCorpusRisk> {
  const explicitCorpusPath = options.corpusPath ?? process.env["MARTIN_LEARNING_CORPUS_PATH"];
  if (explicitCorpusPath) {
    return readLegacyCorpusRisk(explicitCorpusPath, options);
  }

  const runHistory = await readLocalRunHistoryRisk(options);
  return {
    hotspots: runHistory.hotspots,
    corpusRecords: runHistory.runRecords,
    corpusPath: runHistory.runsRoot
  };
}

export function computeScopeFingerprint(workingDirectory: string): string {
  return createHash("sha256").update(workingDirectory.replace(/\\/g, "/").toLowerCase()).digest("hex").slice(0, 16);
}

function isHighRiskLoopOutcome(loop: LoopRecord): boolean {
  const verification = buildVerificationSummary(loop);
  return loop.status !== "completed" || verification.status !== "passed";
}

function collectFailureClasses(loop: LoopRecord): string[] {
  const fromAttempt = loop.attempts.at(-1)?.failureClass;
  if (typeof fromAttempt === "string") {
    return [fromAttempt];
  }

  return loop.events
    .filter((event) => event.type === "failure.classified")
    .map((event) => {
      const candidate = event.payload["failureClass"];
      return typeof candidate === "string" ? candidate : undefined;
    })
    .filter((candidate): candidate is string => candidate !== undefined);
}

async function readLegacyCorpusRisk(
  corpusPath: string,
  options: { minSampleSize?: number; minRiskScore?: number }
): Promise<LocalCorpusRisk> {
  const minSampleSize = options.minSampleSize ?? 3;
  const minRiskScore = options.minRiskScore ?? 0.4;

  const raw = await readFile(corpusPath, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });

  const records = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as {
          scopeFingerprint?: string | null;
          outcome?: string;
          failureClass?: string | null;
        };
      } catch {
        return null;
      }
    })
    .filter(
      (
        record
      ): record is {
        scopeFingerprint?: string | null;
        outcome?: string;
        failureClass?: string | null;
      } => record !== null
    );

  const byScope = new Map<string, typeof records>();
  for (const record of records) {
    if (!record.scopeFingerprint) {
      continue;
    }

    byScope.set(record.scopeFingerprint, [...(byScope.get(record.scopeFingerprint) ?? []), record]);
  }

  const hotspots = [...byScope.entries()]
    .map(([scopeFingerprint, group]): LocalRunHistoryHotspot => {
      const failures = group.filter((record) => record.outcome !== "completed");
      const failureRate = failures.length / group.length;
      const riskScore = Math.min(1, failureRate + Math.min(0.25, group.length / 400));
      return {
        scopeFingerprint,
        failureRate: Number(failureRate.toFixed(2)),
        sampleSize: group.length,
        riskScore: Number(riskScore.toFixed(2)),
        commonFailureClasses: [
          ...new Set(
            failures
              .map((record) => record.failureClass)
              .filter((candidate): candidate is string => typeof candidate === "string")
          )
        ].slice(0, 3)
      };
    })
    .filter((hotspot) => hotspot.sampleSize >= minSampleSize && hotspot.riskScore >= minRiskScore)
    .sort((left, right) => right.riskScore - left.riskScore);

  return { hotspots, corpusRecords: records.length, corpusPath };
}

export interface CliEnvironment {
  invocationRoot: string;
  workingDirectory: string;
  runsRoot: string;
  engine: "claude" | "codex" | "gemini" | "openai";
  liveMode: "live" | "proof";
}

export interface PersistedLoopDetail {
  source: string;
  runsRoot: string;
  loop: LoopRecord;
  warnings: string[];
  runDirectory?: string;
  loopRecordPath?: string;
  integrity: ReceiptIntegritySummary;
}

export interface VerificationSummary {
  status: "passed" | "failed" | "contradicted" | "not_run";
  summary: string;
  eventCount: number;
  latestAttemptIndex?: number;
  completedAt?: string;
  steps: VerificationStepSummary[];
  observation?: ChangeObservationReconciliation;
  warnings: string[];
}

export interface VerificationStepSummary {
  command: string;
  launched: boolean;
  exitCode?: number;
  timedOut?: boolean;
  fastFail?: boolean;
  detail?: string;
}

export interface ArtifactSummary {
  totalCount: number;
  kinds: Record<string, number>;
  highlights: LoopArtifact[];
}

export interface TriageFinding {
  loopId: string;
  priority: number;
  status: LoopRecord["status"];
  lifecycleState: LoopRecord["lifecycleState"];
  title: string;
  summary: string;
  reasons: string[];
  updatedAt: string;
}

export function resolveInvocationRoot(env: NodeJS.ProcessEnv = process.env): string {
  const initCwd = env.INIT_CWD?.trim();
  return initCwd && initCwd.length > 0 ? initCwd : process.cwd();
}

export function resolveCliEnvironment(input: {
  cwd?: string;
  runsDir?: string;
  engine?: string;
  liveMode?: CliEnvironment["liveMode"];
  env?: NodeJS.ProcessEnv;
} = {}): CliEnvironment {
  const env = input.env ?? process.env;
  const invocationRoot = resolveInvocationRoot(env);
  const workingDirectory = path.resolve(invocationRoot, input.cwd ?? process.cwd());
  const runsRoot = path.resolve(resolveRunsRoot({ ...env, MARTIN_RUNS_DIR: input.runsDir ?? env.MARTIN_RUNS_DIR }));
  const engine =
    input.engine === "codex"
      ? "codex"
      : input.engine === "gemini"
        ? "gemini"
        : input.engine === "openai"
          ? "openai"
          : "claude";

  return {
    invocationRoot,
    workingDirectory,
    runsRoot,
    engine,
    liveMode: input.liveMode ?? (env.MARTIN_LIVE === "false" ? "proof" : "live")
  };
}

export async function listPersistedLoops(
  filters: MartinRunListFilters,
  options: { invocationRoot?: string } = {}
): Promise<{ runsRoot: string; loops: LoopRecord[]; warnings: string[] }> {
  const runsRoot = resolveRunsRootPath(filters.runsDir, options.invocationRoot);
  const inspected = await collectPersistedLoops(runsRoot);
  const updatedAfterTimestamp =
    filters.updatedAfter !== undefined ? Date.parse(filters.updatedAfter) : undefined;

  if (
    filters.updatedAfter !== undefined &&
    (!Number.isFinite(updatedAfterTimestamp) || Number.isNaN(updatedAfterTimestamp))
  ) {
    throw new CliCommandError("invalid_input", "Invalid updatedAfter timestamp.", {
      suggestion: "Provide updatedAfter as an ISO-8601 timestamp."
    });
  }

  const loops = inspected.loops
    .filter((loop) => {
      if (filters.status && loop.status !== filters.status) {
        return false;
      }
      if (filters.lifecycleState && loop.lifecycleState !== filters.lifecycleState) {
        return false;
      }
      if (filters.adapterId && !loop.attempts.some((attempt) => attempt.adapterId === filters.adapterId)) {
        return false;
      }
      if (filters.model && !loop.attempts.some((attempt) => attempt.model === filters.model)) {
        return false;
      }
      if (updatedAfterTimestamp !== undefined) {
        const timestamp = loopTimestamp(loop);
        if (!Number.isFinite(timestamp) || timestamp <= updatedAfterTimestamp) {
          return false;
        }
      }
      return true;
    })
    .sort((left, right) => loopTimestamp(right) - loopTimestamp(left))
    .slice(0, filters.limit ?? 20);

  return {
    runsRoot,
    loops,
    warnings: inspected.warnings
  };
}

export async function loadPersistedLoop(
  selector: MartinRunSelector,
  options: { invocationRoot?: string } = {}
): Promise<PersistedLoopDetail> {
  const runsRoot = resolveRunsRootPath(selector.runsDir, options.invocationRoot);
  const selectors = [
    selector.file !== undefined ? "file" : null,
    selector.loopId !== undefined ? "loopId" : null,
    selector.latest ? "latest" : null
  ].filter((value): value is string => value !== null);

  if (selectors.length !== 1) {
    throw new CliCommandError("invalid_input", "Provide exactly one of --file, --loop-id, or --latest.", {
      suggestion: "Choose one persisted-run selector per command."
    });
  }

  if (selector.loopId) {
    const detail = await loadLoopById(selector.loopId, runsRoot);
    return await attachReceiptIntegrity({
      ...detail,
      runsRoot,
      warnings: []
    });
  }

  if (selector.file) {
    const targetPath = resolveAbsolutePath(selector.file, options.invocationRoot);
    const targetStats = await stat(targetPath).catch(() => null);
    if (!targetStats) {
      throw new CliCommandError("not_found", `Persisted run path not found: ${targetPath}`);
    }

    if (targetStats.isDirectory()) {
      const canonical = await findCanonicalLoopRecordPath(targetPath);
      if (canonical) {
        return await attachReceiptIntegrity({
          source: canonical,
          runsRoot,
          loop: await readLoopRecordFile(canonical),
          warnings: [],
          runDirectory: path.dirname(canonical),
          loopRecordPath: canonical
        });
      }

      const inspected = await collectPersistedLoops(targetPath);
      const loop = inspected.loops[0];
      if (!loop) {
        throw new CliCommandError("not_found", "No persisted Martin loops were found in the selected directory.");
      }

      return await attachReceiptIntegrity({
        source: targetPath,
        runsRoot,
        loop,
        warnings: inspected.warnings
      });
    }

    const runDirectory = path.dirname(targetPath);
    const canonicalFromParent = await findCanonicalLoopRecordPath(runDirectory);
    if (canonicalFromParent && path.resolve(canonicalFromParent) === path.resolve(targetPath)) {
      const unknownFieldWarnings = await detectUnknownLoopTopLevelFieldWarnings(canonicalFromParent);
      return await attachReceiptIntegrity({
        source: targetPath,
        runsRoot,
        loop: await readLoopRecordFile(canonicalFromParent),
        warnings: unknownFieldWarnings,
        runDirectory,
        loopRecordPath: canonicalFromParent
      });
    }

    const loops = await readLoopsFromFile(targetPath, runsRoot);
    const loop = loops.sort((left, right) => loopTimestamp(right) - loopTimestamp(left))[0];
    if (!loop) {
      throw new CliCommandError("not_found", "No persisted Martin loops were found in the selected file.");
    }

    const unknownFieldWarnings =
      targetPath.toLowerCase().endsWith(".json")
        ? await detectUnknownLoopTopLevelFieldWarnings(targetPath)
        : [];
    return await attachReceiptIntegrity({
      source: targetPath,
      runsRoot,
      loop,
      warnings: unknownFieldWarnings
    });
  }

  const inspected = await collectPersistedLoops(runsRoot);
  const loop = inspected.loops[0];
  if (!loop) {
    throw new CliCommandError("not_found", "No persisted Martin loops were found.");
  }

  const detail = await loadLoopById(loop.loopId, runsRoot);
  return await attachReceiptIntegrity({
    ...detail,
    runsRoot,
    warnings: inspected.warnings
  });
}

export async function loadPersistedAttempt(
  selector: MartinRunSelector,
  options: { invocationRoot?: string } = {}
): Promise<{
  detail: PersistedLoopDetail;
  attempt: LoopRecord["attempts"][number];
  verification: VerificationSummary;
}> {
  const detail = await loadPersistedLoop(selector, options);
  const attempt =
    selector.attemptIndex !== undefined
      ? detail.loop.attempts.find((candidate) => candidate.index === selector.attemptIndex)
      : detail.loop.attempts.at(-1);

  if (!attempt) {
    throw new CliCommandError("not_found", "The selected attempt was not found.", {
      suggestion: "Choose an attemptIndex that exists in the selected Martin loop."
    });
  }

  return {
    detail,
    attempt,
    verification: buildVerificationSummary(detail.loop)
  };
}

async function attachReceiptIntegrity(detail: Omit<PersistedLoopDetail, "integrity">): Promise<PersistedLoopDetail> {
  const integrity =
    detail.loopRecordPath && detail.runDirectory
      ? isWithinRunsRoot(detail.runsRoot, detail.runDirectory)
        ? await verifyReceiptIntegrityFromFiles({
            runId: detail.loop.loopId,
            runsRoot: detail.runsRoot,
            loopRecordPath: detail.loopRecordPath,
            ledgerPath: await resolveReceiptEvidencePath(detail.runDirectory)
          }).catch<ReceiptIntegritySummary>(() => ({
            state: "material_missing",
            reason: "Receipt integrity verification could not be completed."
          }))
        : ({
            state: "relocated",
            reason: "Run evidence was loaded from a relocated directory outside the canonical runs root."
          } satisfies ReceiptIntegritySummary)
      : ({
          state: "selector_noncanonical",
          reason: "Receipt integrity is only available for canonical run selectors."
        } satisfies ReceiptIntegritySummary);

  return {
    ...detail,
    loop: {
      ...detail.loop,
      receiptIntegrity: integrity
    },
    integrity
  };
}

export function buildVerificationSummary(loop: LoopRecord): VerificationSummary {
  const verificationEvents = loop.events.filter((event) => event.type === "verification.completed");
  const latestEvent = verificationEvents.at(-1);
  const integrityWarnings =
    loop.receiptIntegrity && loop.receiptIntegrity.state !== "verified"
      ? [`Receipt integrity is ${loop.receiptIntegrity.state}; persisted verifier evidence is not trustworthy yet.`]
      : [];

  if (!latestEvent) {
    return {
      status: "not_run",
      summary: "No persisted verification evidence was found for this loop.",
      eventCount: 0,
      steps: [],
      warnings: [...integrityWarnings, "Verification evidence was not recorded for this persisted loop."]
    };
  }

  const payload = isRecord(latestEvent.payload) ? latestEvent.payload : undefined;
  const passed = payload?.["passed"] === true;
  const latestAttemptIndex =
    typeof payload?.["attemptIndex"] === "number"
      ? (payload["attemptIndex"] as number)
      : loop.attempts.at(-1)?.index;
  const steps = readVerificationSteps(payload);
  const observation = latestAttemptIndex !== undefined
    ? selectObservationForAttempt(loop, latestAttemptIndex)
    : undefined;
  const warnings = [
    ...integrityWarnings,
    ...readVerificationWarnings(payload),
    ...buildObservationWarnings(observation)
  ];
  const contradicted = passed && hasVerificationContradiction(warnings, steps);

  return {
    status: contradicted ? "contradicted" : passed ? "passed" : "failed",
    summary:
      typeof payload?.["summary"] === "string"
        ? (payload["summary"] as string)
        : contradicted
          ? "Verifier evidence is contradicted by launch/runtime diagnostics."
        : passed
          ? "Verification passed."
          : "Verification failed.",
    eventCount: verificationEvents.length,
    ...(latestAttemptIndex !== undefined ? { latestAttemptIndex } : {}),
    completedAt: latestEvent.timestamp,
    steps,
    ...(observation ? { observation } : {}),
    warnings
  };
}

export function buildArtifactSummary(loop: LoopRecord): ArtifactSummary {
  const kinds = loop.artifacts.reduce<Record<string, number>>((summary, artifact) => {
    summary[artifact.kind] = (summary[artifact.kind] ?? 0) + 1;
    return summary;
  }, {});

  return {
    totalCount: loop.artifacts.length,
    kinds,
    highlights: loop.artifacts.slice(0, 5)
  };
}

export function buildRunReceipt(
  loop: LoopRecord,
  verification = buildVerificationSummary(loop),
  receiptScope = resolveReceiptScope(loop)
): Record<string, unknown> {
  const latestAttempt = loop.attempts.at(-1);
  const integrity = resolveReceiptIntegrity(loop);
  const trustworthy = integrity.state === "verified";
  const rollbackArtifacts = loop.artifacts.filter((artifact) =>
    /rollback|restore|diff|patch/iu.test(`${artifact.kind} ${artifact.label} ${artifact.uri}`)
  );
  const stopConditionReached =
    loop.lifecycleState === "budget_exit" ||
    loop.lifecycleState === "diminishing_returns" ||
    loop.lifecycleState === "stuck_exit" ||
    loop.lifecycleState === "human_escalation";
  const prevented = trustworthy
    ? buildPreventionSummary(loop, verification, stopConditionReached)
    : ["trust claim unavailable until receipt integrity verifies"];

  return {
    trustworthy,
    receiptIntegrity: integrity,
    ...(receiptScope ? { receiptScope } : {}),
    whatHappened: latestAttempt?.summary ?? verification.summary ?? loop.task.objective,
    whatMartinPrevented: prevented,
    tokenWasteReceipt: {
      actualUsd: loop.cost.actualUsd,
      avoidedUsdEstimate: loop.cost.avoidedUsd,
      tokensIn: loop.cost.tokensIn,
      tokensOut: loop.cost.tokensOut,
      trustworthy,
      integrityState: integrity.state,
      avoidedIterationsEstimate: stopConditionReached ? 1 : 0,
      avoidedVerifierRetriesEstimate: verification.status === "failed" && stopConditionReached ? 1 : 0,
      estimateLabel: trustworthy
        ? "Avoided spend, avoided iterations, and avoided verifier retries are directional local estimates unless backed by provider usage receipts."
        : "This receipt is not trustworthy until receipt integrity verifies; cost and prevention values are informational only."
    },
    verifier: {
      status: verification.status,
      summary: verification.summary,
      eventCount: verification.eventCount,
      steps: verification.steps,
      trustworthy,
      warnings: verification.warnings
    },
    rollbackEvidence: {
      exists: rollbackArtifacts.length > 0,
      count: rollbackArtifacts.length,
      artifacts: rollbackArtifacts.slice(0, 5)
    },
    nextSafeAction: trustworthy
      ? selectNextSafeAction(loop, verification, rollbackArtifacts.length)
      : `Verify canonical receipt integrity for loop ${loop.loopId} before sharing proof or cost claims.`
  };
}

export function buildRunDossier(detail: PersistedLoopDetail): Record<string, unknown> {
  const verification = buildVerificationSummary(detail.loop);
  const artifactSummary = buildArtifactSummary(detail.loop);
  const receiptScope = resolveReceiptScope(detail.loop, detail.runsRoot);
  const receipt = buildRunReceipt(detail.loop, verification, receiptScope);

  return {
    source: detail.source,
    paths: {
      runsRoot: detail.runsRoot,
      ...(detail.runDirectory ? { runDirectory: detail.runDirectory } : {}),
      ...(detail.loopRecordPath ? { loopRecordPath: detail.loopRecordPath } : {})
    },
    loop: detail.loop,
    receiptIntegrity: detail.integrity,
    ...(receiptScope ? { receiptScope } : {}),
    verification,
    receipt,
    artifacts: artifactSummary,
    recentEvents: detail.loop.events.slice(-10)
  };
}

export async function triagePersistedLoops(
  filters: MartinRunListFilters,
  options: { invocationRoot?: string } = {}
): Promise<{ runsRoot: string; findings: TriageFinding[]; warnings: string[] }> {
  const listed = await listPersistedLoops(filters, options);
  const findings = listed.loops
    .map((loop) => scoreLoop(loop))
    .sort((left, right) => right.priority - left.priority);

  return {
    runsRoot: listed.runsRoot,
    findings,
    warnings: listed.warnings
  };
}

export async function findPersistedLoopEvidence(
  runsDir: string | undefined,
  options: { invocationRoot?: string } = {}
): Promise<{ runsRoot: string; loop?: LoopRecord; warnings: string[] }> {
  const runsRoot = resolveRunsRootPath(runsDir, options.invocationRoot);
  const entries = await readdir(runsRoot, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissing(error)) {
      return [] as Awaited<ReturnType<typeof readdir>>;
    }

    throw new CliCommandError("store_unreadable", "Unable to read the Martin runs directory.", {
      suggestion: "Check MARTIN_RUNS_DIR or pass --runs-dir with a readable path."
    });
  });

  entries.sort((left, right) => String(left.name).localeCompare(String(right.name)));
  const warnings: string[] = [];
  const indexedLoop = await loadLatestLoopFromWorkspaceIndexes(runsRoot, entries, warnings);
  if (indexedLoop) {
    return {
      runsRoot,
      loop: indexedLoop,
      warnings
    };
  }

  let latestLoop: LoopRecord | undefined;
  for (const entry of entries) {
    try {
      const entryName = String(entry.name);
      if (entry.isDirectory()) {
        const canonical = await findCanonicalLoopRecordPath(path.join(runsRoot, entryName));
        if (!canonical) {
          continue;
        }

        const loop = await readLoopRecordFile(canonical);
        const candidateTimestamp = loopTimestamp(loop);
        const latestTimestamp = latestLoop ? loopTimestamp(latestLoop) : Number.NEGATIVE_INFINITY;
        if (candidateTimestamp > latestTimestamp) {
          latestLoop = loop;
        }
        continue;
      }

      if (!entry.isFile() || (!entryName.endsWith(".json") && !entryName.endsWith(".jsonl"))) {
        continue;
      }

      const loop = (await readLoopsFromFile(path.join(runsRoot, entryName), runsRoot)).sort(
        (left, right) => loopTimestamp(right) - loopTimestamp(left)
      )[0];
      const candidateTimestamp = loop ? loopTimestamp(loop) : Number.NEGATIVE_INFINITY;
      const latestTimestamp = latestLoop ? loopTimestamp(latestLoop) : Number.NEGATIVE_INFINITY;
      if (loop && candidateTimestamp > latestTimestamp) {
        latestLoop = loop;
      }
    } catch (error) {
      warnings.push(
        `Skipped unreadable persisted loop entry '${String(entry.name)}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return {
    runsRoot,
    ...(latestLoop ? { loop: latestLoop } : {}),
    warnings
  };
}

function buildPreventionSummary(
  loop: LoopRecord,
  verification: VerificationSummary,
  stopConditionReached: boolean
): string[] {
  const prevented: string[] = [];
  const latestAttempt = loop.attempts.at(-1);
  const circuitBreak = decideCircuitBreak({
    objective: loop.task.objective,
    verificationPlan: loop.task.verificationPlan,
    attempts: loop.attempts,
    remainingIterations: Math.max(loop.budget.maxIterations - loop.attempts.length, 0)
  });

  if (stopConditionReached) {
    prevented.push("another unsafe or uneconomical retry before operator review");
  }
  if (verification.status === "failed" || verification.status === "contradicted") {
    prevented.push("false success claims after a failed verifier");
  }
  if (latestAttempt?.failureClass) {
    prevented.push(`unlabeled retry drift after ${latestAttempt.failureClass}`);
  }
  if (loop.cost.avoidedUsd > 0) {
    prevented.push("estimated additional provider spend");
  }
  if (loop.attempts.length >= loop.budget.maxIterations) {
    prevented.push("iteration cap overrun");
  }
  if (circuitBreak.assessment.status === "stalled") {
    prevented.push("trajectory-stalled retries before another verifier burn");
  }
  if (circuitBreak.assessment.status === "drifting") {
    prevented.push("objective drift from the original governed task");
  }

  return prevented.length > 0
    ? prevented
    : ["no additional prevention claim is available from this run record"];
}

function selectNextSafeAction(
  loop: LoopRecord,
  verification: VerificationSummary,
  rollbackEvidenceCount: number
): string {
  const circuitBreak = decideCircuitBreak({
    objective: loop.task.objective,
    verificationPlan: loop.task.verificationPlan,
    attempts: loop.attempts,
    remainingIterations: Math.max(loop.budget.maxIterations - loop.attempts.length, 0)
  });

  if (verification.status === "failed" || verification.status === "contradicted") {
    if (circuitBreak.shouldStop) {
      return `Debug loop ${loop.loopId} with verifier evidence first, then resolve the trajectory issue before another attempt: ${circuitBreak.reason}`;
    }
    return `Debug loop ${loop.loopId} before another attempt; start with verifier evidence and the latest failed attempt.`;
  }

  if (circuitBreak.shouldStop) {
    return `Do not spend another attempt on loop ${loop.loopId} until the trajectory issue is resolved: ${circuitBreak.reason}`;
  }

  if (loop.lifecycleState === "budget_exit" || loop.lifecycleState === "diminishing_returns") {
    return `Triage loop ${loop.loopId} and reset the budget or task scope only after reviewing the receipt.`;
  }

  if (loop.status === "completed" && verification.status === "passed") {
    return rollbackEvidenceCount > 0
      ? "Share the proof receipt with verifier and rollback evidence attached."
      : "Share the proof receipt only after deciding whether rollback evidence is required for this workflow.";
  }

  return `Run preflight before retrying loop ${loop.loopId}; keep verifier, budget, and path scope explicit.`;
}

function scoreLoop(loop: LoopRecord): TriageFinding {
  const verification = buildVerificationSummary(loop);
  const trajectory = assessTrajectory({
    objective: loop.task.objective,
    verificationPlan: loop.task.verificationPlan,
    attempts: loop.attempts
  });
  const reasons: string[] = [];
  let priority = 0;

  if (loop.status === "failed") {
    priority += 60;
    reasons.push("run_failed");
  }
  if (loop.lifecycleState === "budget_exit") {
    priority += 45;
    reasons.push("budget_exit");
  }
  if (loop.lifecycleState === "human_escalation") {
    priority += 35;
    reasons.push("human_escalation");
  }
  if (verification.status === "failed") {
    priority += 40;
    reasons.push("verification_failed");
  }
  if (verification.status === "contradicted") {
    priority += 55;
    reasons.push("verification_contradicted");
  }
  if (verification.status === "not_run") {
    priority += 10;
    reasons.push("verification_not_run");
  }
  if (verification.observation?.status === "mismatch") {
    priority += 30;
    reasons.push("change_observation_mismatch");
  }
  if (verification.observation?.status === "repo_only") {
    priority += 20;
    reasons.push("change_observation_repo_only");
  }
  if (verification.observation?.status === "adapter_only") {
    priority += 10;
    reasons.push("change_observation_adapter_only");
  }
  if (loop.attempts.length >= 3) {
    priority += 10;
    reasons.push("multi_attempt");
  }
  if (trajectory.status === "stalled") {
    priority += 35;
    reasons.push("trajectory_stalled");
  }
  if (trajectory.status === "drifting") {
    priority += 18;
    reasons.push("trajectory_drift");
  }

  const summary =
    verification.observation?.status === "mismatch"
      ? `${verification.summary} Change observation mismatch detected.`
      : trajectory.status === "stalled" || trajectory.status === "drifting"
        ? `${verification.summary} ${trajectory.summary}`
      : verification.summary;

  return {
    loopId: loop.loopId,
    priority,
    status: loop.status,
    lifecycleState: loop.lifecycleState,
    title: loop.task.title,
    summary,
    reasons,
    updatedAt: loop.updatedAt
  };
}

function selectObservationForAttempt(
  loop: LoopRecord,
  attemptIndex: number
): ChangeObservationReconciliation | undefined {
  const matching = loop.events
    .filter((event) => event.type === "observation.reconciled")
    .filter((event) => {
      const payload = isRecord(event.payload) ? event.payload : undefined;
      return payload?.["attemptIndex"] === attemptIndex;
    })
    .map((event) => {
      const payload = isRecord(event.payload) ? event.payload : undefined;
      const observation = payload?.["observation"];
      return isChangeObservationReconciliation(observation) ? observation : undefined;
    })
    .filter((candidate): candidate is ChangeObservationReconciliation => candidate !== undefined);

  return matching.at(-1);
}

function buildObservationWarnings(
  observation: ChangeObservationReconciliation | undefined
): string[] {
  if (!observation) {
    return [];
  }

  switch (observation.status) {
    case "mismatch":
      return ["Change observation mismatch: adapter-reported files differ from repo-observed files."];
    case "adapter_only":
      return ["Repo observation was unavailable; only adapter-reported change evidence is present."];
    case "repo_only":
      return ["Adapter did not report changed files; using repo-observed change evidence."];
    default:
      return [];
  }
}

function isChangeObservationReconciliation(
  value: unknown
): value is ChangeObservationReconciliation {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value["status"] === "string" &&
    typeof value["summary"] === "string" &&
    isObservationEvidence(value["adapterReported"]) &&
    isObservationEvidence(value["repoObserved"]) &&
    isStringArray(value["effectiveChangedFiles"]) &&
    isStringArray(value["matchedFiles"]) &&
    isStringArray(value["adapterOnlyFiles"]) &&
    isStringArray(value["repoOnlyFiles"]);
}

function isObservationEvidence(
  value: unknown
): value is ChangeObservationReconciliation["adapterReported"] {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value["available"] === "boolean" && isStringArray(value["changedFiles"]);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolveRunsRootPath(runsDir: string | undefined, invocationRoot = resolveInvocationRoot()): string {
  const configuredRunsRoot = runsDir?.trim() || resolveRunsRoot(process.env);
  return resolveAbsolutePath(configuredRunsRoot, invocationRoot);
}

function resolveAbsolutePath(targetPath: string, base = resolveInvocationRoot()): string {
  return path.isAbsolute(targetPath) ? path.normalize(targetPath) : path.resolve(base, targetPath);
}

function resolveReceiptIntegrity(loop: LoopRecord): ReceiptIntegritySummary {
  return (
    loop.receiptIntegrity ?? {
      state: "selector_noncanonical",
      reason: "Receipt integrity metadata was not available on the loop record."
    }
  );
}

function hasVerificationContradiction(
  warnings: string[],
  steps: VerificationStepSummary[]
): boolean {
  const normalizedWarnings = warnings.map((warning) => warning.toLowerCase());
  if (
    normalizedWarnings.some((warning) =>
      warning.includes("tool-launch problem before martinloop ran its own verifier") ||
      warning.includes("verification evidence conflicts")
    )
  ) {
    return true;
  }

  return steps.some((step) => step.launched === false);
}

export function resolveReceiptScope(loop: LoopRecord, runsRoot?: string): ReceiptScope | undefined {
  if (loop.receiptScope) {
    return loop.receiptScope;
  }

  if (!loop.task?.repoRoot && !runsRoot) {
    return undefined;
  }

  return {
    ...(loop.task?.repoRoot ? { repoRoot: loop.task.repoRoot } : {}),
    ...(loop.task?.repoRoot ? { workingDirectory: loop.task.repoRoot } : {}),
    ...(runsRoot ? { runsRoot } : {})
  };
}

function isWithinRunsRoot(runsRoot: string, candidatePath: string): boolean {
  const resolvedRoot = path.resolve(runsRoot);
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveReceiptEvidencePath(runDirectory: string): Promise<string> {
  for (const candidate of ["ledger.jsonl", "events.jsonl"]) {
    const candidatePath = path.join(runDirectory, candidate);
    const candidateStats = await stat(candidatePath).catch(() => null);
    if (candidateStats?.isFile()) {
      return candidatePath;
    }
  }

  return path.join(runDirectory, "ledger.jsonl");
}

async function loadLatestLoopFromWorkspaceIndexes(
  runsRoot: string,
  entries: ReadonlyArray<RunsDirEntry>,
  warnings: string[]
): Promise<LoopRecord | undefined> {
  let latestSummary: { loopId: string; updatedAt: string } | undefined;

  for (const entry of entries) {
    const entryName = String(entry.name);
    if (!entry.isFile() || !entryName.endsWith(".jsonl")) {
      continue;
    }

    try {
      const candidate = await readLatestWorkspaceIndexSummary(path.join(runsRoot, entryName));
      if (!candidate) {
        continue;
      }

      const candidateTimestamp = parseTimestamp(candidate.updatedAt);
      const latestTimestamp = latestSummary
        ? parseTimestamp(latestSummary.updatedAt)
        : Number.NEGATIVE_INFINITY;
      if (candidateTimestamp > latestTimestamp) {
        latestSummary = candidate;
      }
    } catch (error) {
      warnings.push(
        `Skipped unreadable workspace index '${entryName}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (!latestSummary) {
    return undefined;
  }

  try {
    return (await loadLoopById(latestSummary.loopId, runsRoot)).loop;
  } catch (error) {
    warnings.push(
      `Workspace index pointed at unreadable loop '${latestSummary.loopId}': ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

async function collectPersistedLoops(
  runsRoot: string,
  options: { maxEntries?: number } = {}
): Promise<{ loops: LoopRecord[]; warnings: string[] }> {
  const entries = await readdir(runsRoot, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissing(error)) {
      return [] as Awaited<ReturnType<typeof readdir>>;
    }

    throw new CliCommandError("store_unreadable", "Unable to read the Martin runs directory.", {
      suggestion: "Check MARTIN_RUNS_DIR or pass --runs-dir with a readable path."
    });
  });

  const warnings: string[] = [];
  const loopsById = new Map<string, LoopRecord>();

  const entriesToInspect =
    options.maxEntries !== undefined ? entries.slice(0, options.maxEntries) : entries;

  for (const entry of entriesToInspect) {
    try {
      const entryName = String(entry.name);
      if (entry.isDirectory()) {
        const canonical = await findCanonicalLoopRecordPath(path.join(runsRoot, entryName));
        if (!canonical) {
          continue;
        }
        const loop = await readLoopRecordFile(canonical);
        upsertLoop(loopsById, loop);
        continue;
      }

      if (!entry.isFile() || (!entryName.endsWith(".json") && !entryName.endsWith(".jsonl"))) {
        continue;
      }

      const loops = await readLoopsFromFile(path.join(runsRoot, entryName), runsRoot);
      for (const loop of loops) {
        upsertLoop(loopsById, loop);
      }
    } catch (error) {
      warnings.push(
        `Skipped unreadable persisted loop entry '${String(entry.name)}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return {
    loops: [...loopsById.values()].sort((left, right) => loopTimestamp(right) - loopTimestamp(left)),
    warnings
  };
}

async function loadLoopById(
  loopId: string,
  runsRoot: string
): Promise<Pick<PersistedLoopDetail, "source" | "loop" | "runDirectory" | "loopRecordPath">> {
  const runDirectory = path.join(runsRoot, loopId);
  const canonical = await findCanonicalLoopRecordPath(runDirectory);
  if (!canonical) {
    throw new CliCommandError("not_found", `Persisted Martin loop '${loopId}' was not found.`, {
      suggestion: "Check the loopId or point the command at the correct runs root with --runs-dir."
    });
  }

  return {
    source: canonical,
    loop: await readLoopRecordFile(canonical),
    runDirectory,
    loopRecordPath: canonical
  };
}

async function findCanonicalLoopRecordPath(runDirectory: string): Promise<string | undefined> {
  for (const candidate of ["loop-record.json", "loop.json"]) {
    const file = path.join(runDirectory, candidate);
    const fileStats = await stat(file).catch(() => null);
    if (fileStats?.isFile()) {
      return file;
    }
  }

  return undefined;
}

async function readLoopsFromFile(file: string, runsRoot: string): Promise<LoopRecord[]> {
  const contents = await readFile(file, "utf8");
  const candidates = parseUnknownLoopValues(contents, file);
  const loops: LoopRecord[] = [];

  for (const candidate of candidates) {
    if (isLoopRecord(candidate)) {
      loops.push(candidate);
      continue;
    }

    if (isLoopSummary(candidate)) {
      const resolved = await loadLoopById(candidate.loopId, runsRoot).catch(() => null);
      if (resolved?.loop) {
        loops.push(resolved.loop);
      }
    }
  }

  return dedupeLoops(loops);
}

async function readLoopRecordFile(file: string): Promise<LoopRecord> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (!isLoopRecord(parsed)) {
    throw new CliCommandError("store_unreadable", `Persisted loop file is not a canonical LoopRecord: ${file}`);
  }

  return parsed;
}

async function detectUnknownLoopTopLevelFieldWarnings(file: string): Promise<string[]> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    return [];
  }

  const unknownKeys = Object.keys(parsed).filter((key) => !LOOP_RECORD_TOP_LEVEL_KEYS.has(key));
  if (unknownKeys.length === 0) {
    return [];
  }

  return [
    `Untrusted loop record includes unknown top-level fields: ${unknownKeys.sort().join(", ")}. Treat this receipt as untrusted copied evidence.`
  ];
}

async function readLatestWorkspaceIndexSummary(
  file: string
): Promise<{ loopId: string; updatedAt: string } | undefined> {
  const contents = await readFile(file, "utf8");
  const lines = contents
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const latestLine = lines.at(-1);
  if (!latestLine) {
    return undefined;
  }

  const parsed = JSON.parse(latestLine) as unknown;
  if (!isWorkspaceIndexSummary(parsed)) {
    return undefined;
  }

  return {
    loopId: parsed.loopId,
    updatedAt: parsed.updatedAt
  };
}

function parseUnknownLoopValues(contents: string, file: string): unknown[] {
  if (file.endsWith(".jsonl")) {
    return contents
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  const parsed = JSON.parse(contents) as unknown;
  return Array.isArray(parsed) ? parsed : [parsed];
}

function isLoopRecord(value: unknown): value is LoopRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<LoopRecord>;
  return (
    typeof candidate.loopId === "string" &&
    typeof candidate.workspaceId === "string" &&
    typeof candidate.projectId === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.lifecycleState === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string" &&
    typeof candidate.task?.title === "string" &&
    typeof candidate.task?.objective === "string" &&
    Array.isArray(candidate.attempts) &&
    Array.isArray(candidate.events) &&
    Array.isArray(candidate.artifacts)
  );
}

function isLoopSummary(value: unknown): value is { loopId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { loopId?: unknown }).loopId === "string"
  );
}

function isWorkspaceIndexSummary(
  candidate: unknown
): candidate is {
  loopId: string;
  updatedAt: string;
} {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as { loopId?: unknown }).loopId === "string" &&
    typeof (candidate as { updatedAt?: unknown }).updatedAt === "string"
  );
}

function readVerificationWarnings(payload: Record<string, unknown> | undefined): string[] {
  if (!Array.isArray(payload?.["warnings"])) {
    return [];
  }

  return payload["warnings"].filter((warning): warning is string => typeof warning === "string");
}

function readVerificationSteps(payload: Record<string, unknown> | undefined): VerificationStepSummary[] {
  if (!Array.isArray(payload?.["steps"])) {
    return [];
  }

  return payload["steps"]
    .map((candidate) => normalizeVerificationStep(candidate))
    .filter((candidate): candidate is VerificationStepSummary => candidate !== undefined);
}

function normalizeVerificationStep(candidate: unknown): VerificationStepSummary | undefined {
  if (!isRecord(candidate)) {
    return undefined;
  }

  if (typeof candidate["command"] !== "string" || typeof candidate["launched"] !== "boolean") {
    return undefined;
  }

  return {
    command: candidate["command"],
    launched: candidate["launched"],
    ...(typeof candidate["exitCode"] === "number" ? { exitCode: candidate["exitCode"] } : {}),
    ...(typeof candidate["timedOut"] === "boolean" ? { timedOut: candidate["timedOut"] } : {}),
    ...(typeof candidate["fastFail"] === "boolean" ? { fastFail: candidate["fastFail"] } : {}),
    ...(typeof candidate["detail"] === "string" ? { detail: candidate["detail"] } : {})
  };
}

function dedupeLoops(loops: LoopRecord[]): LoopRecord[] {
  const byId = new Map<string, LoopRecord>();
  for (const loop of loops) {
    upsertLoop(byId, loop);
  }
  return [...byId.values()];
}

function upsertLoop(target: Map<string, LoopRecord>, loop: LoopRecord): void {
  const existing = target.get(loop.loopId);
  if (!existing || loopTimestamp(loop) >= loopTimestamp(existing)) {
    target.set(loop.loopId, loop);
  }
}

function loopTimestamp(loop: LoopRecord): number {
  return parseTimestamp(loop.updatedAt || loop.createdAt || "");
}

function parseTimestamp(timestamp: string | undefined): number {
  if (typeof timestamp !== "string") {
    return Number.NEGATIVE_INFINITY;
  }

  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "ENOENT";
}
