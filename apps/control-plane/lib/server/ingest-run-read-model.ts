import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  AttemptRow,
  BudgetMetricRow,
  ControlPlaneRepository,
  EventRow,
  RunGraph,
  RunRow,
  SpendProvenance,
  ViolationRow
} from "./control-plane-repository.js";

interface PersistedRunContract {
  runId: string;
  workspaceId: string;
  projectId: string;
  task: {
    title: string;
    objective: string;
    repoRoot?: string;
    verificationPlan: string[];
  };
  budget: {
    maxUsd: number;
    softLimitUsd: number;
    maxIterations: number;
    maxTokens: number;
  };
  createdAt: string;
}

interface PersistedMachineState {
  phase?: string;
  currentAttempt?: number;
  activeModel?: string;
}

interface PersistedLedgerEvent {
  kind: string;
  runId: string;
  attemptIndex?: number;
  timestamp: string;
  payload: Record<string, unknown>;
}

interface PersistedAttemptArtifacts {
  groundingViolationCount?: number;
  groundingContentOnly?: boolean;
  groundingResolvedFiles?: string[];
  safetyViolationCount?: number;
  safetySurface?: string | null;
  safetyBlocked?: boolean;
  safetyProfile?: string | null;
  patchDecision?: string | null;
  patchSummary?: string | null;
  patchReasonCodes?: string[];
  patchScore?: number | null;
}

export async function ingestRunsIntoControlPlane(
  repository: ControlPlaneRepository,
  options: {
    runsRoot?: string;
  } = {}
): Promise<{ runCount: number }> {
  const runsRoot = options.runsRoot ?? join(homedir(), ".martin", "runs");
  const entries = await readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  let runCount = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const graph = await readRunGraph(join(runsRoot, entry.name)).catch(() => null);
    if (!graph) {
      continue;
    }

    await repository.replaceRunGraph(graph);
    runCount += 1;
  }

  return { runCount };
}

export async function readRunGraph(runDirectory: string): Promise<RunGraph> {
  const contract = JSON.parse(
    await readFile(join(runDirectory, "contract.json"), "utf8")
  ) as PersistedRunContract;

  const state = await readOptionalJson<PersistedMachineState>(join(runDirectory, "state.json"));
  const ledger = await readLedger(join(runDirectory, "ledger.jsonl"));
  const attemptArtifacts = await readAttemptArtifacts(runDirectory);

  return buildRunGraph(contract, state, ledger, attemptArtifacts);
}

export function buildRunGraph(
  contract: PersistedRunContract,
  state: PersistedMachineState | null,
  ledger: PersistedLedgerEvent[],
  attemptArtifacts: Map<number, PersistedAttemptArtifacts> = new Map()
): RunGraph {
  const attempts = new Map<number, AttemptRow>();
  const events: EventRow[] = [];
  const violations: ViolationRow[] = [];
  const budgetMetrics: BudgetMetricRow[] = [];

  let actualUsd = 0;
  let estimatedUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let keptAttempts = 0;
  let discardedAttempts = 0;
  let adapterId: string | null = null;
  let providerId: string | null = null;
  let transport: string | null = null;
  let activeModel = state?.activeModel ?? null;
  let lifecycleState = "running";
  let status = "running";
  let stopReason: string | null = null;
  let lastTimestamp = contract.createdAt;

  for (const event of ledger) {
    const attemptIndex = event.attemptIndex ?? null;
    lastTimestamp = maxIso(lastTimestamp, event.timestamp);

    events.push({
      eventId: `${event.runId}:${event.kind}:${attemptIndex ?? "run"}:${event.timestamp}`,
      runId: event.runId,
      attemptIndex,
      kind: event.kind,
      lifecycleState: readString(event.payload.lifecycleState) ?? null,
      timestamp: event.timestamp,
      payload: event.payload
    });

    if (event.attemptIndex !== undefined) {
      attempts.set(
        event.attemptIndex,
        mergeAttempt(attempts.get(event.attemptIndex), {
          runId: contract.runId,
          attemptIndex: event.attemptIndex
        })
      );
    }

    switch (event.kind) {
      case "attempt.admitted": {
        const row = mergeAttempt(attempts.get(event.attemptIndex ?? 0), {
          runId: contract.runId,
          attemptIndex: event.attemptIndex ?? 0,
          adapterId: readString(event.payload.adapterId),
          providerId: readString(event.payload.providerId),
          model: readString(event.payload.model),
          transport: readString(event.payload.transport),
          startedAt: event.timestamp
        });
        attempts.set(row.attemptIndex, row);
        adapterId = row.adapterId;
        providerId = row.providerId;
        transport = row.transport;
        activeModel = row.model ?? activeModel;
        break;
      }

      case "patch.generated": {
        const attempt = attempts.get(event.attemptIndex ?? 0);
        if (attempt) {
          attempts.set(
            attempt.attemptIndex,
            mergeAttempt(attempt, {
              runId: attempt.runId,
              attemptIndex: attempt.attemptIndex,
              status: readString(event.payload.status),
              summary: readString(event.payload.summary)
            })
          );
        }
        break;
      }

      case "verification.completed": {
        const attempt = attempts.get(event.attemptIndex ?? 0);
        if (attempt) {
          attempts.set(
            attempt.attemptIndex,
            mergeAttempt(attempt, {
              runId: attempt.runId,
              attemptIndex: attempt.attemptIndex,
              verifierPassed: readBoolean(event.payload.passed),
              verificationSummary: readString(event.payload.summary),
              completedAt: event.timestamp
            })
          );
        }
        break;
      }

      case "attempt.kept": {
        keptAttempts += 1;
        const attempt = attempts.get(event.attemptIndex ?? 0);
        if (attempt) {
          attempts.set(
            attempt.attemptIndex,
            mergeAttempt(attempt, {
              runId: attempt.runId,
              attemptIndex: attempt.attemptIndex,
              patchDecision: readString(event.payload.decision),
              patchSummary: readString(event.payload.reason),
              patchReasonCodes: readStringArray(event.payload.reasonCodes),
              patchScore: readNullableNumber(event.payload.score)
            })
          );
        }
        break;
      }

      case "attempt.discarded": {
        discardedAttempts += 1;
        const attempt = attempts.get(event.attemptIndex ?? 0);
        if (attempt) {
          attempts.set(
            attempt.attemptIndex,
            mergeAttempt(attempt, {
              runId: attempt.runId,
              attemptIndex: attempt.attemptIndex,
              patchDecision: readString(event.payload.decision),
              patchSummary: readString(event.payload.reason),
              patchReasonCodes: readStringArray(event.payload.reasonCodes),
              patchScore: readNullableNumber(event.payload.score)
            })
          );
        }
        break;
      }

      case "budget.settled": {
        const provenance = (readString(event.payload.provenance) ?? "unavailable") as SpendProvenance;
        const actual = readNumber(event.payload.actualUsd);
        const estimated = readNumber(event.payload.estimatedUsd);
        const inTokens = readNumber(event.payload.tokensIn);
        const outTokens = readNumber(event.payload.tokensOut);

        actualUsd += actual;
        estimatedUsd += estimated;
        tokensIn += inTokens;
        tokensOut += outTokens;
        adapterId = readString(event.payload.adapterId) ?? adapterId;
        providerId = readString(event.payload.providerId) ?? providerId;
        transport = readString(event.payload.transport) ?? transport;
        activeModel = readString(event.payload.model) ?? activeModel;

        budgetMetrics.push({
          metricId: `${event.runId}:${String(event.attemptIndex ?? 0)}:budget`,
          runId: event.runId,
          attemptIndex: event.attemptIndex ?? 0,
          actualUsd: actual,
          estimatedUsd: estimated,
          provenance,
          patchCostUsd: readNestedNumber(event.payload, ["patchCost", "usd"]),
          verificationCostUsd: readNestedNumber(event.payload, ["verificationCost", "usd"]),
          varianceUsd: readNumber(event.payload.varianceUsd),
          tokensIn: inTokens,
          tokensOut: outTokens,
          createdAt: event.timestamp
        });
        const attempt = attempts.get(event.attemptIndex ?? 0);
        if (attempt) {
          attempts.set(
            attempt.attemptIndex,
            mergeAttempt(attempt, {
              runId: attempt.runId,
              attemptIndex: attempt.attemptIndex,
              budgetActualUsd: actual,
              budgetEstimatedUsd: estimated,
              budgetVarianceUsd: readNumber(event.payload.varianceUsd),
              budgetProvenance: provenance
            })
          );
        }
        break;
      }

      case "grounding.violations_found":
      case "safety.violations_found": {
        const details = Array.isArray(event.payload.violations)
          ? event.payload.violations.map((value) => normalizeViolationDetail(value))
          : [];

        for (const [index, detail] of details.entries()) {
          violations.push({
            violationId: `${event.runId}:${String(event.attemptIndex ?? 0)}:${event.kind}:${String(index)}`,
            runId: event.runId,
            attemptIndex,
            surface:
              readString(event.payload.surface)
              ?? (event.kind.startsWith("grounding") ? "grounding" : "safety"),
            blocked: readBoolean(event.payload.blocked),
            violationKind: event.kind,
            detail,
            createdAt: event.timestamp
          });
        }

        const attempt = attempts.get(event.attemptIndex ?? 0);
        if (attempt) {
          if (event.kind === "grounding.violations_found") {
            attempts.set(
              attempt.attemptIndex,
              mergeAttempt(attempt, {
                runId: attempt.runId,
                attemptIndex: attempt.attemptIndex,
                groundingViolationCount:
                  readNumber(event.payload.violationCount) || details.length,
                groundingContentOnly: readBoolean(event.payload.contentOnly),
                groundingResolvedFiles: readStringArray(event.payload.resolvedFiles)
              })
            );
          } else {
            attempts.set(
              attempt.attemptIndex,
              mergeAttempt(attempt, {
                runId: attempt.runId,
                attemptIndex: attempt.attemptIndex,
                safetyViolationCount: details.length,
                safetySurface: readString(event.payload.surface),
                safetyBlocked: readBoolean(event.payload.blocked),
                safetyProfile: readString(event.payload.profile)
              })
            );
          }
        }
        break;
      }

      case "run.exited":
        lifecycleState = readString(event.payload.lifecycleState) ?? lifecycleState;
        status = readString(event.payload.status) ?? status;
        stopReason = readString(event.payload.reason) ?? stopReason;
        break;
    }
  }

  for (const [attemptIndex, artifacts] of attemptArtifacts.entries()) {
    const incoming: Partial<AttemptRow> & Pick<AttemptRow, "runId" | "attemptIndex"> = {
      runId: contract.runId,
      attemptIndex
    };

    if (artifacts.groundingViolationCount !== undefined) {
      incoming.groundingViolationCount = artifacts.groundingViolationCount;
    }
    if (artifacts.groundingContentOnly !== undefined) {
      incoming.groundingContentOnly = artifacts.groundingContentOnly;
    }
    if (artifacts.groundingResolvedFiles !== undefined) {
      incoming.groundingResolvedFiles = artifacts.groundingResolvedFiles;
    }
    if (artifacts.safetyViolationCount !== undefined) {
      incoming.safetyViolationCount = artifacts.safetyViolationCount;
    }
    if (artifacts.safetySurface !== undefined) {
      incoming.safetySurface = artifacts.safetySurface;
    }
    if (artifacts.safetyBlocked !== undefined) {
      incoming.safetyBlocked = artifacts.safetyBlocked;
    }
    if (artifacts.safetyProfile !== undefined) {
      incoming.safetyProfile = artifacts.safetyProfile;
    }
    if (artifacts.patchDecision !== undefined) {
      incoming.patchDecision = artifacts.patchDecision;
    }
    if (artifacts.patchSummary !== undefined) {
      incoming.patchSummary = artifacts.patchSummary;
    }
    if (artifacts.patchReasonCodes !== undefined) {
      incoming.patchReasonCodes = artifacts.patchReasonCodes;
    }
    if (artifacts.patchScore !== undefined) {
      incoming.patchScore = artifacts.patchScore;
    }

    attempts.set(
      attemptIndex,
      mergeAttempt(attempts.get(attemptIndex), incoming)
    );
  }

  const attemptRows = [...attempts.values()].sort(
    (left, right) => left.attemptIndex - right.attemptIndex
  );

  const avgAttemptCost =
    attemptRows.length === 0 ? 0 : actualUsd / Math.max(attemptRows.length, 1);
  const modeledAvoidedUsd = roundUsd(
    Math.max(contract.budget.maxIterations - attemptRows.length, 0) * avgAttemptCost
  );
  const costProvenance = selectRunProvenance(budgetMetrics);
  const latestPatchAttempt = [...attemptRows]
    .reverse()
    .find((attempt) => attempt.patchDecision !== null);
  const latestSafetyAttempt = [...attemptRows]
    .reverse()
    .find((attempt) => attempt.safetySurface !== null);
  const groundingViolationCount = attemptRows.reduce(
    (total, attempt) => total + attempt.groundingViolationCount,
    0
  );
  const groundingContentOnlyCount = attemptRows.reduce(
    (total, attempt) =>
      total + (attempt.groundingContentOnly ? attempt.groundingViolationCount : 0),
    0
  );
  const blockedSafetyViolationCount = attemptRows.reduce(
    (total, attempt) =>
      total + (attempt.safetyBlocked ? attempt.safetyViolationCount : 0),
    0
  );
  const budgetVarianceUsd = roundUsd(
    budgetMetrics.reduce((total, metric) => total + metric.varianceUsd, 0)
  );

  const run: RunRow = {
    runId: contract.runId,
    workspaceId: contract.workspaceId,
    projectId: contract.projectId,
    title: contract.task.title,
    objective: contract.task.objective,
    repoRoot: contract.task.repoRoot ?? null,
    status,
    lifecycleState,
    stopReason,
    activeModel,
    adapterId,
    providerId,
    transport,
    actualUsd: roundUsd(actualUsd),
    estimatedUsd: roundUsd(estimatedUsd),
    costProvenance,
    modeledAvoidedUsd,
    tokensIn,
    tokensOut,
    attemptsCount: attemptRows.length,
    keptAttempts,
    discardedAttempts,
    latestPatchDecision: latestPatchAttempt?.patchDecision ?? null,
    latestPatchSummary: latestPatchAttempt?.patchSummary ?? null,
    latestPatchReasonCodes: latestPatchAttempt?.patchReasonCodes ?? [],
    latestPatchScore: latestPatchAttempt?.patchScore ?? null,
    groundingViolationCount,
    groundingContentOnlyCount,
    blockedSafetyViolationCount,
    lastSafetySurface: latestSafetyAttempt?.safetySurface ?? null,
    budgetVarianceUsd,
    accountingMode: costProvenance,
    createdAt: contract.createdAt,
    updatedAt: lastTimestamp
  };

  return {
    run,
    attempts: attemptRows,
    events,
    violations,
    budgetMetrics
  };
}

function mergeAttempt(
  current: AttemptRow | undefined,
  incoming: Partial<AttemptRow> & Pick<AttemptRow, "runId" | "attemptIndex">
): AttemptRow {
  return {
    runId: incoming.runId,
    attemptIndex: incoming.attemptIndex,
    adapterId: incoming.adapterId ?? current?.adapterId ?? null,
    providerId: incoming.providerId ?? current?.providerId ?? null,
    model: incoming.model ?? current?.model ?? null,
    transport: incoming.transport ?? current?.transport ?? null,
    status: incoming.status ?? current?.status ?? null,
    summary: incoming.summary ?? current?.summary ?? null,
    failureClass: incoming.failureClass ?? current?.failureClass ?? null,
    intervention: incoming.intervention ?? current?.intervention ?? null,
    verifierPassed: incoming.verifierPassed ?? current?.verifierPassed ?? null,
    verificationSummary: incoming.verificationSummary ?? current?.verificationSummary ?? null,
    patchDecision: incoming.patchDecision ?? current?.patchDecision ?? null,
    patchSummary: incoming.patchSummary ?? current?.patchSummary ?? null,
    patchReasonCodes: incoming.patchReasonCodes ?? current?.patchReasonCodes ?? [],
    patchScore: incoming.patchScore ?? current?.patchScore ?? null,
    groundingViolationCount: incoming.groundingViolationCount ?? current?.groundingViolationCount ?? 0,
    groundingContentOnly: incoming.groundingContentOnly ?? current?.groundingContentOnly ?? false,
    groundingResolvedFiles: incoming.groundingResolvedFiles ?? current?.groundingResolvedFiles ?? [],
    safetyViolationCount: incoming.safetyViolationCount ?? current?.safetyViolationCount ?? 0,
    safetySurface: incoming.safetySurface ?? current?.safetySurface ?? null,
    safetyBlocked: incoming.safetyBlocked ?? current?.safetyBlocked ?? false,
    safetyProfile: incoming.safetyProfile ?? current?.safetyProfile ?? null,
    budgetActualUsd: incoming.budgetActualUsd ?? current?.budgetActualUsd ?? 0,
    budgetEstimatedUsd: incoming.budgetEstimatedUsd ?? current?.budgetEstimatedUsd ?? 0,
    budgetVarianceUsd: incoming.budgetVarianceUsd ?? current?.budgetVarianceUsd ?? 0,
    budgetProvenance: incoming.budgetProvenance ?? current?.budgetProvenance ?? null,
    startedAt: incoming.startedAt ?? current?.startedAt ?? null,
    completedAt: incoming.completedAt ?? current?.completedAt ?? null
  };
}

async function readLedger(path: string): Promise<PersistedLedgerEvent[]> {
  const contents = await readFile(path, "utf8").catch(() => "");
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PersistedLedgerEvent);
}

async function readOptionalJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function readAttemptArtifacts(runDirectory: string): Promise<Map<number, PersistedAttemptArtifacts>> {
  const artifactsRoot = join(runDirectory, "artifacts");
  const entries = await readdir(artifactsRoot, { withFileTypes: true }).catch(() => []);
  const artifacts = new Map<number, PersistedAttemptArtifacts>();

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const match = /^attempt-(\d+)$/.exec(entry.name);
    if (!match) {
      continue;
    }

    const attemptIndex = Number(match[1]);
    const directory = join(artifactsRoot, entry.name);
    const groundingScan = await readOptionalJson<Record<string, unknown>>(join(directory, "grounding-scan.json"));
    const leash = await readOptionalJson<Record<string, unknown>>(join(directory, "leash.json"));
    const patchScore = await readOptionalJson<Record<string, unknown>>(join(directory, "patch-score.json"));
    const patchDecision = await readOptionalJson<Record<string, unknown>>(join(directory, "patch-decision.json"));

    artifacts.set(attemptIndex, {
      groundingViolationCount:
        readNumber(groundingScan?.["violationCount"]) || countEntries(groundingScan?.["violations"]),
      groundingContentOnly: readBoolean(groundingScan?.["contentOnly"]),
      groundingResolvedFiles: readStringArray(groundingScan?.["resolvedFiles"]),
      safetyViolationCount: countEntries(leash?.["violations"]),
      safetySurface: readString(leash?.["surface"]),
      safetyBlocked: readBoolean(leash?.["blocked"]),
      safetyProfile: readString(leash?.["profile"]),
      patchDecision: readString(patchDecision?.["decision"]),
      patchSummary: readString(patchDecision?.["summary"]),
      patchReasonCodes: readStringArray(patchDecision?.["reasonCodes"]),
      patchScore: readNullableNumber(patchScore?.["score"])
    });
  }

  return artifacts;
}

function normalizeViolationDetail(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const detail = (value as Record<string, unknown>).detail;
    if (typeof detail === "string") {
      return detail;
    }
    return JSON.stringify(value);
  }

  return String(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNestedNumber(value: unknown, path: string[]): number {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== "object") {
      return 0;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return readNumber(current);
}

function maxIso(left: string, right: string): string {
  return left.localeCompare(right) >= 0 ? left : right;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function countEntries(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function selectRunProvenance(metrics: BudgetMetricRow[]): SpendProvenance {
  if (metrics.some((metric) => metric.provenance === "actual")) {
    return "actual";
  }
  if (metrics.some((metric) => metric.provenance === "estimated")) {
    return "estimated";
  }
  return "unavailable";
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
