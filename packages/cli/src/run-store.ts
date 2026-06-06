import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { resolveRunsRoot } from "@martin/core";
import type {
  LoopArtifact,
  LoopEvent,
  LoopRecord,
  MartinRunListFilters,
  MartinRunSelector
} from "@martin/contracts";

import { CliCommandError } from "./ux.js";

// ---------------------------------------------------------------------------
// Local corpus hotspot reader (Layer 5 — proactive issue detection)
// Reads the local learning corpus JSONL without importing from enterprise.
// ---------------------------------------------------------------------------

export interface LocalCorpusHotspot {
  scopeFingerprint: string;
  failureRate: number;
  sampleSize: number;
  riskScore: number;
  commonFailureClasses: string[];
}

export interface LocalCorpusRisk {
  hotspots: LocalCorpusHotspot[];
  corpusRecords: number;
  corpusPath: string;
}

interface CorpusRecord {
  scopeFingerprint?: string | null;
  outcome?: string;
  failureClass?: string | null;
}

type RunsDirEntry = {
  name: string | { toString(): string };
  isFile(): boolean;
  isDirectory(): boolean;
};

function resolveLocalCorpusPath(): string {
  if (process.env["MARTIN_LEARNING_CORPUS_PATH"]) {
    return process.env["MARTIN_LEARNING_CORPUS_PATH"];
  }
  return path.join(homedir(), ".martin", "autonomy", "learning-corpus", "attempt-records.jsonl");
}

export async function readLocalCorpusRisk(
  options: { corpusPath?: string; minSampleSize?: number; minRiskScore?: number } = {}
): Promise<LocalCorpusRisk> {
  const corpusPath = options.corpusPath ?? resolveLocalCorpusPath();
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
        return JSON.parse(line) as CorpusRecord;
      } catch {
        return null;
      }
    })
    .filter((record): record is CorpusRecord => record !== null);

  const byScope = new Map<string, CorpusRecord[]>();
  for (const record of records) {
    if (!record.scopeFingerprint) continue;
    const key = record.scopeFingerprint;
    byScope.set(key, [...(byScope.get(key) ?? []), record]);
  }

  const hotspots = [...byScope.entries()]
    .map(([scopeFingerprint, group]): LocalCorpusHotspot => {
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
              .filter((cls): cls is string => typeof cls === "string")
          )
        ].slice(0, 3)
      };
    })
    .filter((hotspot) => hotspot.sampleSize >= minSampleSize && hotspot.riskScore >= minRiskScore)
    .sort((left, right) => right.riskScore - left.riskScore);

  return { hotspots, corpusRecords: records.length, corpusPath };
}

export function computeScopeFingerprint(workingDirectory: string): string {
  return createHash("sha256").update(workingDirectory.replace(/\\/g, "/").toLowerCase()).digest("hex").slice(0, 16);
}

export interface CliEnvironment {
  invocationRoot: string;
  workingDirectory: string;
  runsRoot: string;
  engine: "claude" | "codex" | "openai";
  liveMode: "live" | "proof";
}

export interface PersistedLoopDetail {
  source: string;
  runsRoot: string;
  loop: LoopRecord;
  warnings: string[];
  runDirectory?: string;
  loopRecordPath?: string;
}

export interface VerificationSummary {
  status: "passed" | "failed" | "unavailable";
  summary: string;
  eventCount: number;
  latestAttemptIndex?: number;
  completedAt?: string;
  steps: VerificationStepSummary[];
  warnings: string[];
}

export interface VerificationStepSummary {
  command: string;
  launched: boolean;
  exitCode?: number;
  timedOut: boolean;
  fastFail: boolean;
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
    return {
      ...detail,
      runsRoot,
      warnings: []
    };
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
        return {
          source: canonical,
          runsRoot,
          loop: await readLoopRecordFile(canonical),
          warnings: [],
          runDirectory: path.dirname(canonical),
          loopRecordPath: canonical
        };
      }

      const inspected = await collectPersistedLoops(targetPath);
      const loop = inspected.loops[0];
      if (!loop) {
        throw new CliCommandError("not_found", "No persisted Martin loops were found in the selected directory.");
      }

      return {
        source: targetPath,
        runsRoot,
        loop,
        warnings: inspected.warnings
      };
    }

    const loops = await readLoopsFromFile(targetPath, runsRoot);
    const loop = loops.sort((left, right) => loopTimestamp(right) - loopTimestamp(left))[0];
    if (!loop) {
      throw new CliCommandError("not_found", "No persisted Martin loops were found in the selected file.");
    }

    return {
      source: targetPath,
      runsRoot,
      loop,
      warnings: []
    };
  }

  const inspected = await collectPersistedLoops(runsRoot);
  const loop = inspected.loops[0];
  if (!loop) {
    throw new CliCommandError("not_found", "No persisted Martin loops were found.");
  }

  return {
    source: runsRoot,
    runsRoot,
    loop,
    warnings: inspected.warnings
  };
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

export function buildVerificationSummary(loop: LoopRecord): VerificationSummary {
  const verificationEvents = loop.events.filter((event) => event.type === "verification.completed");
  const latestEvent = verificationEvents.at(-1);

  if (!latestEvent) {
    return {
      status: "unavailable",
      summary: "No persisted verification evidence was found for this loop.",
      eventCount: 0,
      steps: [],
      warnings: ["Verification evidence is unavailable for this persisted loop."]
    };
  }

  const payload = isRecord(latestEvent.payload) ? latestEvent.payload : undefined;
  const passed = latestEvent.payload["passed"] === true;
  const latestAttemptIndex =
    typeof payload?.["attemptIndex"] === "number"
      ? (payload["attemptIndex"] as number)
      : loop.attempts.at(-1)?.index;
  const warnings = readVerificationWarnings(payload);
  const steps = readVerificationSteps(payload);

  return {
    status: passed ? "passed" : "failed",
    summary:
      typeof payload?.["summary"] === "string"
        ? (payload["summary"] as string)
        : passed
          ? "Verification passed."
          : "Verification failed.",
    eventCount: verificationEvents.length,
    ...(latestAttemptIndex !== undefined ? { latestAttemptIndex } : {}),
    completedAt: latestEvent.timestamp,
    steps,
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

export function buildRunReceipt(loop: LoopRecord, verification = buildVerificationSummary(loop)): Record<string, unknown> {
  const latestAttempt = loop.attempts.at(-1);
  const rollbackArtifacts = loop.artifacts.filter((artifact) =>
    /rollback|restore|diff|patch/iu.test(`${artifact.kind} ${artifact.label} ${artifact.uri}`)
  );
  const stopConditionReached =
    loop.lifecycleState === "budget_exit" ||
    loop.lifecycleState === "diminishing_returns" ||
    loop.lifecycleState === "stuck_exit" ||
    loop.lifecycleState === "human_escalation";
  const prevented = buildPreventionSummary(loop, verification, stopConditionReached);

  return {
    whatHappened: latestAttempt?.summary ?? verification.summary ?? loop.task.objective,
    whatMartinPrevented: prevented,
    tokenWasteReceipt: {
      actualUsd: loop.cost.actualUsd,
      avoidedUsdEstimate: loop.cost.avoidedUsd,
      tokensIn: loop.cost.tokensIn,
      tokensOut: loop.cost.tokensOut,
      avoidedIterationsEstimate: stopConditionReached ? 1 : 0,
      avoidedVerifierRetriesEstimate: verification.status === "failed" && stopConditionReached ? 1 : 0,
      estimateLabel:
        "Avoided spend, avoided iterations, and avoided verifier retries are directional local estimates unless backed by provider usage receipts."
    },
    verifier: {
      status: verification.status,
      summary: verification.summary,
      eventCount: verification.eventCount,
      steps: verification.steps,
      warnings: verification.warnings
    },
    rollbackEvidence: {
      exists: rollbackArtifacts.length > 0,
      count: rollbackArtifacts.length,
      artifacts: rollbackArtifacts.slice(0, 5)
    },
    nextSafeAction: selectNextSafeAction(loop, verification, rollbackArtifacts.length)
  };
}

export function buildRunDossier(detail: PersistedLoopDetail): Record<string, unknown> {
  const verification = buildVerificationSummary(detail.loop);
  const artifactSummary = buildArtifactSummary(detail.loop);
  const receipt = buildRunReceipt(detail.loop, verification);

  return {
    source: detail.source,
    paths: {
      runsRoot: detail.runsRoot,
      ...(detail.runDirectory ? { runDirectory: detail.runDirectory } : {}),
      ...(detail.loopRecordPath ? { loopRecordPath: detail.loopRecordPath } : {})
    },
    loop: detail.loop,
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
        if (!latestLoop || loopTimestamp(loop) >= loopTimestamp(latestLoop)) {
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
      if (loop && (!latestLoop || loopTimestamp(loop) >= loopTimestamp(latestLoop))) {
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

      if (!latestSummary || Date.parse(candidate.updatedAt) >= Date.parse(latestSummary.updatedAt)) {
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

function buildPreventionSummary(
  loop: LoopRecord,
  verification: VerificationSummary,
  stopConditionReached: boolean
): string[] {
  const prevented: string[] = [];
  const latestAttempt = loop.attempts.at(-1);

  if (stopConditionReached) {
    prevented.push("another unsafe or uneconomical retry before operator review");
  }
  if (verification.status === "failed") {
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

  return prevented.length > 0
    ? prevented
    : ["no additional prevention claim is available from this run record"];
}

function selectNextSafeAction(
  loop: LoopRecord,
  verification: VerificationSummary,
  rollbackEvidenceCount: number
): string {
  if (verification.status === "failed") {
    return `Debug loop ${loop.loopId} before another attempt; start with verifier evidence and the latest failed attempt.`;
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
  if (verification.status === "unavailable") {
    priority += 10;
    reasons.push("verification_unavailable");
  }
  if (loop.attempts.length >= 3) {
    priority += 10;
    reasons.push("multi_attempt");
  }

  return {
    loopId: loop.loopId,
    priority,
    status: loop.status,
    lifecycleState: loop.lifecycleState,
    title: loop.task.title,
    summary: verification.summary,
    reasons,
    updatedAt: loop.updatedAt
  };
}

function resolveRunsRootPath(runsDir: string | undefined, invocationRoot = resolveInvocationRoot()): string {
  const configuredRunsRoot = runsDir?.trim() || resolveRunsRoot(process.env);
  return resolveAbsolutePath(configuredRunsRoot, invocationRoot);
}

function resolveAbsolutePath(targetPath: string, base = resolveInvocationRoot()): string {
  return path.isAbsolute(targetPath) ? path.normalize(targetPath) : path.resolve(base, targetPath);
}

async function collectPersistedLoops(runsRoot: string): Promise<{ loops: LoopRecord[]; warnings: string[] }> {
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

  for (const entry of entries) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
    timedOut: candidate["timedOut"] === true,
    fastFail: candidate["fastFail"] !== false,
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
  return Date.parse(loop.updatedAt || loop.createdAt || "");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "ENOENT";
}
