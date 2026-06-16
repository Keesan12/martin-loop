import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  readLatestLoopRecordFromFile,
  readLoopRecordsFromFile,
  resolveRunsRoot,
  verifyReceiptIntegrityFromFiles,
  type LedgerEvent
} from "@martin/core";

import {
  resolveSafeLoopRecordPath,
  resolveSafeRunsJsonPath,
  resolveSafeRunsPath,
  resolveSafeRunsRootPath
} from "../server-validation.js";
import {
  attemptNotFoundError,
  invalidSelectorError,
  noLoopRecordsError,
  storeUnreadableError
} from "./tool-errors.js";
import type { InspectableLoopRecord } from "./tool-support.js";

export interface InspectLoopSource {
  source: string;
  loops: InspectableLoopRecord[];
  warnings: string[];
}

export interface StatusLoopSource {
  source: string;
  loop: InspectableLoopRecord;
}

export interface DetailedLoopSource {
  source: string;
  sourceKind: "file" | "loop_id" | "latest" | "runs_root";
  runsRoot: string;
  loop: InspectableLoopRecord;
  warnings: string[];
  canonicalRunDirectory?: string;
  canonicalLoopRecordPath?: string;
  ledgerPath?: string;
}

async function attachReceiptIntegrity(detail: DetailedLoopSource): Promise<DetailedLoopSource> {
  const ledgerPath = detail.canonicalRunDirectory
    ? await resolveReceiptEvidencePath(detail.canonicalRunDirectory)
    : detail.ledgerPath;
  const integrity =
    detail.canonicalLoopRecordPath && detail.canonicalRunDirectory && ledgerPath
      ? await verifyReceiptIntegrityFromFiles({
          runId: detail.loop.loopId,
          runsRoot: detail.runsRoot,
          loopRecordPath: detail.canonicalLoopRecordPath,
          ledgerPath
        }).catch(() => ({
          state: "unsigned" as const,
          reason: "Receipt integrity verification could not be completed."
        }))
      : ({
          state: "unsigned" as const,
          reason: "Receipt integrity is only available for canonical run directories."
        });
  const receiptScope = resolveReceiptScope(detail.loop, detail.runsRoot);

  return {
    ...detail,
    ...(ledgerPath ? { ledgerPath } : {}),
    loop: {
      ...detail.loop,
      receiptIntegrity: integrity,
      ...(receiptScope ? { receiptScope } : {})
    }
  };
}

export interface LoopListInput {
  runsDir?: string;
  limit?: number;
  status?: string;
  lifecycleState?: string;
  adapterId?: string;
  model?: string;
  updatedAfter?: string;
}

export interface LoopListResult {
  source: string;
  runsRoot: string;
  loops: InspectableLoopRecord[];
  warnings: string[];
}

export type LedgerEventsWithDiagnostics = LedgerEvent[] & {
  warnings?: string[];
  unreadable?: boolean;
  ledgerPath?: string;
};

function resolveReceiptScope(
  loop: InspectableLoopRecord,
  runsRoot?: string
): InspectableLoopRecord["receiptScope"] | undefined {
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

async function resolveReceiptEvidencePath(runDirectory: string): Promise<string | undefined> {
  for (const candidate of ["ledger.jsonl", "events.jsonl"]) {
    const candidatePath = path.join(runDirectory, candidate);
    const candidateStats = await safeStat(candidatePath);
    if (candidateStats?.isFile()) {
      return candidatePath;
    }
  }

  return undefined;
}

export async function loadLoopRecordsForInspect(input: {
  file?: string;
  runsDir?: string;
}): Promise<InspectLoopSource> {
  const runsRoot = resolveSafeRunsRootPath(input.runsDir, resolveRunsRoot(process.env));

  if (!input.file) {
    const inspected = await readAllLoopRecordsSafely(runsRoot);
    return {
      source: runsRoot,
      loops: inspected.loops,
      warnings: inspected.warnings
    };
  }

  const targetPath = resolveSafeRunsPath(input.file, runsRoot);
  const targetStats = await safeStat(targetPath);
  if (targetStats?.isDirectory()) {
    const canonicalLoopRecordPath = resolveInspectableLoopRecordPath(targetPath, runsRoot);
    if (canonicalLoopRecordPath) {
      const canonicalLoopRecordStats = await safeStat(canonicalLoopRecordPath);
      if (canonicalLoopRecordStats?.isFile()) {
        return {
          source: canonicalLoopRecordPath,
          loops: await readRecordsFromFile(canonicalLoopRecordPath),
          warnings: []
        };
      }
    }

    const inspected = await readAllLoopRecordsSafely(targetPath);
    return {
      source: targetPath,
      loops: inspected.loops,
      warnings: inspected.warnings
    };
  }

  return {
    source: targetPath,
    loops: await readRecordsFromFile(targetPath),
    warnings: []
  };
}

export async function loadLoopRecordForStatus(input: {
  loopJson?: string;
  file?: string;
  loopId?: string;
  runsDir?: string;
  latest?: boolean;
}): Promise<StatusLoopSource> {
  if (input.loopJson) {
    return {
      source: "inline:loopJson",
      loop: JSON.parse(input.loopJson) as InspectableLoopRecord
    };
  }

  const detail = await loadDetailedLoopRecord(input);
  return {
    source: detail.source,
    loop: detail.loop
  };
}

export async function listLoopRecords(input: LoopListInput): Promise<LoopListResult> {
  const runsRoot = resolveSafeRunsRootPath(input.runsDir, resolveRunsRoot(process.env));
  const inspected = await readAllLoopRecordsSafely(runsRoot);
  const warnings: string[] = [...inspected.warnings];
  const updatedAfterTimestamp =
    input.updatedAfter !== undefined ? new Date(input.updatedAfter).getTime() : undefined;

  if (
    input.updatedAfter !== undefined &&
    (!Number.isFinite(updatedAfterTimestamp) || Number.isNaN(updatedAfterTimestamp))
  ) {
    throw invalidSelectorError(
      "Invalid updatedAfter.",
      "Provide updatedAfter as an ISO-8601 timestamp."
    );
  }

  const loops = inspected.loops
    .filter((loop) => {
      if (input.status && loop.status !== input.status) {
        return false;
      }
      if (input.lifecycleState && loop.lifecycleState !== input.lifecycleState) {
        return false;
      }
      if (input.adapterId && !loop.attempts.some((attempt) => attempt.adapterId === input.adapterId)) {
        return false;
      }
      if (input.model && !loop.attempts.some((attempt) => attempt.model === input.model)) {
        return false;
      }
      if (updatedAfterTimestamp !== undefined) {
        const loopTimestamp = new Date(loop.updatedAt ?? loop.createdAt ?? 0).getTime();
        if (!Number.isFinite(loopTimestamp) || loopTimestamp <= updatedAfterTimestamp) {
          return false;
        }
      }
      return true;
    })
    .sort((left, right) => timestampForLoop(right) - timestampForLoop(left))
    .slice(0, input.limit ?? 20);

  if (loops.length === 0) {
    warnings.push("No loop records matched the current filters.");
  }

  return {
    source: runsRoot,
    runsRoot,
    loops,
    warnings
  };
}

export async function loadDetailedLoopRecord(input: {
  file?: string;
  loopId?: string;
  runsDir?: string;
  latest?: boolean;
}): Promise<DetailedLoopSource> {
  const runsRoot = resolveSafeRunsRootPath(input.runsDir, resolveRunsRoot(process.env));
  const selectors = [
    input.file !== undefined ? "file" : null,
    input.loopId !== undefined ? "loopId" : null,
    input.latest ? "latest" : null
  ].filter((value): value is string => value !== null);

  if (selectors.length !== 1) {
    throw invalidSelectorError(
      "Provide exactly one of file, loopId, or latest.",
      "Choose exactly one run selector per call."
    );
  }

  if (input.file) {
    const targetPath = resolveSafeRunsPath(input.file, runsRoot);
    const targetStats = await safeStat(targetPath);
    if (!targetStats) {
      throw noLoopRecordsError();
    }

    if (targetStats.isDirectory()) {
      const canonicalLoopRecordPath = resolveInspectableLoopRecordPath(targetPath, runsRoot);
      if (canonicalLoopRecordPath) {
        const canonicalStats = await safeStat(canonicalLoopRecordPath);
        if (canonicalStats?.isFile()) {
          const loop = await readCanonicalLoopRecord(canonicalLoopRecordPath);
          return await attachReceiptIntegrity(buildDetailedLoopSource({
            source: canonicalLoopRecordPath,
            sourceKind: "file",
            runsRoot,
            loop,
            canonicalLoopRecordPath,
            canonicalRunDirectory: path.dirname(canonicalLoopRecordPath)
          }));
        }
      }

      const inspected = await readAllLoopRecordsSafely(targetPath);
      const loop = inspected.loops[0];
      if (!loop) {
        throw noLoopRecordsError();
      }

      const detail = await buildDetailedLoopSourceFromDiscoveredLoop({
        source: targetPath,
        sourceKind: "runs_root",
        runsRoot,
        loop
      });
      return await attachReceiptIntegrity({
        ...detail,
        warnings: [...detail.warnings, ...inspected.warnings]
      });
    }

    const latest = await readLatestLoopRecordFromFile(targetPath);
    if (!latest) {
      throw noLoopRecordsError();
    }

    if (path.basename(targetPath) === "loop-record.json") {
      const loop = await readCanonicalLoopRecord(targetPath);
      return await attachReceiptIntegrity(buildDetailedLoopSource({
        source: targetPath,
        sourceKind: "file",
        runsRoot,
        loop,
        canonicalLoopRecordPath: targetPath,
        canonicalRunDirectory: path.dirname(targetPath)
      }));
    }

    return await attachReceiptIntegrity(await buildDetailedLoopSourceFromDiscoveredLoop({
      source: targetPath,
      sourceKind: "file",
      runsRoot,
      loop: latest as InspectableLoopRecord
    }));
  }

  if (input.loopId) {
    const canonicalLoopRecordPath = resolvePotentialLoopRecordPath(input.loopId, runsRoot);
    const canonicalStats = await safeStat(canonicalLoopRecordPath);
    if (canonicalStats?.isFile()) {
      const loop = await readCanonicalLoopRecord(canonicalLoopRecordPath);
      return await attachReceiptIntegrity(buildDetailedLoopSource({
        source: canonicalLoopRecordPath,
        sourceKind: "loop_id",
        runsRoot,
        loop,
        canonicalLoopRecordPath,
        canonicalRunDirectory: path.dirname(canonicalLoopRecordPath)
      }));
    }

    const inspected = await readAllLoopRecordsSafely(runsRoot);
    const loop = inspected.loops.find((candidate) => candidate.loopId === input.loopId);
    if (!loop) {
      throw noLoopRecordsError();
    }

    const detail = await buildDetailedLoopSourceFromDiscoveredLoop({
      source: runsRoot,
      sourceKind: "loop_id",
      runsRoot,
      loop
    });
    return await attachReceiptIntegrity({
      ...detail,
      warnings: [...detail.warnings, ...inspected.warnings]
    });
  }

  const inspected = await readAllLoopRecordsSafely(runsRoot);
  const loop = inspected.loops[0];
  if (!loop) {
    throw noLoopRecordsError();
  }

  const detail = await buildDetailedLoopSourceFromDiscoveredLoop({
    source: runsRoot,
    sourceKind: "latest",
    runsRoot,
    loop
  });
  return await attachReceiptIntegrity({
    ...detail,
    warnings: [...detail.warnings, ...inspected.warnings]
  });
}

export async function loadAttemptFromLoop(input: {
  file?: string;
  loopId?: string;
  runsDir?: string;
  attemptIndex?: number;
}): Promise<{
  detail: DetailedLoopSource;
  attempt: InspectableLoopRecord["attempts"][number];
}> {
  const detail = await loadDetailedLoopRecord(input);
  const attempt =
    input.attemptIndex !== undefined
      ? detail.loop.attempts.find((candidate) => candidate.index === input.attemptIndex)
      : detail.loop.attempts.at(-1);

  if (!attempt) {
    throw attemptNotFoundError(input.attemptIndex ?? detail.loop.attempts.length);
  }

  return {
    detail,
    attempt
  };
}

export async function readLedgerEvents(detail: DetailedLoopSource): Promise<LedgerEventsWithDiagnostics> {
  const requestedLedgerPath =
    detail.ledgerPath ??
    (detail.canonicalRunDirectory ? path.join(detail.canonicalRunDirectory, "ledger.jsonl") : undefined);

  if (!requestedLedgerPath) {
    return withLedgerDiagnostics([]);
  }

  try {
    const ledgerPath = resolveInspectableLedgerPath(requestedLedgerPath, detail.runsRoot);
    const ledgerStats = await safeStat(ledgerPath);
    if (!ledgerStats?.isFile()) {
      return withLedgerDiagnostics([], { ledgerPath });
    }

    const text = await readFile(ledgerPath, "utf8");
    const events = text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LedgerEvent);
    return withLedgerDiagnostics(events, { ledgerPath });
  } catch {
    return withLedgerDiagnostics([], {
      unreadable: true,
      warnings: [
        `Verification ledger for '${detail.loop.loopId}' is unreadable; ledger verification evidence is unavailable.`
      ]
    });
  }
}

export async function readAttemptArtifactFiles(detail: DetailedLoopSource, attemptIndex: number): Promise<string[]> {
  if (!detail.canonicalRunDirectory) {
    return [];
  }

  const directory = path.join(
    detail.canonicalRunDirectory,
    "artifacts",
    `attempt-${String(attemptIndex).padStart(3, "0")}`
  );

  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

export async function readAllLoopRecordsSafely(runsRoot: string): Promise<{
  loops: InspectableLoopRecord[];
  warnings: string[];
}> {
  let entries;

  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch {
    return {
      loops: [],
      warnings: [
        "Configured Martin runs root is missing or unreadable; no loop records could be inspected."
      ]
    };
  }

  const loops: InspectableLoopRecord[] = [];
  const warnings: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const canonicalLoopRecordPath = resolveInspectableLoopRecordPath(
        path.join(runsRoot, entry.name),
        runsRoot
      );
      if (!canonicalLoopRecordPath) {
        continue;
      }

      const canonicalStats = await safeStat(canonicalLoopRecordPath);
      if (!canonicalStats?.isFile()) {
        continue;
      }

      try {
        loops.push(await readCanonicalLoopRecord(canonicalLoopRecordPath));
      } catch {
        warnings.push(`Skipped unreadable loop record for '${entry.name}'.`);
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (extension !== ".json" && extension !== ".jsonl") {
      continue;
    }

    const filePath = path.join(runsRoot, entry.name);
    try {
      loops.push(...(await readRecordsFromFile(resolveSafeRunsJsonPath(entry.name, runsRoot))));
    } catch {
      warnings.push(`Skipped unreadable run file '${entry.name}'.`);
    }
  }

  loops.sort((left, right) => timestampForLoop(right) - timestampForLoop(left));

  return {
    loops,
    warnings
  };
}

async function buildDetailedLoopSourceFromDiscoveredLoop(input: {
  source: string;
  sourceKind: "file" | "loop_id" | "latest" | "runs_root";
  runsRoot: string;
  loop: InspectableLoopRecord;
}): Promise<DetailedLoopSource> {
  let canonicalLoopRecordPath: string | undefined;
  try {
    canonicalLoopRecordPath = resolveSafeLoopRecordPath(input.loop.loopId, input.runsRoot);
  } catch {
    canonicalLoopRecordPath = undefined;
  }
  const canonicalStats = canonicalLoopRecordPath ? await safeStat(canonicalLoopRecordPath) : undefined;

  if (canonicalLoopRecordPath && canonicalStats?.isFile()) {
    const canonicalLoop = await readCanonicalLoopRecord(canonicalLoopRecordPath);
    return buildDetailedLoopSource({
      source: input.source,
      sourceKind: input.sourceKind,
      runsRoot: input.runsRoot,
      loop: canonicalLoop,
      canonicalLoopRecordPath,
      canonicalRunDirectory: path.dirname(canonicalLoopRecordPath)
    });
  }

  return buildDetailedLoopSource({
    source: input.source,
    sourceKind: input.sourceKind,
    runsRoot: input.runsRoot,
    loop: input.loop,
    warnings: [
      `Canonical run directory for ${input.loop.loopId} is not available; dossier data may be partial.`
    ]
  });
}

function buildDetailedLoopSource(input: {
  source: string;
  sourceKind: DetailedLoopSource["sourceKind"];
  runsRoot: string;
  loop: InspectableLoopRecord;
  warnings?: string[];
  canonicalRunDirectory?: string;
  canonicalLoopRecordPath?: string;
}): DetailedLoopSource {
  return {
    source: input.source,
    sourceKind: input.sourceKind,
    runsRoot: input.runsRoot,
    loop: input.loop,
    warnings: input.warnings ?? [],
    ...(input.canonicalRunDirectory ? { canonicalRunDirectory: input.canonicalRunDirectory } : {}),
    ...(input.canonicalLoopRecordPath ? { canonicalLoopRecordPath: input.canonicalLoopRecordPath } : {}),
    ...(input.canonicalRunDirectory
      ? { ledgerPath: path.join(input.canonicalRunDirectory, "ledger.jsonl") }
      : {})
  };
}

async function readCanonicalLoopRecord(file: string): Promise<InspectableLoopRecord> {
  try {
    const text = await readFile(file, "utf8");
    return validateInspectableLoopRecord(JSON.parse(text));
  } catch {
    throw storeUnreadableError();
  }
}

async function readRecordsFromFile(file: string): Promise<InspectableLoopRecord[]> {
  try {
    return (await readLoopRecordsFromFile(file)).map((loop) => validateInspectableLoopRecord(loop));
  } catch {
    throw storeUnreadableError();
  }
}

async function safeStat(targetPath: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(targetPath);
  } catch {
    return null;
  }
}

function resolveInspectableLoopRecordPath(
  runDirectory: string,
  runsRoot: string
): string | undefined {
  try {
    const relativeLoopRecordPath = path.relative(
      runsRoot,
      path.join(runDirectory, "loop-record.json")
    );
    return resolveSafeRunsJsonPath(relativeLoopRecordPath, runsRoot);
  } catch {
    return undefined;
  }
}

function resolvePotentialLoopRecordPath(loopId: string, runsRoot: string): string {
  try {
    return resolveSafeLoopRecordPath(loopId, runsRoot);
  } catch (error) {
    if (!/^[A-Za-z0-9._-]+$/u.test(loopId)) {
      throw error;
    }
    return path.join(runsRoot, loopId, "loop-record.json");
  }
}

function resolveInspectableLedgerPath(
  ledgerPath: string,
  runsRoot: string
): string {
  const relativeLedgerPath = path.relative(runsRoot, ledgerPath);
  return resolveSafeRunsJsonPath(relativeLedgerPath, runsRoot);
}

function timestampForLoop(loop: InspectableLoopRecord): number {
  const timestamp = new Date(loop.updatedAt ?? loop.createdAt ?? 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function withLedgerDiagnostics(
  events: LedgerEvent[],
  diagnostics: { warnings?: string[]; unreadable?: boolean; ledgerPath?: string } = {}
): LedgerEventsWithDiagnostics {
  return Object.assign(events, diagnostics);
}

function validateInspectableLoopRecord(value: unknown): InspectableLoopRecord {
  if (!isRecord(value)) {
    throw storeUnreadableError();
  }

  const budget = value["budget"];
  const cost = value["cost"];
  const attempts = value["attempts"];

  if (
    typeof value["loopId"] !== "string" ||
    !/^[A-Za-z0-9._-]+$/u.test(value["loopId"]) ||
    typeof value["status"] !== "string" ||
    typeof value["lifecycleState"] !== "string" ||
    !isRecord(budget) ||
    !isFiniteNumber(budget["maxUsd"]) ||
    !isFiniteNumber(budget["softLimitUsd"]) ||
    !Number.isInteger(budget["maxIterations"]) ||
    !Number.isInteger(budget["maxTokens"]) ||
    !isRecord(cost) ||
    !isFiniteNumber(cost["actualUsd"]) ||
    !isFiniteNumber(cost["tokensIn"]) ||
    !isFiniteNumber(cost["tokensOut"]) ||
    (cost["avoidedUsd"] !== undefined && !isFiniteNumber(cost["avoidedUsd"])) ||
    !Array.isArray(attempts) ||
    !attempts.every(isRecord) ||
    (value["events"] !== undefined &&
      (!Array.isArray(value["events"]) || !value["events"].every(isRecord))) ||
    (value["artifacts"] !== undefined &&
      (!Array.isArray(value["artifacts"]) || !value["artifacts"].every(isRecord)))
  ) {
    throw storeUnreadableError();
  }

  return value as unknown as InspectableLoopRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
