import { appendFileSync } from "node:fs";
import * as readline from "node:readline";
import { martinFilePath, ensureMartinDir } from "./home-dir.js";
import { readRunStats, writeRunStats } from "./run-stats.js";

const FEEDBACK_FILE       = martinFilePath("feedback.jsonl");
const DESIGN_PARTNER_FILE = martinFilePath("design-partners.jsonl");
const WEB3FORMS_KEY       = process.env["MARTIN_WEB3FORMS_KEY"] ?? "f77cbe5d-3993-4b09-b8df-c6da94523ae6";
const ENDPOINT = "https://api.web3forms.com/submit";

// ─── Trigger logic ────────────────────────────────────────────────────────────

export function shouldShowRating(run: number, lastAt: number): boolean {
  if (run < 10) return false;
  return (run - lastAt) >= 10;
}

export function shouldShowFeatureRequest(run: number, lastAt: number): boolean {
  if (run < 20) return false;
  return (run - lastAt) >= 20;
}

export function shouldShowDesignPartner(run: number, lastAt: number, converted: boolean): boolean {
  if (converted) return false;
  if (run < 10) return false;
  if (lastAt === 0 && run >= 30) return true;
  return lastAt > 0 && (run - lastAt) >= 30;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function maybeShowFeedbackFlow(runCount: number): Promise<void> {
  const stats = readRunStats();
  if (stats.feedbackOptOut) return;

  let askedSomething = false;
  let rating = 0;
  let highEngagement = false;

  if (shouldShowRating(runCount, stats.lastFeedbackAtRun)) {
    rating = await showRatingPrompt(runCount, stats.martinVersion, stats.totalSuccessfulRuns);
    stats.lastFeedbackAtRun = runCount;
    askedSomething = true;
    highEngagement = rating >= 4;
  }

  if (shouldShowFeatureRequest(runCount, stats.lastFeatureRequestAtRun)) {
    await showFeatureRequestPrompt(runCount, stats.martinVersion);
    stats.lastFeatureRequestAtRun = runCount;
    askedSomething = true;
  }

  const triggerDesignPartner =
    (highEngagement && shouldShowDesignPartner(runCount, stats.lastDesignPartnerAskAtRun, stats.designPartnerConverted))
    || shouldShowDesignPartner(runCount, stats.lastDesignPartnerAskAtRun, stats.designPartnerConverted);

  if (triggerDesignPartner) {
    const converted = await showDesignPartnerPrompt(runCount, stats.martinVersion);
    stats.lastDesignPartnerAskAtRun = runCount;
    if (converted) stats.designPartnerConverted = true;
    askedSomething = true;
  }

  if (askedSomething) writeRunStats(stats);
  if (askedSomething) console.log("");
}

// ─── Rating prompt ────────────────────────────────────────────────────────────

async function showRatingPrompt(runCount: number, version: string, totalRuns: number): Promise<number> {
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  30 seconds of feedback — genuinely helps");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
  console.log("  How would you rate MartinLoop so far?");
  console.log("");
  console.log("  1  Not working for me");
  console.log("  2  Has potential but needs work");
  console.log("  3  Solid, does the job");
  console.log("  4  Really useful, part of my workflow");
  console.log("  5  Can't imagine working without it");
  console.log("");
  process.stdout.write("  [1–5 or Enter to skip]\n  > ");

  const ratingInput = await readSingleLine();
  const rating = parseInt(ratingInput.trim(), 10);

  if (!ratingInput.trim() || isNaN(rating) || rating < 1 || rating > 5) {
    console.log("");
    return 0;
  }

  let followUp = "";

  if (rating >= 4) {
    console.log("");
    process.stdout.write("  What's the single most valuable thing MartinLoop does for you?\n  (or Enter to skip)\n  > ");
    followUp = await readSingleLine();
    console.log("");
    console.log("  💚  That's exactly what it's built for. Thank you.");
  } else {
    console.log("");
    process.stdout.write("  What's the biggest thing holding it back for you?\n  (or Enter to skip)\n  > ");
    followUp = await readSingleLine();
    console.log("");
    console.log("  Noted — that feedback goes directly to the team.");
    console.log("  We'll use it. Thank you for being honest.");
  }

  const entry = {
    type: "rating",
    runCount,
    totalRuns,
    rating,
    followUp: followUp.trim(),
    martinVersion: version,
    platform: process.platform,
    ts: new Date().toISOString()
  };

  writeLocal(FEEDBACK_FILE, entry);
  await sendToWeb3Forms({
    subject: `MartinLoop Feedback — ${rating}/5 — Run #${runCount}`,
    rating,
    comment: followUp.trim() || "(no comment)",
    run_count: runCount,
    total_runs: totalRuns,
    martin_version: version,
    platform: process.platform
  });

  return rating;
}

// ─── Feature request prompt ───────────────────────────────────────────────────

async function showFeatureRequestPrompt(runCount: number, version: string): Promise<void> {
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  One question about what comes next");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
  process.stdout.write(
    "  What's one thing MartinLoop doesn't do yet\n" +
    "  that would make you recommend it to your team?\n" +
    "  (or Enter to skip)\n  > "
  );

  const feature = await readSingleLine();
  if (!feature.trim()) return;

  console.log("");
  console.log("  Logged. This goes straight to the roadmap.");

  writeLocal(FEEDBACK_FILE, {
    type: "feature_request",
    runCount,
    feature: feature.trim(),
    martinVersion: version,
    platform: process.platform,
    ts: new Date().toISOString()
  });

  await sendToWeb3Forms({
    subject: `MartinLoop Feature Request — Run #${runCount}`,
    feature_request: feature.trim(),
    run_count: runCount,
    martin_version: version,
    platform: process.platform
  });
}

// ─── Design partner prompt ────────────────────────────────────────────────────

async function showDesignPartnerPrompt(runCount: number, version: string): Promise<boolean> {
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  One more thing — if you're open to it");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
  console.log("  We're building the growth version of MartinLoop —");
  console.log("  a full governance platform with ROI intelligence,");
  console.log("  team dashboards, spend forecasting, and compliance");
  console.log("  audit trails for engineering and finance teams.");
  console.log("");
  console.log("  Design partners get:");
  console.log("  → Beta access before public release");
  console.log("  → Direct input on the roadmap");
  console.log("  → Founder-level support and onboarding");
  console.log("  → Locked pricing before we go paid");
  console.log("");
  process.stdout.write("  Are you open to being a design partner? [Y/n]\n  > ");

  const answer = await readSingleLine();
  const normalized = answer.trim().toLowerCase();

  // [Y/n] — Enter or "y" = yes; anything else = no
  if (normalized !== "" && normalized !== "y") {
    console.log("");
    console.log("  No problem — appreciate you using MartinLoop.");
    return false;
  }

  console.log("");
  process.stdout.write("  First name:\n  > ");
  const firstName = await readSingleLine();

  process.stdout.write("  Last name:\n  > ");
  const lastName = await readSingleLine();

  process.stdout.write("  Work email:\n  > ");
  const email = await readSingleLine();

  // Basic email validation — skip signup if format is invalid
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email.trim())) {
    console.log("");
    console.log("  Invalid email — we weren't able to save your signup.");
    return false;
  }

  process.stdout.write("  Company name:\n  > ");
  const company = await readSingleLine();

  console.log("");
  console.log("  Last one — what would you expect to pay for a");
  console.log("  full governance platform for your engineering team?");
  console.log("");
  console.log("  A  Under $100 / month");
  console.log("  B  $100 – $500 / month");
  console.log("  C  $500 – $2,000 / month");
  console.log("  D  $2,000+ / month");
  console.log("  E  Prefer not to say");
  console.log("");
  process.stdout.write("  [A/B/C/D/E]\n  > ");

  const pricingInput = await readSingleLine();
  const pricingMap: Record<string, string> = {
    a: "Under $100/month",
    b: "$100–$500/month",
    c: "$500–$2,000/month",
    d: "$2,000+/month",
    e: "Prefer not to say"
  };
  const pricing = pricingMap[pricingInput.trim().toLowerCase()] ?? "Not answered";

  console.log("");
  console.log("  ✅  You're in.");
  console.log("");
  console.log(`  We'll reach out to ${firstName.trim()} at ${email.trim()} soon.`);
  console.log("  In the meantime, keep shipping — every governed");
  console.log("  run makes the platform smarter.");
  console.log("");
  console.log("  — Keesan & Gobi, MartinLoop");

  const entry = {
    type: "design_partner",
    runCount,
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    email: email.trim(),
    company: company.trim(),
    pricingExpectation: pricing,
    martinVersion: version,
    platform: process.platform,
    ts: new Date().toISOString()
  };

  writeLocal(DESIGN_PARTNER_FILE, entry);
  await sendToWeb3Forms({
    subject: `MartinLoop Design Partner — ${firstName.trim()} ${lastName.trim()} @ ${company.trim()}`,
    first_name: firstName.trim(),
    last_name: lastName.trim(),
    email: email.trim(),
    company: company.trim(),
    pricing_expectation: pricing,
    run_count: runCount,
    martin_version: version,
    platform: process.platform
  });

  return true;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function writeLocal(file: string, entry: object): void {
  ensureMartinDir();
  appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
}

async function sendToWeb3Forms(data: Record<string, unknown>): Promise<void> {
  if (WEB3FORMS_KEY.trim().length === 0) return; // Opt-out: set MARTIN_WEB3FORMS_KEY="" to disable
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_key: WEB3FORMS_KEY, from_name: "MartinLoop CLI", ...data }),
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // Silent fail — data already written locally
  }
}

function readSingleLine(): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { resolve(""); return; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    const timeout = setTimeout(() => { rl.close(); resolve(""); }, 30_000);
    rl.once("line", (line) => { clearTimeout(timeout); rl.close(); resolve(line); });
    rl.once("close", () => { clearTimeout(timeout); resolve(""); });
  });
}
