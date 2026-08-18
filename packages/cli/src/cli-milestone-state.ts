import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { martinFilePath } from "./home-dir.js";
// Set by npm/pnpm when running as a package script; "unknown" in test/direct-node contexts.
const CLI_VERSION: string = process.env["npm_package_version"] ?? "unknown";

import type { LoopRecord } from "@martin/contracts";

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

function milestoneStatePath(): string {
  return martinFilePath("milestone-state.json");
}

export interface MilestoneState {
  version: 5;
  firstRunAt: string | null;
  runCount: number;
  successfulRunCount: number;
  failedRunCount: number;
  totalActualSpendUsd: number;
  totalEstimatedUncontrolledSpendUsd: number;
  totalSavedUsd: number;
  savingsConfidence: "confirmed" | "estimated" | "unavailable";
  bestRunSavedUsd: number | null;
  bestRunAt: string | null;
  reposUsed: string[];
  lastRunAt: string | null;
  dailyStreakDays: number;
  receiptsGenerated: number;
  rollbacksTriggered: number;
  verifierBlocks: number;
  currentRank: RankName;
  loopMilestones: { reached: number[] };
  streakMilestones: { reached: number[] };
  savingsMilestones: { reachedUsd: number[] };
  star: { shownCount: number; confirmed: boolean; lastShownAtSavedUsd?: number };
  feedback: {
    shownCount: number;
    lastShownAtSavedUsd?: number;
    lastShownAtRunCount?: number;
    scores: Array<{ score: number; runCount: number }>;
    featureVotes: string[];
    email: string | null;
    optedOut: boolean;
    lastDelivery?: IntakeDelivery;
  };
  waitlist: {
    status: "not_asked" | "declined" | "joined";
    declinedCount: number;
    email: string | null;
    shownAt: string | null;
    lastDelivery?: IntakeDelivery;
  };
  suppressUntilRun: number;
  governedBadge: { ctaShownAt: string | null };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RankName =
  | "Observer"
  | "Operator"
  | "Engineer"
  | "Architect"
  | "Control Plane"
  | "Infrastructure"
  | "Legend";

export type InlineMilestone =
  | { kind: "streak_milestone"; days: number }
  | { kind: "savings_milestone"; usd: number };

export type InteractivePrompt =
  | { kind: "loop_milestone"; count: number }
  | { kind: "star"; hard: boolean }
  | { kind: "feedback" }
  | { kind: "waitlist" }
  | null;

export interface RunPromptResult {
  inlineMilestones: InlineMilestone[];
  interactivePrompt: InteractivePrompt;
}

// ---------------------------------------------------------------------------
// Rank logic
// ---------------------------------------------------------------------------

const LOOP_MILESTONES = [10, 25, 50, 100, 250, 500, 1000] as const;
const STREAK_MILESTONES = [3, 7, 14, 30, 100] as const;
const SAVINGS_MILESTONES = [10, 50, 100, 500, 1000] as const;

export function computeRank(successfulRunCount: number, totalSavedUsd: number): RankName {
  if (successfulRunCount >= 1000 && totalSavedUsd >= 1000) return "Legend";
  if (successfulRunCount >= 500 && totalSavedUsd >= 500) return "Infrastructure";
  if (successfulRunCount >= 100 && totalSavedUsd >= 100) return "Control Plane";
  if (successfulRunCount >= 50 && totalSavedUsd >= 25) return "Architect";
  if (successfulRunCount >= 25 && totalSavedUsd >= 10) return "Engineer";
  if (successfulRunCount >= 10) return "Operator";
  return "Observer";
}

export function nextRank(rank: RankName): { name: RankName; loopsNeeded: number; savedNeeded: number } | null {
  switch (rank) {
    case "Observer": return { name: "Operator", loopsNeeded: 10, savedNeeded: 0 };
    case "Operator": return { name: "Engineer", loopsNeeded: 25, savedNeeded: 10 };
    case "Engineer": return { name: "Architect", loopsNeeded: 50, savedNeeded: 25 };
    case "Architect": return { name: "Control Plane", loopsNeeded: 100, savedNeeded: 100 };
    case "Control Plane": return { name: "Infrastructure", loopsNeeded: 500, savedNeeded: 500 };
    case "Infrastructure": return { name: "Legend", loopsNeeded: 1000, savedNeeded: 1000 };
    case "Legend": return null;
  }
}

// ---------------------------------------------------------------------------
// Helper functions (exported — imported by index.ts before it is touched)
// ---------------------------------------------------------------------------

export function deriveSavingsConfidence(loop: LoopRecord): "confirmed" | "estimated" | "unavailable" {
  const p = loop.cost.provenance;
  if (p === "actual") return "confirmed";
  if (p === "estimated") return "estimated";
  return "unavailable";
}

export function estimatedUncontrolledUsd(loop: LoopRecord): number {
  return loop.cost.actualUsd + (loop.cost.avoidedUsd ?? 0);
}

export function wasRollbackTaken(loop: LoopRecord): boolean {
  return loop.lifecycleState === "budget_exit";
}

export function wasVerifierBlocked(loop: LoopRecord): boolean {
  return loop.status === "failed";
}

// ---------------------------------------------------------------------------
// State I/O
// ---------------------------------------------------------------------------

// Fill any fields that may be absent in a v5 state written by an older iteration
// of this module. Spreads defaults first so new fields always have a safe value.
function fillDefaults(parsed: Record<string, unknown>): MilestoneState {
  const defaults = freshState();
  return {
    ...defaults,
    ...(parsed as Partial<MilestoneState>),
    version: 5,
    // Nested objects need explicit merge so a partial sub-object doesn't
    // silently drop sibling keys added in later iterations.
    star: { ...defaults.star, ...(parsed["star"] as typeof defaults.star ?? {}) },
    feedback: { ...defaults.feedback, ...(parsed["feedback"] as typeof defaults.feedback ?? {}) },
    waitlist: { ...defaults.waitlist, ...(parsed["waitlist"] as typeof defaults.waitlist ?? {}) },
    loopMilestones: { ...defaults.loopMilestones, ...(parsed["loopMilestones"] as typeof defaults.loopMilestones ?? {}) },
    streakMilestones: { ...defaults.streakMilestones, ...(parsed["streakMilestones"] as typeof defaults.streakMilestones ?? {}) },
    savingsMilestones: { ...defaults.savingsMilestones, ...(parsed["savingsMilestones"] as typeof defaults.savingsMilestones ?? {}) },
    governedBadge: { ...defaults.governedBadge, ...(parsed["governedBadge"] as typeof defaults.governedBadge ?? {}) },
  };
}

async function readState(): Promise<MilestoneState> {
  try {
    const raw = await readFile(milestoneStatePath(), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed["version"] === 5) return fillDefaults(parsed);
  } catch { /* first run or corrupt — start fresh */ }
  return freshState();
}

async function writeState(state: MilestoneState): Promise<void> {
  const statePath = milestoneStatePath();
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

function freshState(): MilestoneState {
  return {
    version: 5,
    firstRunAt: null,
    runCount: 0,
    successfulRunCount: 0,
    failedRunCount: 0,
    totalActualSpendUsd: 0,
    totalEstimatedUncontrolledSpendUsd: 0,
    totalSavedUsd: 0,
    savingsConfidence: "unavailable",
    bestRunSavedUsd: null,
    bestRunAt: null,
    reposUsed: [],
    lastRunAt: null,
    dailyStreakDays: 0,
    receiptsGenerated: 0,
    rollbacksTriggered: 0,
    verifierBlocks: 0,
    currentRank: "Observer",
    loopMilestones: { reached: [] },
    streakMilestones: { reached: [] },
    savingsMilestones: { reachedUsd: [] },
    star: { shownCount: 0, confirmed: false },
    feedback: {
      shownCount: 0,
      scores: [],
      featureVotes: [],
      email: null,
      optedOut: false
    },
    waitlist: {
      status: "not_asked",
      declinedCount: 0,
      email: null,
      shownAt: null
    },
    suppressUntilRun: 0,
    governedBadge: { ctaShownAt: null }
  };
}

// ---------------------------------------------------------------------------
// Streak computation
// ---------------------------------------------------------------------------

function updateStreak(prevLastRunAt: string | null, currentStreak: number, now: Date): number {
  if (!prevLastRunAt) return 1;
  const last = new Date(prevLastRunAt);
  const daysDiff = Math.floor((now.getTime() - last.getTime()) / (24 * 60 * 60 * 1000));
  if (daysDiff === 0) return currentStreak; // same day
  if (daysDiff === 1) return currentStreak + 1; // consecutive
  return 1; // streak broken
}

// ---------------------------------------------------------------------------
// Core export: recordRunAndGetPrompt
// ---------------------------------------------------------------------------

export async function recordRunAndGetPrompt(input: {
  success: boolean;
  repoRoot: string;
  actualSpendUsd: number;
  estimatedUncontrolledUsd: number;
  savingsConfidence: "confirmed" | "estimated" | "unavailable";
  rollbackTaken: boolean;
  verifierBlock: boolean;
}): Promise<RunPromptResult> {
  // CI guard — suppress all interactive prompts in non-interactive or CI environments
  if (!process.stdout.isTTY || process.env["CI"]) {
    return { inlineMilestones: [], interactivePrompt: null };
  }

  const state = await readState();
  const now = new Date();
  const savedThisRun =
    input.savingsConfidence !== "unavailable"
      ? Math.max(0, input.estimatedUncontrolledUsd - input.actualSpendUsd)
      : 0;

  // Update counters
  state.runCount += 1;
  if (input.success) state.successfulRunCount += 1;
  else state.failedRunCount += 1;

  if (!state.firstRunAt) state.firstRunAt = now.toISOString();
  const prevLastRunAt = state.lastRunAt;
  state.lastRunAt = now.toISOString();

  state.totalActualSpendUsd += input.actualSpendUsd;
  state.totalEstimatedUncontrolledSpendUsd += input.estimatedUncontrolledUsd;
  if (input.savingsConfidence !== "unavailable") {
    state.totalSavedUsd += savedThisRun;
  }

  // Update savings confidence (upgrade only: unavailable → estimated → confirmed)
  if (
    input.savingsConfidence === "confirmed" ||
    (input.savingsConfidence === "estimated" && state.savingsConfidence !== "confirmed")
  ) {
    state.savingsConfidence = input.savingsConfidence;
  }

  // Best run
  if (savedThisRun > 0 && (state.bestRunSavedUsd === null || savedThisRun > state.bestRunSavedUsd)) {
    state.bestRunSavedUsd = savedThisRun;
    state.bestRunAt = now.toISOString();
  }

  // Repos
  const repoKey = input.repoRoot.toLowerCase();
  if (!state.reposUsed.includes(repoKey)) {
    state.reposUsed = [...state.reposUsed, repoKey];
  }

  // Streak — use prevLastRunAt captured before state.lastRunAt was overwritten
  if (input.success) {
    state.dailyStreakDays = updateStreak(prevLastRunAt, state.dailyStreakDays, now);
  }

  // Counters
  if (input.rollbackTaken) state.rollbacksTriggered += 1;
  if (input.verifierBlock) state.verifierBlocks += 1;
  if (input.success) state.receiptsGenerated += 1;

  // Rank
  const prevRank = state.currentRank;
  state.currentRank = computeRank(state.successfulRunCount, state.totalSavedUsd);

  const rankChanged = state.currentRank !== prevRank;

  // ---------------------------------------------------------------------------
  // Collect inline milestones (streak + savings — always render, no suppression)
  // ---------------------------------------------------------------------------
  const inlineMilestones: InlineMilestone[] = [];

  if (input.success) {
    for (const days of STREAK_MILESTONES) {
      if (state.dailyStreakDays === days && !state.streakMilestones.reached.includes(days)) {
        state.streakMilestones.reached = [...state.streakMilestones.reached, days];
        inlineMilestones.push({ kind: "streak_milestone", days });
      }
    }
  }

  for (const usd of SAVINGS_MILESTONES) {
    if (state.totalSavedUsd >= usd && !state.savingsMilestones.reachedUsd.includes(usd)) {
      state.savingsMilestones.reachedUsd = [...state.savingsMilestones.reachedUsd, usd];
      inlineMilestones.push({ kind: "savings_milestone", usd });
    }
  }

  // ---------------------------------------------------------------------------
  // Check for loop milestone (fires once, suppresses GTM that run)
  // ---------------------------------------------------------------------------
  let loopMilestoneHit: number | null = null;
  if (input.success) {
    for (const count of LOOP_MILESTONES) {
      if (state.successfulRunCount === count && !state.loopMilestones.reached.includes(count)) {
        state.loopMilestones.reached = [...state.loopMilestones.reached, count];
        loopMilestoneHit = count;
        break;
      }
    }
  }

  await writeState(state);

  // Loop milestone takes exclusive interactive slot — no GTM alongside it
  if (loopMilestoneHit !== null) {
    return {
      inlineMilestones,
      interactivePrompt: { kind: "loop_milestone", count: loopMilestoneHit }
    };
  }

  // GTM: max 1 interactive prompt per run. Priority: waitlist > feedback > star
  // Suppressed if suppressUntilRun is set and not yet reached
  if (state.suppressUntilRun > state.runCount) {
    return { inlineMilestones, interactivePrompt: null };
  }

  const interactivePrompt = selectGtmPrompt(state, input, savedThisRun, rankChanged);

  return { inlineMilestones, interactivePrompt };
}

function selectGtmPrompt(
  state: MilestoneState,
  input: { success: boolean; rollbackTaken: boolean; verifierBlock: boolean },
  savedThisRun: number,
  _rankChanged: boolean
): InteractivePrompt {
  // Waitlist: $50+ saved OR 2+ repos
  if (
    state.waitlist.status === "not_asked" &&
    (state.totalSavedUsd >= 50 || state.reposUsed.length >= 2)
  ) {
    return { kind: "waitlist" };
  }

  // Feedback: $10+ saved OR 5+ successful runs OR rollback/verifier-block
  // Also fire every $50 saved after first feedback
  const feedbackBySpend = state.totalSavedUsd >= 10 &&
    (state.feedback.lastShownAtSavedUsd === undefined ||
      state.totalSavedUsd - state.feedback.lastShownAtSavedUsd >= 50);
  // Recurrence intervals — product decisions, not magic numbers.
  // feedbackByRuns: re-prompt every 15 successful runs after first show.
  // feedbackByEvent: re-prompt every 10 successful runs after a qualifying event show.
  const FEEDBACK_RECURRENCE_RUN_INTERVAL = 15;
  const FEEDBACK_RECURRENCE_EVENT_INTERVAL = 10;

  const feedbackByRuns = state.successfulRunCount >= 5 &&
    (state.feedback.lastShownAtRunCount === undefined ||
      state.successfulRunCount - state.feedback.lastShownAtRunCount >= FEEDBACK_RECURRENCE_RUN_INTERVAL);
  const feedbackByEvent = (input.rollbackTaken || input.verifierBlock) &&
    (state.feedback.shownCount === 0 ||
      state.successfulRunCount - (state.feedback.lastShownAtRunCount ?? 0) >= FEEDBACK_RECURRENCE_EVENT_INTERVAL);

  if (feedbackBySpend || feedbackByRuns || feedbackByEvent) {
    return { kind: "feedback" };
  }

  // Star: soft from run 2, hard from run 10. Max 2 shows total. Suppress after confirmed.
  if (!state.star.confirmed && state.star.shownCount < 2 && state.successfulRunCount >= 2) {
    return { kind: "star", hard: state.successfulRunCount >= 10 };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Post-interaction recording
// ---------------------------------------------------------------------------

export async function recordStarConfirmed(): Promise<void> {
  const state = await readState();
  state.star.confirmed = true;
  await writeState(state);
}

// ---------------------------------------------------------------------------
// CLI intake — best-effort, never blocks user flow.
// Submits to MartinLoop-owned Supabase Edge Function. Auth key is server-side.
//
// Intake URL model: production default endpoint.
// Read at call time so MARTIN_INTAKE_URL overrides work in tests and at runtime.
// "not_configured" cannot occur — a hardcoded fallback always exists.
// ---------------------------------------------------------------------------

const INTAKE_DEFAULT_URL = "https://tupopqvqnyyjuxseyxkr.supabase.co/functions/v1/cli-intake";

function getIntakeUrl(): string {
  return process.env["MARTIN_INTAKE_URL"] ?? INTAKE_DEFAULT_URL;
}

export type IntakePayload = {
  source: "martin-cli";
  event: "feedback" | "pilot_interest";
  cliVersion: string;
  email?: string;
  score?: number;
  featureVote?: string;
  consentToContact: boolean;
  platform: NodeJS.Platform;
  createdAt: string;
};

export type IntakeSubmissionResult =
  | { ok: true; status: "accepted" | "duplicate"; submissionId?: string }
  | {
      ok: false;
      status: "timeout" | "network_error" | "rejected" | "server_error";
      retryable: boolean;
      message: string;
    };

/** Privacy-safe local record of the most recent intake hand-off. */
export interface IntakeDelivery {
  status: "accepted" | "duplicate" | "queued" | "rejected";
  recordedAt: string;
  submissionId?: string;
}

export function intakeDeliveryFromResult(result: IntakeSubmissionResult): IntakeDelivery {
  if (result.ok) {
    return {
      status: result.status,
      recordedAt: new Date().toISOString(),
      ...(result.submissionId ? { submissionId: result.submissionId } : {})
    };
  }

  return {
    status: result.retryable ? "queued" : "rejected",
    recordedAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Retry queue (~/.martin/intake-draft.jsonl)
//
// Scope:            GLOBAL — one file shared across all workspaces/repos on
//                   this machine, same as the milestone state file.
//                   Submissions are user-level, not repo-level.
//
// Concurrent-write: ALL queue writes (queueIntakeRetry and retryQueuedIntake)
//                   acquire an exclusive lock file (.jsonl.lock) before the
//                   read-modify-write cycle. Lock uses O_CREAT|O_EXCL (atomic
//                   on POSIX and NTFS), stores the writer's PID for stale-lock
//                   detection, and has a 500 ms bounded wait with 50 ms retry
//                   interval. Failure to acquire the lock silently skips the
//                   queue operation — the main CLI command is never affected.
//                   Two concurrent writers are serialized: the second reads the
//                   first's entry and writes both, so no entry is lost.
//
// What is queued:   retryable failures only (timeout, network_error, server_error,
//                   429 rate-limit)
// What is excluded: email (PII stripped at queue-write time)
//                   422/4xx permanent rejections (retrying is futile)
// PII migration:    sanitizeRetryQueue() strips email from any legacy entries
//                   written by older CLI versions before processing the queue
// Opt-out:          if state.feedback.optedOut, nothing is queued and existing
//                   queue is cleared on next retryQueuedIntake() call
// Max size:         50 entries — enforced at every write; oldest dropped
// Retention:        entries older than 30 days are dropped on read
// Deduplication:    entries with the same event:cliVersion:createdAt key are
//                   replaced rather than appended (enforced at every write)
// File mode:        0o600 (user read/write only), written via atomic rename
// Retry trigger:    retryQueuedIntake() — called only on verified-success
//                   interactive TTY runs; no immediate backoff (next-run retry)
// ---------------------------------------------------------------------------

const MAX_RETRY_ENTRIES = 50;
const RETRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const LOCK_RETRY_INTERVAL_MS = 50;
const LOCK_TIMEOUT_MS = 500;

type RetryEntry = Omit<IntakePayload, "email"> & {
  _failedAt: string;
  _reason: "timeout" | "network_error" | "server_error";
};

function intakeDraftPath(): string {
  return martinFilePath("intake-draft.jsonl");
}

function queueLockPath(): string {
  return `${intakeDraftPath()}.lock`;
}

async function ensureIntakeDirectory(): Promise<void> {
  await mkdir(dirname(intakeDraftPath()), { recursive: true, mode: 0o700 });
}

// Acquire an exclusive lock file. Uses O_CREAT|O_EXCL (atomic on POSIX and
// NTFS). Stores the writer's PID so stale locks from dead processes are
// detected and removed. Bounded wait: LOCK_TIMEOUT_MS with LOCK_RETRY_INTERVAL_MS
// between attempts. Returns false on timeout — never throws.
async function acquireQueueLock(): Promise<boolean> {
  const lock = queueLockPath();
  await ensureIntakeDirectory();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      // wx = O_WRONLY|O_CREAT|O_EXCL — atomic exclusive creation
      await writeFile(lock, String(process.pid), { flag: "wx", encoding: "utf8" });
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
      // Lock exists — check whether the holding process is still alive
      try {
        const held = parseInt(await readFile(lock, "utf8"), 10);
        if (!isNaN(held) && held !== process.pid) {
          try {
            process.kill(held, 0); // throws ESRCH if process is gone
          } catch {
            // Stale lock — remove and retry immediately
            await rm(lock, { force: true }).catch(() => undefined);
            continue;
          }
        }
      } catch { /* ignore read errors — retry after interval */ }
      await new Promise<void>((r) => setTimeout(r, LOCK_RETRY_INTERVAL_MS));
    }
  }
  return false;
}

async function releaseQueueLock(): Promise<void> {
  await rm(queueLockPath(), { force: true }).catch(() => undefined);
}

// Read the queue, applying retention, deduplication, and the entry cap.
async function readRetryQueue(): Promise<RetryEntry[]> {
  const raw = await readFile(intakeDraftPath(), "utf8").catch(() => "");
  const cutoff = Date.now() - RETRY_RETENTION_MS;
  const all = raw
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const entry = JSON.parse(line) as RetryEntry;
        const failedAt = Date.parse(entry._failedAt);
        if (!Number.isFinite(failedAt) || failedAt < cutoff) return [];
        return [entry];
      } catch {
        return [];
      }
    });
  // Dedup: last occurrence of each key wins
  const seen = new Map<string, RetryEntry>();
  for (const entry of all) {
    seen.set(`${entry.event}:${entry.cliVersion}:${entry.createdAt}`, entry);
  }
  return [...seen.values()].slice(-MAX_RETRY_ENTRIES);
}

// Full rewrite — always called while holding the queue lock.
async function writeRetryQueue(entries: RetryEntry[]): Promise<void> {
  await ensureIntakeDirectory();
  const path = intakeDraftPath();
  const tempPath = `${path}.${process.pid}.tmp`;
  const body = entries.map((e) => JSON.stringify(e)).join("\n");
  await writeFile(tempPath, body ? `${body}\n` : "", { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, path);
}

// Add one entry to the retry queue under an exclusive lock.
// Concurrent processes are serialized: the second writer reads the first's
// entry before writing, so both entries are preserved.
// Silently skips if the lock cannot be acquired — the main CLI command is
// never affected; the event may be re-submitted on the next eligible run.
async function queueIntakeRetry(
  payload: IntakePayload,
  reason: RetryEntry["_reason"]
): Promise<void> {
  const state = await readState();
  if (state.feedback.optedOut) return;

  const { email: _email, ...safePayload } = payload;
  const entry: RetryEntry = { ...safePayload, _failedAt: new Date().toISOString(), _reason: reason };

  const locked = await acquireQueueLock().catch(() => false);
  if (!locked) return; // skip silently — lock held by another process

  try {
    const existing = await readRetryQueue();
    const dedupeKey = `${entry.event}:${entry.cliVersion}:${entry.createdAt}`;
    const deduped = existing.filter(
      (c) => `${c.event}:${c.cliVersion}:${c.createdAt}` !== dedupeKey
    );
    await writeRetryQueue([...deduped, entry].slice(-MAX_RETRY_ENTRIES));
  } finally {
    await releaseQueueLock();
  }
}

export async function submitToIntake(
  payload: IntakePayload,
  options: { queueOnFailure?: boolean } = {}
): Promise<IntakeSubmissionResult> {
  const { queueOnFailure = true } = options;
  const controller = new AbortController();
  // Abort does not guarantee that Windows fetch settles promptly, so race the
  // transport against an explicit deadline and let the queued retry handle it.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Response>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error("Intake request timed out after 3 seconds.");
      error.name = "AbortError";
      reject(error);
    }, 3_000);
  });

  try {
    const response = await Promise.race([
      fetch(getIntakeUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `${payload.event}:${payload.cliVersion}:${payload.createdAt}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }),
      timeout,
    ]);

    // 409 = idempotent duplicate
    if (response.status === 409) return { ok: true, status: "duplicate" };

    // 422 = validation rejection — payload will never be valid; do not retry
    if (response.status === 422) {
      return { ok: false, status: "rejected", retryable: false, message: "Submission rejected by intake validation." };
    }

    // 429 = rate-limited — retry on the next eligible run (next-run retry, not immediate backoff)
    if (response.status === 429) {
      const result: IntakeSubmissionResult = {
        ok: false,
        status: "server_error",
        retryable: true,
        message: "Intake request rate-limited (429). Will retry on next run.",
      };
      if (queueOnFailure) {
        await queueIntakeRetry(payload, "server_error").catch(() => undefined);
      }
      return result;
    }

    if (!response.ok) {
      // 400, 401, 403 and other 4xx: permanent client-side failures — do not retry.
      // 5xx: transient server failures — retry on next eligible run.
      const result: IntakeSubmissionResult = {
        ok: false,
        status: "server_error",
        retryable: response.status >= 500,
        message: `Intake request failed with HTTP ${response.status}.`,
      };
      if (result.retryable && queueOnFailure) {
        await queueIntakeRetry(payload, "server_error").catch(() => undefined);
      }
      return result;
    }

    const body = (await response.json().catch(() => ({}))) as { id?: unknown };
    return {
      ok: true,
      status: "accepted",
      submissionId: typeof body.id === "string" ? body.id : undefined,
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    const reason: RetryEntry["_reason"] = timedOut ? "timeout" : "network_error";
    const result: IntakeSubmissionResult = timedOut
      ? { ok: false, status: "timeout", retryable: true, message: "Intake request timed out after 3 seconds. Will retry on next run." }
      : { ok: false, status: "network_error", retryable: true, message: error instanceof Error ? error.message : String(error) };

    if (queueOnFailure) {
      await queueIntakeRetry(payload, reason).catch(() => undefined);
    }
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Retry queued intake submissions.
// Called only on verified-success interactive TTY runs — never in CI, MCP,
// quiet, JSON, or piped output modes. Never recurses: uses queueOnFailure:false.
// ---------------------------------------------------------------------------

// Strips email from any legacy queue entries written by older CLI versions.
// readRetryQueue() already drops malformed lines, so only structurally valid
// entries with an unexpected email field need to be sanitized here.
async function sanitizeRetryQueue(): Promise<void> {
  const raw = await readFile(intakeDraftPath(), "utf8").catch(() => "");
  if (!raw.trim()) return;
  const sanitized = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if ("email" in entry) {
          const { email: _e, ...clean } = entry;
          return JSON.stringify(clean);
        }
        return line;
      } catch {
        return null; // drop malformed lines
      }
    })
    .filter((l): l is string => l !== null)
    .join("\n");
  if (sanitized !== raw.trim()) {
    await writeRetryQueue(
      sanitized
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => { try { return [JSON.parse(l) as RetryEntry]; } catch { return []; } })
    ).catch(() => undefined);
  }
}

export async function retryQueuedIntake(): Promise<void> {
  // Acquire exclusive lock for the full read-compact-rewrite cycle.
  // If another process holds the lock, skip this attempt silently —
  // the main CLI result is never affected.
  const locked = await acquireQueueLock().catch(() => false);
  if (!locked) return;

  try {
    // Sanitize legacy entries (strips PII from old CLI versions) while holding lock.
    await sanitizeRetryQueue().catch(() => undefined);

    const state = await readState();
    if (state.feedback.optedOut) {
      await writeRetryQueue([]).catch(() => undefined);
      return;
    }

    const queued = await readRetryQueue();
    if (queued.length === 0) return;

    const remaining: RetryEntry[] = [];
    for (const entry of queued) {
      const { _failedAt: _f, _reason: _r, ...payload } = entry;
      // queueOnFailure:false prevents recursive re-queueing from within a retry run.
      const result = await submitToIntake(payload as IntakePayload, { queueOnFailure: false });
      if (!result.ok && result.retryable) {
        remaining.push(entry);
      }
    }

    await writeRetryQueue(remaining).catch(() => undefined);
  } finally {
    await releaseQueueLock();
  }
}

// ---------------------------------------------------------------------------
// Post-interaction recording
// ---------------------------------------------------------------------------

export async function recordWaitlistJoined(email: string): Promise<void> {
  const state = await readState();
  state.waitlist.status = "joined";
  state.waitlist.email = email;
  state.waitlist.shownAt = new Date().toISOString();
  await writeState(state);
  const submission = await submitToIntake({
    source: "martin-cli",
    event: "pilot_interest",
    cliVersion: CLI_VERSION,
    email,
    consentToContact: true,
    platform: process.platform,
    createdAt: new Date().toISOString(),
  });
  const updated = await readState();
  updated.waitlist.lastDelivery = intakeDeliveryFromResult(submission);
  await writeState(updated);
}

export async function recordWaitlistDeclined(): Promise<void> {
  const state = await readState();
  state.waitlist.declinedCount += 1;
  if (state.waitlist.declinedCount >= 2) {
    state.waitlist.status = "declined";
  }
  await writeState(state);
}

export async function recordFeedback(score: number, featureVote?: string, email?: string): Promise<void> {
  const state = await readState();
  state.feedback.shownCount += 1;
  state.feedback.lastShownAtSavedUsd = state.totalSavedUsd;
  state.feedback.lastShownAtRunCount = state.successfulRunCount;
  state.feedback.scores = [...state.feedback.scores, { score, runCount: state.successfulRunCount }];
  if (featureVote) state.feedback.featureVotes = [...state.feedback.featureVotes, featureVote];
  if (email) state.feedback.email = email;
  await writeState(state);
  const submission = await submitToIntake({
    source: "martin-cli",
    event: "feedback",
    cliVersion: CLI_VERSION,
    score,
    ...(featureVote ? { featureVote } : {}),
    ...(email ? { email } : {}),
    consentToContact: !!email,
    platform: process.platform,
    createdAt: new Date().toISOString(),
  });
  const updated = await readState();
  updated.feedback.lastDelivery = intakeDeliveryFromResult(submission);
  await writeState(updated);
}

// ---------------------------------------------------------------------------
// For martin stats command
// ---------------------------------------------------------------------------

export async function readMilestoneState(): Promise<MilestoneState | null> {
  try {
    const raw = await readFile(milestoneStatePath(), "utf8");
    const parsed = JSON.parse(raw) as MilestoneState;
    return parsed.version === 5 ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Governed badge CTA — one-time post-run prompt
// ---------------------------------------------------------------------------

export function isBadgeCtaEligible(state: MilestoneState): boolean {
  return state.governedBadge.ctaShownAt === null;
}

export async function recordBadgeCtaShown(): Promise<void> {
  const state = await readState();
  state.governedBadge.ctaShownAt = new Date().toISOString();
  await writeState(state);
}
