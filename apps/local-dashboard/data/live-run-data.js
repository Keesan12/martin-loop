import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function createEmptyOperatorData() {
  return {
    seedLabel: "No runs yet",
    currentRun: {
      loopId: "—",
      title: "No runs yet",
      repo: "—",
      objective: "Run Martin once to populate this dashboard with real persisted run data.",
      adapter: "—",
      model: "—",
      policyProfile: "—",
      state: "idle",
      attempt: 0,
      elapsed: "00:00:00",
      startedAt: "—"
    },
    budget: {
      hardLimitUsd: 0,
      softLimitUsd: 0,
      spentUsd: 0,
      tokensUsed: 0,
      maxTokens: 0,
      iterationsUsed: 0,
      maxIterations: 0,
      projectedExitUsd: 0,
      projectedExitNote: "No persisted run data found yet.",
      status: "empty",
      checkpoints: [
        { label: "Next step", value: "Run martin once" },
        { label: "Source", value: "~/.martin/runs/" }
      ]
    },
    attemptState: {
      phase: "idle",
      summary: "No runs yet.",
      activeStep: "Await first run",
      previousError: "None",
      interventionSelected: "None"
    },
    verifier: {
      status: "pending",
      summary: "No verifier activity yet.",
      lastGate: {
        label: "No runs yet",
        status: "pending",
        detail: "",
        timestamp: ""
      },
      nextGate: {
        label: "Run martin to start verification",
        status: "queued"
      },
      trend: []
    },
    effectivePolicy: {
      policyProfile: "Not loaded",
      destructiveActionPolicy: "approval",
      approvalRequired: true,
      allowedAdapters: [],
      allowedModels: [],
      telemetryDestination: "local-only",
      retentionPolicy: "local",
      provenance: [
        { field: "state", value: "No runs yet", source: "filesystem" }
      ]
    },
    replayResume: {
      exitReason: "No runs yet.",
      nextAction: "Start a run to see replay and resume guidance.",
      replayCommand: "martin run --objective \"Describe your task\" --max-iterations 3",
      resumeCommand: null
    },
    timeline: [],
    interventions: [],
    artifacts: [],
    benchmarkLab: {
      seedLabel: "No runs yet",
      title: "Benchmark data will appear after runs complete",
      summary: [
        { label: "Runs", value: "0" },
        { label: "Spend", value: "$0.00" }
      ],
      rows: []
    }
  };
}

export async function loadLatestRunDashboardData(options = {}) {
  const runsRoot = options.runsRoot ?? join(homedir(), ".martin", "runs");
  const entries = await readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  let latest = null;
  let latestUpdatedAt = "";

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const artifacts = await readRunArtifacts(join(runsRoot, entry.name)).catch(() => null);
    if (!artifacts) {
      continue;
    }

    const updatedAt = getLastTimestamp(artifacts.ledger, artifacts.contract.createdAt);
    if (!latest || updatedAt > latestUpdatedAt) {
      latest = artifacts;
      latestUpdatedAt = updatedAt;
    }
  }

  if (!latest) {
    return createEmptyOperatorData();
  }

  return mapRunArtifactsToDashboardData(latest);
}

export function mapRunArtifactsToDashboardData({ contract, state, ledger }) {
  const attempts = buildAttempts(ledger);
  const latestAttempt = attempts.at(-1) ?? null;
  const totals = buildTotals(ledger, attempts.length, contract.budget.maxIterations);
  const lifecycle = buildLifecycle(ledger);
  const updatedAt = getLastTimestamp(ledger, contract.createdAt);

  return {
    seedLabel: "Live Run Data",
    currentRun: {
      loopId: contract.runId,
      title: contract.task.title,
      repo: contract.projectId,
      objective: contract.task.objective,
      adapter: latestAttempt?.adapterId ?? "—",
      model: latestAttempt?.model ?? state?.activeModel ?? "—",
      policyProfile: state?.phase ?? "live",
      state: lifecycle.lifecycleState,
      attempt: attempts.length,
      elapsed: formatElapsed(contract.createdAt, updatedAt),
      startedAt: new Date(contract.createdAt).toLocaleString()
    },
    budget: {
      hardLimitUsd: contract.budget.maxUsd,
      softLimitUsd: contract.budget.softLimitUsd,
      spentUsd: totals.actualUsd,
      tokensUsed: totals.tokensIn + totals.tokensOut,
      maxTokens: contract.budget.maxTokens,
      iterationsUsed: attempts.length,
      maxIterations: contract.budget.maxIterations,
      projectedExitUsd: totals.projectedExitUsd,
      projectedExitNote: "Projected exit uses the observed average attempt cost from settled budget events.",
      status: lifecycle.lifecycleState,
      checkpoints: [
        { label: "Hard limit remaining", value: `$${Math.max(contract.budget.maxUsd - totals.actualUsd, 0).toFixed(2)}` },
        { label: "Soft limit remaining", value: `$${Math.max(contract.budget.softLimitUsd - totals.actualUsd, 0).toFixed(2)}` },
        { label: "Token headroom", value: Math.max(contract.budget.maxTokens - (totals.tokensIn + totals.tokensOut), 0).toLocaleString() },
        { label: "Iteration headroom", value: String(Math.max(contract.budget.maxIterations - attempts.length, 0)) }
      ]
    },
    attemptState: {
      phase: state?.phase ?? "unknown",
      summary: latestAttempt?.summary ?? "No attempts yet.",
      activeStep: contract.task.verificationPlan[0] ?? "—",
      previousError: latestAttempt?.failureClass ?? "None",
      interventionSelected: latestAttempt?.intervention ?? "None"
    },
    verifier: {
      status: latestAttempt?.verifierPassed ? "passed" : attempts.length > 0 ? "failed" : "pending",
      summary: latestAttempt?.verificationSummary ?? "No verifier activity yet.",
      lastGate: {
        label: latestAttempt?.verificationSummary ? "verification.completed" : "No runs yet",
        status: latestAttempt?.verifierPassed ? "passed" : attempts.length > 0 ? "failed" : "pending",
        detail: latestAttempt?.verificationSummary ?? "",
        timestamp: latestAttempt?.completedAt ? new Date(latestAttempt.completedAt).toLocaleTimeString() : ""
      },
      nextGate: {
        label: contract.task.verificationPlan[1] ?? contract.task.verificationPlan[0] ?? "—",
        status: lifecycle.lifecycleState === "running" ? "queued" : "done"
      },
      trend: attempts.map((attempt) => ({
        label: `Attempt ${String(attempt.attemptIndex)}`,
        status: attempt.verifierPassed ? "passed" : "failed",
        reason: attempt.verificationSummary ?? attempt.summary ?? ""
      }))
    },
    effectivePolicy: {
      policyProfile: state?.phase ?? "runtime policy",
      destructiveActionPolicy: "approval",
      approvalRequired: true,
      allowedAdapters: latestAttempt?.adapterId ? [latestAttempt.adapterId] : [],
      allowedModels: latestAttempt?.model ? [latestAttempt.model] : [],
      telemetryDestination: "local-only",
      retentionPolicy: "local",
      provenance: [
        { field: "maxUsd", value: String(contract.budget.maxUsd), source: "contract.json" },
        { field: "softLimitUsd", value: String(contract.budget.softLimitUsd), source: "contract.json" },
        { field: "maxIterations", value: String(contract.budget.maxIterations), source: "contract.json" }
      ]
    },
    replayResume: {
      exitReason: lifecycle.reason ?? `Loop state: ${lifecycle.lifecycleState}`,
      nextAction:
        lifecycle.lifecycleState === "completed"
          ? "Task verified and complete."
          : "Inspect the persisted artifacts under ~/.martin/runs/<runId>/ and rerun if needed.",
      replayCommand: `martin run --objective "${contract.task.objective.slice(0, 60)}" --max-iterations ${Math.max(contract.budget.maxIterations, 3)}`,
      resumeCommand: null
    },
    timeline: ledger.slice(-8).map((event) => ({
      time: new Date(event.timestamp).toLocaleTimeString(),
      attempt: event.attemptIndex ? `Attempt ${String(event.attemptIndex)}` : "Run",
      event: event.kind,
      tone:
        event.kind === "attempt.kept" || event.kind === "verification.completed"
          ? "positive"
          : event.kind.includes("violations") || event.kind === "attempt.discarded"
            ? "warning"
            : "neutral"
    })),
    interventions: attempts
      .filter((attempt) => attempt.intervention)
      .map((attempt) => ({
        title: attempt.intervention,
        detail: attempt.summary ?? "",
        status: "applied"
      })),
    artifacts: [],
    benchmarkLab: {
      seedLabel: "Run-derived summary",
      title: "Latest run attempt history",
      summary: [
        { label: "Actual spend", value: `$${totals.actualUsd.toFixed(2)}` },
        { label: "Attempts", value: String(attempts.length) },
        { label: "Outcome", value: lifecycle.lifecycleState }
      ],
      rows: attempts.map((attempt) => ({
        task: attempt.summary ?? contract.task.title,
        ralph: "—",
        martin: `Attempt ${String(attempt.attemptIndex)}`,
        tone: attempt.verifierPassed ? "positive" : "warning",
        takeaway: attempt.verifierPassed ? "Verification passed" : (attempt.failureClass ?? "Needs review")
      }))
    }
  };
}

async function readRunArtifacts(runDirectory) {
  const contract = JSON.parse(await readFile(join(runDirectory, "contract.json"), "utf8"));
  const state = await readOptionalJson(join(runDirectory, "state.json"));
  const ledger = await readLedger(join(runDirectory, "ledger.jsonl"));
  return { contract, state, ledger };
}

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function readLedger(path) {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function buildAttempts(ledger) {
  const attempts = new Map();

  for (const event of ledger) {
    if (typeof event.attemptIndex !== "number") {
      continue;
    }

    const current = attempts.get(event.attemptIndex) ?? {
      attemptIndex: event.attemptIndex,
      adapterId: null,
      model: null,
      summary: null,
      failureClass: null,
      intervention: null,
      verifierPassed: null,
      verificationSummary: null,
      completedAt: null
    };

    if (event.kind === "attempt.admitted") {
      current.adapterId = event.payload?.adapterId ?? current.adapterId;
      current.model = event.payload?.model ?? current.model;
    }

    if (event.kind === "patch.generated") {
      current.summary = event.payload?.summary ?? current.summary;
    }

    if (event.kind === "verification.completed") {
      current.verifierPassed = event.payload?.passed === true;
      current.verificationSummary = event.payload?.summary ?? current.verificationSummary;
      current.completedAt = event.timestamp;
    }

    if (event.kind === "attempt.discarded") {
      current.failureClass = event.payload?.reason ?? current.failureClass;
      current.completedAt = event.timestamp;
    }

    if (event.kind === "attempt.kept") {
      current.completedAt = event.timestamp;
    }

    attempts.set(event.attemptIndex, current);
  }

  return [...attempts.values()].sort((left, right) => left.attemptIndex - right.attemptIndex);
}

function buildTotals(ledger, attemptsCount, maxIterations) {
  let actualUsd = 0;
  let estimatedUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;

  for (const event of ledger) {
    if (event.kind !== "budget.settled") {
      continue;
    }
    actualUsd += numberOrZero(event.payload?.actualUsd);
    estimatedUsd += numberOrZero(event.payload?.estimatedUsd);
    tokensIn += numberOrZero(event.payload?.tokensIn);
    tokensOut += numberOrZero(event.payload?.tokensOut);
  }

  const averageAttemptCost = attemptsCount === 0 ? 0 : actualUsd / attemptsCount;

  return {
    actualUsd,
    estimatedUsd,
    tokensIn,
    tokensOut,
    projectedExitUsd: Number((actualUsd + averageAttemptCost * Math.max(maxIterations - attemptsCount, 0)).toFixed(2))
  };
}

function buildLifecycle(ledger) {
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const event = ledger[index];
    if (event.kind === "run.exited") {
      return {
        lifecycleState: event.payload?.lifecycleState ?? "exited",
        reason: event.payload?.reason ?? null
      };
    }
  }

  return {
    lifecycleState: "running",
    reason: null
  };
}

function getLastTimestamp(ledger, fallback) {
  return ledger.reduce((latest, event) => (event.timestamp > latest ? event.timestamp : latest), fallback);
}

function formatElapsed(start, end) {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const seconds = Math.max(Math.floor(ms / 1000), 0);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
