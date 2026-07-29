// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { accessSync, constants } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type {
  LoopArtifact,
  LoopBudget,
  LoopCost,
  LoopEvent,
  LoopTask,
  ReceiptIntegritySummary,
  ReceiptScope
} from "@martin/contracts";
import {
  evaluateCostGovernor,
  resolveRunsRoot,
  type LedgerEvent,
  type LoopAttemptRecord,
  type LoopRunRecord
} from "@martin/core";

import { readAllLoopRecordsSafely } from "./run-store.js";

export const MARTIN_ENGINE_VALUES = ["claude", "codex", "gemini", "openai"] as const;
export type MartinEngine = (typeof MARTIN_ENGINE_VALUES)[number];

export interface InspectableLoopAttempt extends LoopAttemptRecord {
  attemptId?: string;
  summary?: string;
}

export interface InspectableLoopRecord extends Omit<LoopRunRecord, "attempts" | "task"> {
  attempts: InspectableLoopAttempt[];
  task?: LoopTask;
  artifacts?: LoopArtifact[];
  events?: LoopEvent[];
  metadata?: Record<string, string>;
  receiptIntegrity?: ReceiptIntegritySummary;
  receiptScope?: ReceiptScope;
  routingEconomics?: import("@martin/contracts").RoutingEconomics;
}

export interface LoopPreview {
  loopId: string;
  title: string;
  objective: string;
  status: string;
  lifecycleState: string;
  createdAt?: string;
  updatedAt?: string;
  attempts: number;
  costUsd: number;
  avoidedUsd: number;
  pressure: string;
  shouldStop: boolean;
  remainingBudgetUsd: number;
  remainingIterations: number;
  remainingTokens: number;
  lastAttempt?: AttemptSummary;
  routingEconomics?: Record<string, unknown>;
}

export interface AttemptArtifactFiles {
  directory: string;
  available: boolean;
  files: string[];
}

export interface AttemptSummary {
  index: number;
  attemptId?: string;
  adapterId?: string;
  model?: string;
  failureClass?: string;
  intervention?: string;
  startedAt?: string;
  completedAt?: string;
  summary?: string;
  artifacts?: AttemptArtifactFiles;
}

export interface ArtifactSummary {
  totalCount: number;
  kinds: Record<string, number>;
  highlights: Array<{
    artifactId: string;
    kind: string;
    label: string;
    uri: string;
  }>;
}

export interface VerificationSummary {
  status: "passed" | "failed" | "contradicted" | "not_run";
  eventCount: number;
  ledgerEventCount: number;
  latestAttemptIndex?: number;
  completedAt?: string;
  summary?: string;
  warnings: string[];
}

interface NormalizedVerificationEvidence {
  timestamp: string;
  passed?: boolean;
  summary?: string;
  attemptId?: string;
  attemptIndex?: number;
}

export interface RunWarningEnvelope {
  warnings: string[];
}

export interface EventSummary {
  type: string;
  timestamp?: string;
  lifecycleState?: string;
  payload: Record<string, unknown>;
}

export interface LoopCollectionSummary {
  latestRun?: LoopPreview;
  recentRuns: LoopPreview[];
  statusBreakdown: Record<string, number>;
  lifecycleBreakdown: Record<string, number>;
}

export interface CliAvailability {
  command: string;
  available: boolean;
  locator: string;
  detail: string;
  resolvedPath?: string;
  candidatePaths?: string[];
}

export interface ExecutionMode {
  liveMode: boolean;
  mode: "live" | "proof";
  detail: string;
}

export interface RunStoreInspection extends LoopCollectionSummary {
  runsRoot: string;
  exists: boolean;
  loopCount: number;
  warnings: string[];
}

export interface CanonicalRunPaths {
  runsRoot: string;
  runDirectory: string;
  loopRecordPath: string;
  ledgerPath: string;
}

const CLI_CACHE_TTL_MS = 60_000;
const RUN_STORE_CACHE_TTL_MS = 5_000;

const cliAvailabilityCache = new Map<
  string,
  { expiresAt: number; value: CliAvailability }
>();
const runStoreInspectionCache = new Map<
  string,
  { expiresAt: number; value: RunStoreInspection }
>();

export function resolveExecutionMode(): ExecutionMode {
  const liveMode = process.env.MARTIN_LIVE !== "false";
  return {
    liveMode,
    mode: liveMode ? "live" : "proof",
    detail: liveMode
      ? "Live CLI execution is enabled."
      : "Proof mode is active because MARTIN_LIVE=false."
  };
}

export function detectCliAvailability(command: string): CliAvailability {
  const cacheKey = `${process.platform}:${command}`;
  const cached = cliAvailabilityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const locator = process.platform === "win32" ? "path-scan(win32)" : "path-scan(posix)";
  const resolvedPath = findCommandOnPath(command);

  const value: CliAvailability =
    resolvedPath
      ? {
          command,
          available: true,
          locator,
          detail: isOnPathDirectly(command, resolvedPath)
            ? `${command} is available on PATH.`
            : `${command} found at ${resolvedPath} (not on PATH, auto-discovered).`,
          ...(resolvedPath ? { resolvedPath } : {})
        }
      : {
          command,
          available: false,
          locator,
          detail: `${command} is not installed. ${suggestInstallCommand(command)}`
        };

  cliAvailabilityCache.set(cacheKey, {
    expiresAt: Date.now() + CLI_CACHE_TTL_MS,
    value
  });

  return value;
}

function findCommandOnPath(command: string): string | undefined {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path");
  const rawPath = pathKey ? process.env[pathKey] : undefined;

  const hasExtension = /\.[A-Za-z0-9]+$/u.test(command);
  const candidateNames =
    process.platform === "win32" && !hasExtension
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((extension) => extension.trim())
          .filter(Boolean)
          .map((extension) => `${command}${extension.toLowerCase()}`)
      : [command];

  // 1. Search PATH entries
  if (rawPath) {
    const pathEntries = rawPath
      .split(process.platform === "win32" ? ";" : ":")
      .map((entry) => entry.trim())
      .filter(Boolean);

    for (const directory of pathEntries) {
      for (const candidateName of candidateNames) {
        const candidatePath = join(directory, candidateName);
        if (isExecutablePath(candidatePath)) {
          return candidatePath;
        }
      }
    }
  }

  // 2. Search common install locations when PATH didn't find it.
  //    This catches CLIs installed via npm/brew/pip that aren't on the
  //    current shell's PATH (common in IDEs, CI, and agent environments).
  for (const directory of discoverCommonInstallDirectories(command)) {
    for (const candidateName of candidateNames) {
      const candidatePath = join(directory, candidateName);
      if (isExecutablePath(candidatePath)) {
        return candidatePath;
      }
    }
  }

  return undefined;
}

/**
 * Returns directories where CLI tools are commonly installed but may not
 * be on PATH. Checked only as a fallback after PATH search fails.
 */
function discoverCommonInstallDirectories(command: string): string[] {
  const dirs: string[] = [];
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";

  if (process.platform === "win32") {
    // npm global bin (Roaming)
    const appData = process.env.APPDATA;
    if (appData) {
      dirs.push(join(appData, "npm"));
    }
    // Codex desktop install
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      dirs.push(join(localAppData, "OpenAI", "Codex", "bin"));
    }
    // Claude Code native installer places binary at %USERPROFILE%\.local\bin
    const userProfile = process.env.USERPROFILE ?? process.env.HOMEPATH;
    if (userProfile) {
      dirs.push(join(userProfile, ".local", "bin"));
    }
    // Scoop
    if (home) {
      dirs.push(join(home, "scoop", "shims"));
    }
  } else {
    // Common Unix install paths
    dirs.push("/usr/local/bin", "/opt/homebrew/bin");
    if (home) {
      dirs.push(
        join(home, ".local", "bin"),            // pip, pipx
        join(home, ".npm-global", "bin"),        // npm prefix
        join(home, ".bun", "bin"),               // bun
        join(home, ".cargo", "bin"),             // cargo
        join(home, "go", "bin")                  // go install
      );
    }
    // nvm managed node
    const nvmDir = process.env.NVM_DIR;
    if (nvmDir) {
      const nvmBin = join(nvmDir, "current", "bin");
      dirs.push(nvmBin);
    }
  }

  return dirs.filter(Boolean);
}

function isExecutablePath(candidatePath: string): boolean {
  try {
    accessSync(
      candidatePath,
      process.platform === "win32" ? constants.F_OK : constants.X_OK
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true if the resolved path is inside a directory that's already
 * on PATH (i.e., it was found via normal PATH lookup, not auto-discovery).
 */
function isOnPathDirectly(command: string, resolvedPath: string): boolean {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path");
  const rawPath = pathKey ? process.env[pathKey] : undefined;
  if (!rawPath) return false;

  const pathEntries = rawPath
    .split(process.platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim().replace(/[\\/]+$/u, ""))
    .filter(Boolean);

  const resolvedDir = resolvedPath
    .replace(/[\\/][^\\/]+$/u, "")
    .replace(/[\\/]+$/u, "");

  return pathEntries.some(
    (entry) => entry.toLowerCase() === resolvedDir.toLowerCase()
  );
}

/**
 * Returns a platform-specific one-liner install command for a known CLI.
 */
function suggestInstallCommand(command: string): string {
  if (command === "claude") {
    const installCmd = process.platform === "win32"
      ? "irm https://claude.ai/install.ps1 | iex"
      : "curl -fsSL https://claude.ai/install.sh | bash";
    return `Install with: ${installCmd}`;
  }

  const npmInstalls: Record<string, string> = {
    codex: "npm install -g @openai/codex",
    gemini: "npm install -g @google/gemini-cli"
  };

  const install = npmInstalls[command];
  if (install) {
    return `Install with: ${install}`;
  }

  return `Install ${command} and ensure it is on PATH.`;
}

export function getEngineAvailability(engine: MartinEngine): CliAvailability {
  return detectCliAvailability(engine);
}

export function createSkippedCliAvailability(
  command: string,
  detail = "Proof mode skipped live CLI availability detection."
): CliAvailability {
  return {
    command,
    available: false,
    locator: "skipped",
    detail
  };
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function buildLoopPreview(loop: InspectableLoopRecord): LoopPreview {
  const costState = evaluateCostGovernor({
    budget: loop.budget,
    cost: {
      actualUsd: loop.cost.actualUsd,
      avoidedUsd: loop.cost.avoidedUsd ?? 0,
      tokensIn: loop.cost.tokensIn,
      tokensOut: loop.cost.tokensOut
    },
    attemptsUsed: loop.attempts.length
  });

  const lastAttempt = loop.attempts.at(-1);

  return {
    loopId: loop.loopId,
    title: loop.task?.title ?? loop.loopId,
    objective: loop.task?.objective ?? "Loop record summary",
    status: loop.status,
    lifecycleState: loop.lifecycleState,
    ...(loop.createdAt ? { createdAt: loop.createdAt } : {}),
    ...(loop.updatedAt ? { updatedAt: loop.updatedAt } : {}),
    attempts: loop.attempts.length,
    costUsd: loop.cost.actualUsd,
    avoidedUsd: loop.cost.avoidedUsd ?? 0,
    pressure: costState.pressure,
    shouldStop: costState.shouldStop,
    remainingBudgetUsd: costState.remainingBudgetUsd,
    remainingIterations: costState.remainingIterations,
    remainingTokens: costState.remainingTokens,
    ...(lastAttempt ? { lastAttempt: buildAttemptSummary(lastAttempt) } : {}),
    ...(loop.routingEconomics ? { routingEconomics: buildRoutingEconomicsSummary(loop.routingEconomics) } : {})
  };
}

function buildRoutingEconomicsSummary(economics: import("@martin/contracts").RoutingEconomics): Record<string, unknown> {
  return {
    preworkBurnPct: economics.preworkBurnPct,
    preworkCostUsd: economics.preworkCostUsd,
    executionCostUsd: economics.executionCostUsd,
    totalCostUsd: economics.totalCostUsd,
    ...(economics.timeToFirstDeltaMs !== undefined ? { timeToFirstDeltaMs: economics.timeToFirstDeltaMs } : {}),
    ...(economics.costPerAcceptedChange !== undefined ? { costPerAcceptedChange: economics.costPerAcceptedChange } : {}),
    ...(economics.routeRecommendation ? {
      routeRecommendation: economics.routeRecommendation,
      routeRecommendationReason: economics.routeRecommendationReason
    } : {})
  };
}

export function buildAttemptSummary(
  attempt: InspectableLoopAttempt,
  artifacts?: AttemptArtifactFiles
): AttemptSummary {
  return {
    index: attempt.index,
    ...(attempt.attemptId ? { attemptId: attempt.attemptId } : {}),
    ...(attempt.adapterId ? { adapterId: attempt.adapterId } : {}),
    ...(attempt.model ? { model: attempt.model } : {}),
    ...(attempt.failureClass ? { failureClass: attempt.failureClass } : {}),
    ...(attempt.intervention ? { intervention: attempt.intervention } : {}),
    ...(attempt.startedAt ? { startedAt: attempt.startedAt } : {}),
    ...(attempt.completedAt ? { completedAt: attempt.completedAt } : {}),
    ...(attempt.summary ? { summary: attempt.summary } : {}),
    ...(artifacts ? { artifacts } : {})
  };
}

export function buildArtifactSummary(loop: InspectableLoopRecord): ArtifactSummary {
  const artifacts = loop.artifacts ?? [];
  const kinds = artifacts.reduce<Record<string, number>>((accumulator, artifact) => {
    accumulator[artifact.kind] = (accumulator[artifact.kind] ?? 0) + 1;
    return accumulator;
  }, {});

  return {
    totalCount: artifacts.length,
    kinds,
    highlights: artifacts.slice(0, 5).map((artifact) => ({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      label: artifact.label,
      uri: artifact.uri
    }))
  };
}

export function buildVerificationSummary(
  loop: InspectableLoopRecord,
  ledgerEvents: LedgerEvent[] = []
): VerificationSummary {
  const verificationEvents = (loop.events ?? []).filter(
    (event) => event.type === "verification.completed"
  );
  const verificationLedgerEvents = ledgerEvents.filter(
    (event) => event.kind === "verification.completed"
  );

  const warnings: string[] = [];
  const integrity = resolveReceiptIntegrity(loop);
  const ledgerWarnings = getLedgerWarnings(ledgerEvents);
  if (integrity.state !== "verified") {
    warnings.push(
      `Receipt integrity is ${integrity.state}; persisted verifier evidence is not trustworthy yet.`
    );
  }
  warnings.push(...ledgerWarnings);

  if (verificationEvents.length === 0) {
    warnings.push(
      verificationLedgerEvents.length > 0
        ? "No verification.completed events were found in the loop record; using ledger evidence."
      : "No verification.completed events were found in the loop record."
    );
  }
  if (verificationLedgerEvents.length === 0 && ledgerWarnings.length === 0) {
    warnings.push("No verification.completed ledger events were found for this run.");
  }

  const selectedEvidence = selectLatestVerificationEvidence(loop, verificationEvents, verificationLedgerEvents);
  warnings.push(...selectedEvidence.warnings);

  const latestEvidence = selectedEvidence.evidence;
  if (!latestEvidence) {
    return {
      status: "not_run",
      eventCount: verificationEvents.length,
      ledgerEventCount: verificationLedgerEvents.length,
      warnings
    };
  }

  const contradicted =
    latestEvidence.passed === true &&
    warnings.some((warning) =>
      warning.toLowerCase().includes("conflicts for the latest attempt")
    );

  return {
    status:
      contradicted
        ? "contradicted"
      : latestEvidence.passed === true
        ? "passed"
        : latestEvidence.passed === false
          ? "failed"
          : "not_run",
    eventCount: verificationEvents.length,
    ledgerEventCount: verificationLedgerEvents.length,
    ...(latestEvidence.attemptIndex !== undefined ? { latestAttemptIndex: latestEvidence.attemptIndex } : {}),
    ...(latestEvidence.timestamp ? { completedAt: latestEvidence.timestamp } : {}),
    ...(typeof latestEvidence.summary === "string" && latestEvidence.summary.trim().length > 0
      ? { summary: latestEvidence.summary.trim() }
      : {}),
    warnings
  };
}

export function resolveReceiptIntegrity(loop: InspectableLoopRecord): ReceiptIntegritySummary {
  return (
    loop.receiptIntegrity ?? {
      state: "selector_noncanonical",
      reason: "Receipt integrity metadata was not available on the loop record."
    }
  );
}

export function buildEventSummaries(loop: InspectableLoopRecord, limit = 5): EventSummary[] {
  return (loop.events ?? [])
    .slice(-limit)
    .reverse()
    .map((event) => ({
      type: event.type,
      ...(event.timestamp ? { timestamp: event.timestamp } : {}),
      ...(event.lifecycleState ? { lifecycleState: event.lifecycleState } : {}),
      payload: event.payload ?? {}
    }));
}

export function buildLoopCollectionSummary(
  loops: Array<LoopRunRecord | InspectableLoopRecord>
): LoopCollectionSummary {
  const previews = loops
    .map((loop) => buildLoopPreview(loop as InspectableLoopRecord))
    .sort((left, right) => {
      const leftTime = toPreviewTimestamp(left);
      const rightTime = toPreviewTimestamp(right);
      return rightTime - leftTime;
    });

  const statusBreakdown = countBy(previews, "status");
  const lifecycleBreakdown = countBy(previews, "lifecycleState");

  return {
    ...(previews[0] ? { latestRun: previews[0] } : {}),
    recentRuns: previews.slice(0, 5),
    statusBreakdown,
    lifecycleBreakdown
  };
}

export async function inspectRunsRoot(
  runsRoot: string = resolveRunsRoot(process.env)
): Promise<RunStoreInspection> {
  const cached = runStoreInspectionCache.get(runsRoot);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let exists = false;

  try {
    exists = (await stat(runsRoot)).isDirectory();
  } catch {
    exists = false;
  }

  const inspected = await readAllLoopRecordsSafely(runsRoot);
  const summary = buildLoopCollectionSummary(inspected.loops);

  const value: RunStoreInspection = {
    runsRoot,
    exists,
    loopCount: inspected.loops.length,
    latestRun: summary.latestRun,
    recentRuns: summary.recentRuns,
    statusBreakdown: summary.statusBreakdown,
    lifecycleBreakdown: summary.lifecycleBreakdown,
    warnings: inspected.warnings
  };

  runStoreInspectionCache.set(runsRoot, {
    expiresAt: Date.now() + RUN_STORE_CACHE_TTL_MS,
    value
  });

  return value;
}

export function buildRunRecordPaths(runsRoot: string, loopId: string): CanonicalRunPaths {
  const runDirectory = join(runsRoot, loopId);
  return {
    runsRoot,
    runDirectory,
    loopRecordPath: join(runDirectory, "loop-record.json"),
    ledgerPath: join(runDirectory, "ledger.jsonl")
  };
}

export function buildAttemptArtifactDirectory(
  runsRoot: string,
  loopId: string,
  attemptIndex: number
): string {
  return join(
    runsRoot,
    loopId,
    "artifacts",
    `attempt-${String(attemptIndex).padStart(3, "0")}`
  );
}

export async function buildAttemptArtifactsReference(
  runsRoot: string,
  loopId: string,
  attemptIndex: number
): Promise<AttemptArtifactFiles> {
  const directory = buildAttemptArtifactDirectory(runsRoot, loopId, attemptIndex);

  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return {
      directory,
      available: true,
      files: entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort()
    };
  } catch {
    return {
      directory,
      available: false,
      files: []
    };
  }
}

export function buildCostSnapshot(
  cost: Pick<LoopCost, "actualUsd" | "tokensIn" | "tokensOut"> & {
    avoidedUsd?: number;
  }
): LoopCost {
  return {
    actualUsd: cost.actualUsd,
    avoidedUsd: cost.avoidedUsd ?? 0,
    tokensIn: cost.tokensIn,
    tokensOut: cost.tokensOut
  };
}

export function buildBudgetSnapshot(budget: LoopBudget): LoopBudget {
  return {
    maxUsd: budget.maxUsd,
    softLimitUsd: budget.softLimitUsd,
    maxIterations: budget.maxIterations,
    maxTokens: budget.maxTokens
  };
}

export function buildSuggestedResourceUris(loopId: string): string[] {
  return [
    "martin://server/health",
    "martin://runs/recent",
    "martin://runs/triage",
    "martin://runs/latest",
    "martin://runs/latest/summary",
    "martin://runs/latest/receipt",
    "martin://runs/latest/proof-card",
    "martin://runs/latest/budget-status",
    "martin://runs/latest/verifier-evidence",
    "martin://runs/latest/rollback-evidence",
    "martin://policies/current",
    "martin://repo/risk-map",
    "martin://verifiers/results",
    "martin://agent/next-step",
    `martin://runs/${loopId}`,
    `martin://runs/${loopId}/dossier`,
    `martin://runs/${loopId}/verification`,
    "martin://guides/mcp-usage",
    "martin://guides/agent-start",
    "martin://guides/publish-readiness"
  ];
}

export function buildSuggestedPromptNames(): string[] {
  return [
    "martin_start",
    "martin_preflight",
    "martin_triage",
    "martin_resume",
    "martin_prove",
    "martin_release_check",
    "martin_governed_coding_kickoff",
    "martin_debug_failed_run",
    "martin_publish_readiness_review",
    "martin_triage_run_store",
    "safe_bug_fix",
    "write_tests_first",
    "small_refactor",
    "security_review",
    "pr_review",
    "release_check"
  ];
}

function countBy<T, K extends keyof T>(
  values: T[],
  key: K
): Record<string, number> {
  return values.reduce<Record<string, number>>((accumulator, value) => {
    const bucket = String(value[key]);
    accumulator[bucket] = (accumulator[bucket] ?? 0) + 1;
    return accumulator;
  }, {});
}

function toPreviewTimestamp(loop: LoopPreview): number {
  const value = loop.updatedAt ?? loop.createdAt;
  return value ? new Date(value).getTime() : 0;
}

function selectLatestVerificationEvidence(
  loop: InspectableLoopRecord,
  verificationEvents: Array<Pick<LoopEvent, "timestamp" | "payload">>,
  verificationLedgerEvents: LedgerEvent[]
): {
  evidence?: NormalizedVerificationEvidence;
  warnings: string[];
} {
  const warnings: string[] = [];
  const futureEvidenceCount = [
    ...verificationEvents.map((event) => event.timestamp),
    ...verificationLedgerEvents.map((event) => event.timestamp)
  ].filter(isFutureVerificationTimestamp).length;

  if (futureEvidenceCount > 0) {
    warnings.push(
      `Ignored ${futureEvidenceCount} future-dated verification evidence item(s) that cannot be trusted yet.`
    );
  }

  const evidence = [
    ...verificationEvents.map((event) => normalizeLoopVerificationEvidence(loop, event)),
    ...verificationLedgerEvents.map((event) => normalizeLedgerVerificationEvidence(loop, event))
  ].filter((candidate): candidate is NormalizedVerificationEvidence => candidate !== undefined);

  if (evidence.length === 0) {
    return { warnings };
  }

  evidence.sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime());
  const latest = evidence[0];
  if (!latest) {
    return { warnings };
  }

  const latestAttemptEvidence = evidence.filter((candidate) =>
    latest.attemptId
      ? candidate.attemptId === latest.attemptId
      : latest.attemptIndex !== undefined
        ? candidate.attemptIndex === latest.attemptIndex
        : false
  );
  const distinctStatuses = new Set(
    latestAttemptEvidence
      .map((candidate) => candidate.passed)
      .filter((candidate): candidate is boolean => typeof candidate === "boolean")
  );

  if (distinctStatuses.size > 1) {
    warnings.push("Verification evidence conflicts for the latest attempt; marking verification as contradicted.");
    return { warnings };
  }

  return {
    evidence: latest,
    warnings
  };
}

function normalizeLoopVerificationEvidence(
  loop: InspectableLoopRecord,
  event: Pick<LoopEvent, "timestamp" | "payload">
): NormalizedVerificationEvidence | undefined {
  if (!isTrustedVerificationTimestamp(event.timestamp)) {
    return undefined;
  }

  const payload = isRecord(event.payload) ? event.payload : undefined;
  const attemptId = typeof payload?.["attemptId"] === "string" ? payload["attemptId"] : undefined;
  const attemptIndex =
    typeof payload?.["attemptIndex"] === "number" && Number.isInteger(payload["attemptIndex"])
      ? payload["attemptIndex"]
      : undefined;
  const matchedAttempt = attemptId
    ? loop.attempts.find((attempt) => attempt.attemptId === attemptId)
    : attemptIndex !== undefined
      ? loop.attempts.find((attempt) => attempt.index === attemptIndex)
      : undefined;

  if (!matchedAttempt) {
    return undefined;
  }

  return {
    timestamp: event.timestamp,
    ...(matchedAttempt.attemptId ? { attemptId: matchedAttempt.attemptId } : {}),
    attemptIndex: matchedAttempt.index,
    ...(typeof payload?.["passed"] === "boolean" ? { passed: payload["passed"] } : {}),
    ...(typeof payload?.["summary"] === "string" ? { summary: payload["summary"] } : {})
  };
}

function normalizeLedgerVerificationEvidence(
  loop: InspectableLoopRecord,
  event: LedgerEvent
): NormalizedVerificationEvidence | undefined {
  if (!isTrustedVerificationTimestamp(event.timestamp)) {
    return undefined;
  }

  if (event.attemptIndex === undefined || !Number.isInteger(event.attemptIndex)) {
    return undefined;
  }

  const payload = isRecord(event.payload) ? event.payload : undefined;
  const matchedAttempt = loop.attempts.find((attempt) => attempt.index === event.attemptIndex);

  if (!matchedAttempt) {
    return undefined;
  }

  return {
    timestamp: event.timestamp,
    ...(matchedAttempt?.attemptId ? { attemptId: matchedAttempt.attemptId } : {}),
    attemptIndex: event.attemptIndex,
    ...(typeof payload?.["passed"] === "boolean" ? { passed: payload["passed"] } : {}),
    ...(typeof payload?.["summary"] === "string" ? { summary: payload["summary"] } : {})
  };
}

function isTrustedVerificationTimestamp(value: string): boolean {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  return timestamp <= Date.now() + 5 * 60_000;
}

function isFutureVerificationTimestamp(value: string): boolean {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  return timestamp > Date.now() + 5 * 60_000;
}

function getLedgerWarnings(ledgerEvents: LedgerEvent[]): string[] {
  const diagnostics = ledgerEvents as LedgerEvent[] & { warnings?: unknown };
  return Array.isArray(diagnostics.warnings)
    ? diagnostics.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
