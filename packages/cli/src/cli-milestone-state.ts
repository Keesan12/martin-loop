import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
// Set by npm/pnpm when running as a package script; "unknown" in test/direct-node contexts.
const CLI_VERSION: string = process.env["npm_package_version"] ?? "unknown";

import type { LoopRecord } from "@martin/contracts";

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

const STATE_PATH = join(homedir(), ".martin", "milestone-state.json");

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
  };
  waitlist: {
    status: "not_asked" | "declined" | "joined";
    declinedCount: number;
    email: string | null;
    shownAt: string | null;
  };
  suppressUntilRun: number;
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
  };
}

async function readState(): Promise<MilestoneState> {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed["version"] === 5) return fillDefaults(parsed);
  } catch { /* first run or corrupt — start fresh */ }
  return freshState();
}

async function writeState(state: MilestoneState): Promise<void> {
  await mkdir(join(homedir(), ".martin"), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
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
      email: null
    },
    waitlist: {
      status: "not_asked",
      declinedCount: 0,
      email: null,
      shownAt: null
    },
    suppressUntilRun: 0
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
  const feedbackByRuns = state.successfulRunCount >= 5 &&
    state.feedback.lastShownAtRunCount === undefined;
  const feedbackByEvent = (input.rollbackTaken || input.verifierBlock) &&
    state.feedback.shownCount === 0;

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
// Submits to MartinLoop-owned endpoint. Key lives server-side, never in CLI.
// Override endpoint with MARTIN_INTAKE_URL env var for dev/self-hosting.
// ---------------------------------------------------------------------------

const INTAKE_URL =
  process.env["MARTIN_INTAKE_URL"] ??
  "https://tupopqvqnyyjuxseyxkr.supabase.co/functions/v1/cli-intake";

type IntakePayload = {
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

async function submitToIntake(payload: IntakePayload): Promise<void> {
  if (!INTAKE_URL) return;
  try {
    const res = await fetch(INTAKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    try {
      const draftPath = join(homedir(), ".martin", "intake-draft.jsonl");
      await appendFile(draftPath, JSON.stringify({ ...payload, _failedAt: new Date().toISOString() }) + "\n");
    } catch { /* double silent fail */ }
  }
}

export async function recordWaitlistJoined(email: string): Promise<void> {
  const state = await readState();
  state.waitlist.status = "joined";
  state.waitlist.email = email;
  state.waitlist.shownAt = new Date().toISOString();
  await writeState(state);
  void submitToIntake({
    source: "martin-cli",
    event: "pilot_interest",
    cliVersion: CLI_VERSION,
    email,
    consentToContact: true,
    platform: process.platform,
    createdAt: new Date().toISOString(),
  });
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
  void submitToIntake({
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
}

// ---------------------------------------------------------------------------
// For martin stats command
// ---------------------------------------------------------------------------

export async function readMilestoneState(): Promise<MilestoneState | null> {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as MilestoneState;
    return parsed.version === 5 ? parsed : null;
  } catch {
    return null;
  }
}
