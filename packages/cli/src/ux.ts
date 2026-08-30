import type { MartinErrorCategory, MartinOutputMode, VerifiedHandoffOutcome } from "@martin/contracts";

const EXIT_CODES: Record<MartinErrorCategory, number> = {
  invalid_input: 2,
  environment: 3,
  auth: 4,
  not_found: 5,
  store_unreadable: 6,
  verification_failed: 7,
  policy_blocked: 8,
  budget_exit: 9,
  transient: 10
};

export function exitCodeForGovernedOutcome(outcome: VerifiedHandoffOutcome): number {
  switch (outcome) {
    case "VERIFIED":
      return 0;
    case "STOPPED":
      return EXIT_CODES.budget_exit;
    case "NEEDS_REVIEW":
      return EXIT_CODES.verification_failed;
  }
}

export interface CliFailurePayload {
  ok: false;
  category: MartinErrorCategory;
  message: string;
  suggestion?: string;
  details?: Record<string, unknown>;
}

export interface CliSuccessPayload<T = unknown> {
  ok: true;
  data: T;
  warnings?: string[];
}

export interface CliRenderInput<T = unknown> {
  data: T;
  human: string | string[];
  quiet?: string;
  warnings?: string[];
  exitCode?: number;
}

export class CliCommandError extends Error {
  readonly category: MartinErrorCategory;
  readonly suggestion?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    category: MartinErrorCategory,
    message: string,
    options: {
      suggestion?: string;
      details?: Record<string, unknown>;
    } = {}
  ) {
    super(message);
    this.name = "CliCommandError";
    this.category = category;
    this.suggestion = options.suggestion;
    this.details = options.details;
  }
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function renderCliSuccess(
  mode: MartinOutputMode,
  input: CliRenderInput
): { exitCode: number; stdout: string; stderr: string } {
  if (mode === "json") {
    const payload =
      typeof input.data === "object" && input.data !== null
        ? {
            ...input.data,
            ...(input.warnings?.length ? { warnings: input.warnings } : {})
          }
        : {
            data: input.data,
            ...(input.warnings?.length ? { warnings: input.warnings } : {})
          };
    return {
      exitCode: input.exitCode ?? 0,
      stdout: formatJson(payload),
      stderr: ""
    };
  }

  if (mode === "quiet") {
    return {
      exitCode: input.exitCode ?? 0,
      stdout: input.quiet ?? "",
      stderr: ""
    };
  }

  const lines = Array.isArray(input.human) ? input.human : [input.human];
  const warnings = input.warnings?.map((warning) => `Warning: ${warning}`) ?? [];
  return {
    exitCode: input.exitCode ?? 0,
    stdout: [...lines, ...(warnings.length > 0 ? ["", ...warnings] : [])].join("\n"),
    stderr: ""
  };
}

export function renderCliError(
  mode: MartinOutputMode,
  error: unknown
): { exitCode: number; stdout: string; stderr: string } {
  const failure = toCliFailurePayload(error);

  if (mode === "json") {
    return {
      exitCode: EXIT_CODES[failure.category],
      stdout: formatJson(failure),
      stderr: ""
    };
  }

  const message = failure.suggestion
    ? `Error [${failure.category}]: ${failure.message}\nSuggestion: ${failure.suggestion}`
    : `Error [${failure.category}]: ${failure.message}`;

  return {
    exitCode: EXIT_CODES[failure.category],
    stdout: "",
    stderr: message
  };
}

function toCliFailurePayload(error: unknown): CliFailurePayload {
  if (error instanceof CliCommandError) {
    return {
      ok: false,
      category: error.category,
      message: error.message,
      ...(error.suggestion ? { suggestion: error.suggestion } : {}),
      ...(error.details ? { details: error.details } : {})
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    category: "transient",
    message
  };
}

// ---------------------------------------------------------------------------
// Loop Experience Engine v5 — rendering
// ---------------------------------------------------------------------------

import * as readline from "node:readline";
import { exec } from "node:child_process";
import type { MilestoneState, InlineMilestone, InteractivePrompt, RankName } from "./cli-milestone-state.js";
import { nextRank } from "./cli-milestone-state.js";

const KEY_TIMEOUT_MS = 30_000;

function readSingleKey(): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { resolve(""); return; }

    let settled = false;
    const settle = (key: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      resolve(key);
    };

    const timer = setTimeout(() => settle(""), KEY_TIMEOUT_MS);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (key: string) => settle(key));
    process.stdin.once("error", () => settle(""));
  });
}

interface LineReader {
  read: () => Promise<string>;
  close: () => void;
}

// Creates one readline interface for an entire prompt interaction (which may
// involve several sequential questions), instead of a fresh interface per
// question. Recreating the interface for every question raced its own
// "line" and "close" events against each other and could resolve empty even
// when the user had typed a real answer.
function createLineReader(): LineReader {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  let closed = false;
  let pendingResolve: ((value: string) => void) | null = null;

  rl.on("close", () => {
    closed = true;
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve("");
    }
  });

  const read = (): Promise<string> => {
    if (closed) return Promise.resolve("");
    return new Promise((resolve) => {
      pendingResolve = resolve;
      rl.once("line", (line: string) => {
        pendingResolve = null;
        resolve(line);
      });
    });
  };

  const close = (): void => {
    if (!closed) rl.close();
  };

  return { read, close };
}

function openUrl(url: string): void {
  const cmd = process.platform === "win32" ? `start "" "${url}"` :
    process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd); // fire-and-forget — best effort
}

const SEPARATOR = "━".repeat(47);
const THIN = "─".repeat(47);

const STREAK_MESSAGES: Record<number, string> = {
  3: "🔥 3-day streak. this is becoming a pattern.",
  7: "🔥 7-day streak. that's a workflow, not a trial.",
  14: "🔥 14 days. this is infrastructure now.",
  30: "🔥 30-day streak. control plane energy.",
  100: "🔥 100-day streak. legend territory."
};

const SAVINGS_MESSAGES: Record<number, string> = {
  10: "  💰 $10 saved lifetime. receipts are real.",
  50: "  💰 $50 saved lifetime. martin is earning its keep.",
  100: "  💰 $100 saved. three digits. this is infrastructure now.",
  500: "  💰 $500 saved. operator-tier governance.",
  1000: "  💰 $1,000 saved. the receipts speak for themselves."
};

const LOOP_MESSAGES: Record<number, string> = {
  10: "10 governed loops.",
  25: "25 loops. pattern established.",
  50: "50 loops. this is how the good teams work.",
  100: "100 loops. three digits of governed execution.",
  250: "250 loops. serious infrastructure.",
  500: "500 loops. this is a different category of operator.",
  1000: "1,000 loops. legend."
};

export function buildRankHeader(rank: RankName, termWidth: number): string {
  const left = "∞ martinloop";
  const right = `[${rank}]`;
  const pad = termWidth - left.length - right.length;
  if (pad < 2) return left;
  return left + " ".repeat(pad) + right;
}

export type RunOutcome = "success" | "awaiting_signoff" | "approval_blocked" | "failure";

export function renderRunHeader(
  rank: RankName,
  outcome: RunOutcome,
  attempts: number,
  actualUsd: number,
  savedThisRun: number,
  lifetimeSaved: number,
  savingsConfidence: "confirmed" | "estimated" | "unavailable",
  receiptPersisted: boolean
): string {
  const termWidth = process.stdout.columns ?? 80;
  const lines: string[] = [
    SEPARATOR,
    buildRankHeader(rank, termWidth),
    SEPARATOR
  ];

  const checkMark =
    outcome === "success" ? "✓ verified" :
    outcome === "awaiting_signoff" ? "✓ verified — awaiting sign-off" :
    outcome === "approval_blocked" ? "✗ approval required" :
    "✗ run failed";
  const attemptStr = `${attempts} attempt${attempts === 1 ? "" : "s"}`;

  if (outcome === "success" || outcome === "awaiting_signoff") {
    lines.push(`  ${checkMark} · ${attemptStr} · $${actualUsd.toFixed(2)} spent`);

    if (outcome === "awaiting_signoff") {
      lines.push("    verification passed; a receipt was recorded. review and accept when ready.");
    }

    if (savingsConfidence === "confirmed" && savedThisRun > 0) {
      lines.push(`  💰 confirmed saved $${savedThisRun.toFixed(2)} this run · $${lifetimeSaved.toFixed(2)} lifetime`);
      if (savedThisRun >= 20) {
        lines.push("    that agent had plans.");
      }
    } else if (savingsConfidence === "estimated" && savedThisRun > 0) {
      lines.push(`  💰 estimated saved ~$${savedThisRun.toFixed(2)} this run · ~$${lifetimeSaved.toFixed(2)} lifetime`);
      if (savedThisRun >= 20) {
        lines.push("    martin does not apologize for this.");
      }
    }
    // Tier 3: no dollar figure, loop count shown at end via run output
  } else {
    lines.push(`  ${checkMark} · ${attemptStr}`);
    lines.push(
      receiptPersisted
        ? "    failure evidence and a signed receipt were saved for inspection."
        : "    run evidence could not be persisted; no receipt is available."
    );
  }

  lines.push(SEPARATOR);
  return lines.join("\n");
}

export function renderInlineMilestone(milestone: InlineMilestone): string {
  if (milestone.kind === "streak_milestone") {
    return STREAK_MESSAGES[milestone.days] ?? `🔥 ${milestone.days}-day streak.`;
  }
  return SAVINGS_MESSAGES[milestone.usd] ?? `  💰 $${milestone.usd} saved lifetime.`;
}

export function renderLoopMilestoneBox(count: number, rank: RankName, prevRank: RankName | null): string {
  const rankLine = rank !== prevRank ? `\n  ⬡ rank unlocked: ${rank}` : "";
  const body = LOOP_MESSAGES[count] ?? `${count} loops.`;
  return ["", THIN, `  ∞ ${body}${rankLine}`, THIN, ""].join("\n");
}

export interface MilestonePromptCtx {
  rank: RankName;
  prevRank: RankName | null;
  totalSavedUsd: number;
  successfulRunCount: number;
  starShownCount: number;
}

export interface MilestonePromptCallbacks {
  onStarConfirmed: () => Promise<void>;
  onWaitlistJoined: (email: string) => Promise<void>;
  onWaitlistDeclined: () => Promise<void>;
  onFeedback: (score: number, featureVote?: string, email?: string) => Promise<void>;
}

export async function renderMilestonePrompt(
  prompt: InteractivePrompt,
  ctx: MilestonePromptCtx,
  callbacks: MilestonePromptCallbacks
): Promise<void> {
  const { rank, prevRank, totalSavedUsd, successfulRunCount, starShownCount } = ctx;
  const { onStarConfirmed, onWaitlistJoined, onWaitlistDeclined, onFeedback } = callbacks;
  if (!prompt || !process.stdout.isTTY || !process.stdin.isTTY) return;

  if (prompt.kind === "loop_milestone") {
    process.stdout.write(renderLoopMilestoneBox(prompt.count, rank, prevRank));
    return;
  }

  if (prompt.kind === "star") {
    if (prompt.hard) {
      // Hard ask — run 10+. Direct, no fluff. martin is free and staying that way.
      process.stdout.write(
        `\n${successfulRunCount} governed loops. martin is free and always will be.\n` +
        "a star is the only ask we make — it takes 3 seconds and keeps this moving:\n" +
        "   github.com/Keesan12/martin-loop\n" +
        "[s] open  ·  [enter] skip\n"
      );
    } else if (starShownCount === 0) {
      // Soft first ask — run 2+
      process.stdout.write(
        "\nmartin is free. it stays that way because people star it.\n" +
        "if it saved you time today, 3 seconds here helps more people find it:\n" +
        "   github.com/Keesan12/martin-loop\n" +
        "[s] open  ·  [enter] skip\n"
      );
    } else {
      // Soft second ask — still not hard threshold, but shown once already
      process.stdout.write(
        `\n$${totalSavedUsd.toFixed(2)} saved. ${successfulRunCount} loops. still free.\n` +
        "the star's there if you want to make it official — last time we'll ask:\n" +
        "   github.com/Keesan12/martin-loop\n" +
        "[s] open  ·  [enter] skip\n"
      );
    }
    const key = await readSingleKey();
    if (key === "s" || key === "S") {
      await openUrl("https://github.com/Keesan12/martin-loop");
      await onStarConfirmed();
      process.stdout.write("appreciated. keeps the open-core moving.\n");
    }
    return;
  }

  if (prompt.kind === "feedback") {
    process.stdout.write(
      "\nquick one — [enter] to skip entirely.\n" +
      "0–5: is martin actually earning its keep?  "
    );
    const reader = createLineReader();
    try {
      const line = await reader.read();
      const trimmed = line.trim();
      if (!trimmed) return;
      const score = parseInt(trimmed, 10);
      if (isNaN(score) || score < 0 || score > 5) return;

      let featureVote: string | undefined;
      let email: string | undefined;

      if (score >= 4) {
        process.stdout.write("what should we build next? (one feature, or [enter] to skip)  ");
        const vote = await reader.read();
        if (vote.trim()) featureVote = vote.trim();
        process.stdout.write(
          "want pilot access? early features, direct line to the founding team,\n" +
          "releases before public — email to join: _  ([enter] to skip)  "
        );
        const em = await reader.read();
        if (em.trim()) email = em.trim();
      } else if (score <= 2) {
        process.stdout.write("what's not working? one sentence is plenty.  ");
        const note = await reader.read();
        if (note.trim()) featureVote = note.trim();
      }

      await onFeedback(score, featureVote, email);
    } finally {
      reader.close();
    }
    return;
  }

  if (prompt.kind === "waitlist") {
    const savingsLine = totalSavedUsd >= 50 ? ` and saved $${Math.floor(totalSavedUsd)}+` : "";
    process.stdout.write(
      `\nyou've governed ${successfulRunCount} loops${savingsLine}. that's a workflow, not a trial.\n\n` +
      "we're onboarding pilot partners now — what you get:\n" +
      "  · new features before public release\n" +
      "  · direct access to the founding team\n" +
      "  · input on what gets built next\n" +
      "  · early pricing before it changes\n\n" +
      "what we ask: real feedback and one conversation.\n\n" +
      "email to join the pilot: _  ([enter] to skip)\n"
    );
    const waitlistReader = createLineReader();
    const line = await waitlistReader.read();
    waitlistReader.close();
    if (line.trim()) {
      await onWaitlistJoined(line.trim());
    } else {
      await onWaitlistDeclined();
    }
  }
}

export function renderLoopCard(state: MilestoneState | null): void {
  if (!state) {
    process.stdout.write("no runs recorded yet. run martin-loop to get started.\n");
    return;
  }

  const W = 63;
  const border = "─".repeat(W - 2);
  const pad = (s: string): string => `│ ${s.padEnd(W - 3)}│`;
  const blank = pad("");

  const titleLeft = "∞  M A R T I N L O O P";
  const titleRight = state.currentRank;
  const titlePad = W - 3 - titleLeft.length - titleRight.length;
  const titleLine = titlePad >= 0
    ? `│ ${titleLeft}${" ".repeat(titlePad)}${titleRight} │`
    : pad(titleLeft);

  const lines: string[] = [`┌${border}┐`, blank, titleLine, pad(`   ${border.slice(0, W - 6)}`), blank];

  // Stats row 1
  const streakStr = state.dailyStreakDays >= 3 ? `🔥 ${state.dailyStreakDays}-day streak` : "";
  const repoStr = `${state.reposUsed.length} repo${state.reposUsed.length === 1 ? "" : "s"}`;
  const row1 = `${String(state.successfulRunCount)} loops`.padEnd(22) +
    streakStr.padEnd(22) + repoStr;
  if (streakStr) lines.push(pad(`   ${row1}`));
  else lines.push(pad(`   ${String(state.successfulRunCount)} loops`.padEnd(22) + repoStr));

  // Stats row 2
  if (state.savingsConfidence !== "unavailable") {
    const savedStr = `$${state.totalSavedUsd.toFixed(2)} saved`;
    const rollStr = state.rollbacksTriggered > 0 ? `${state.rollbacksTriggered} rollbacks` : "";
    const blkStr = state.verifierBlocks > 0 ? `${state.verifierBlocks} blk` : "";
    const row2 = savedStr.padEnd(22) + rollStr.padEnd(22) + blkStr;
    lines.push(pad(`   ${row2}`));
  } else {
    lines.push(pad(`   ${state.successfulRunCount} governed runs completed.`));
  }

  lines.push(blank, pad(`   ${border.slice(0, W - 6)}`), blank);

  // Started
  if (state.firstRunAt) {
    const d = new Date(state.firstRunAt);
    const dateStr = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    lines.push(pad(`   started        ${dateStr}`));
  }

  // Best run
  if (state.bestRunSavedUsd !== null && state.savingsConfidence !== "unavailable" && state.bestRunAt) {
    const conf = state.savingsConfidence === "confirmed" ? "confirmed saved" : "estimated saved";
    const d = new Date(state.bestRunAt);
    const dateStr = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    lines.push(pad(`   best run       ${conf} $${state.bestRunSavedUsd.toFixed(2)}  ·  ${dateStr}`));
  }

  lines.push(pad(`   current rank   ${state.currentRank}`));

  // Next rank
  const next = nextRank(state.currentRank);
  if (next) {
    lines.push(pad(`   next rank      ${next.name} at ${next.loopsNeeded} loops`));
  }

  lines.push(blank, `└${border}┘`);
  process.stdout.write(lines.join("\n") + "\n");
}
