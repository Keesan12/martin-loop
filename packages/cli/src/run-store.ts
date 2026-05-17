import { readFile, readdir, stat } from "node:fs/promises";
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

export interface CliEnvironment {
  invocationRoot: string;
  workingDirectory: string;
  runsRoot: string;
  engine: "claude" | "codex";
  liveMode: "live" | "stub";
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
  warnings: string[];
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
  env?: NodeJS.ProcessEnv;
} = {}): CliEnvironment {
  const env = input.env ?? process.env;
  const invocationRoot = resolveInvocationRoot(env);
  const workingDirectory = path.resolve(invocationRoot, input.cwd ?? process.cwd());
  const runsRoot = path.resolve(resolveRunsRoot({ ...env, MARTIN_RUNS_DIR: input.runsDir ?? env.MARTIN_RUNS_DIR }));
  const engine = input.engine === "codex" ? "codex" : "claude";

  return {
    invocationRoot,
    workingDirectory,
    runsRoot,
    engine,
    liveMode: env.MARTIN_LIVE === "false" ? "stub" : "live"
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
      warnings: ["Verification evidence is unavailable for this persisted loop."]
    };
  }

  const passed = latestEvent.payload["passed"] === true;
  const latestAttemptIndex =
    typeof latestEvent.payload["attemptIndex"] === "number"
      ? (latestEvent.payload["attemptIndex"] as number)
      : loop.attempts.at(-1)?.index;

  return {
    status: passed ? "passed" : "failed",
    summary:
      typeof latestEvent.payload["summary"] === "string"
        ? (latestEvent.payload["summary"] as string)
        : passed
          ? "Verification passed."
          : "Verification failed.",
    eventCount: verificationEvents.length,
    ...(latestAttemptIndex !== undefined ? { latestAttemptIndex } : {}),
    completedAt: latestEvent.timestamp,
    warnings: []
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

export function buildRunDossier(detail: PersistedLoopDetail): Record<string, unknown> {
  const verification = buildVerificationSummary(detail.loop);
  const artifactSummary = buildArtifactSummary(detail.loop);

  return {
    source: detail.source,
    paths: {
      runsRoot: detail.runsRoot,
      ...(detail.runDirectory ? { runDirectory: detail.runDirectory } : {}),
      ...(detail.loopRecordPath ? { loopRecordPath: detail.loopRecordPath } : {})
    },
    loop: detail.loop,
    verification,
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
