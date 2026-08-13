/**
 * Live smoke test for the Supabase intake endpoint.
 * Exercises the real submitToIntake() production code path.
 *
 * No email, no PII. consentToContact: false.
 * Uses a unique test marker so the event is identifiable.
 *
 * Usage:
 *   tsx packages/cli/scripts/smoke-intake-live.mts
 */

import { submitToIntake, retryQueuedIntake } from "../src/cli-milestone-state.js";
import { readFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MARKER = `smoke-test-${Date.now()}`;
const DRAFT_PATH = join(homedir(), ".martin", "intake-draft.jsonl");

const PAYLOAD = {
  source: "martin-cli" as const,
  event: "feedback" as const,
  cliVersion: "0.0.0-smoke",
  score: 1,
  featureVote: MARKER,
  consentToContact: false,
  platform: process.platform,
  createdAt: new Date().toISOString(),
};

async function readQueue(): Promise<string[]> {
  const raw = await readFile(DRAFT_PATH, "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean);
}

console.log(`\n=== Live intake smoke test (marker: ${MARKER}) ===\n`);

// ── 1. First submission ──────────────────────────────────────────────────────
console.log("1. Submitting to live endpoint...");
const r1 = await submitToIntake(PAYLOAD);
console.log(`   ok=${r1.ok}  status=${r1.status}${!r1.ok ? `  retryable=${r1.retryable}` : ""}`);
if (r1.ok && r1.submissionId) console.log(`   submissionId=${r1.submissionId}`);

const q1 = await readQueue();
console.log(`   Queue entries after first submit: ${q1.length} (expected 0 on success)`);

// ── 2. Second submission (idempotency) ───────────────────────────────────────
console.log("\n2. Submitting identical payload (idempotency test)...");
const r2 = await submitToIntake(PAYLOAD);
console.log(`   ok=${r2.ok}  status=${r2.status}`);

// ── 3. Verify no queue entry from accepted submissions ───────────────────────
const q2 = await readQueue();
console.log(`\n3. Queue entries after both submits: ${q2.length} (expected 0)`);
const hasMarker = q2.some((l) => l.includes(MARKER));
console.log(`   Queue contains marker: ${hasMarker} (expected false)`);

// ── 4. Retry lifecycle: queue a failure then drain ───────────────────────────
console.log("\n4. Inducing a network failure to test retry lifecycle...");
const origUrl = process.env["MARTIN_INTAKE_URL"];
process.env["MARTIN_INTAKE_URL"] = "http://127.0.0.1:1"; // ECONNREFUSED

const failPayload = {
  ...PAYLOAD,
  featureVote: `${MARKER}-retry`,
  createdAt: new Date(Date.now() + 1).toISOString(),
};
const rf = await submitToIntake(failPayload);
console.log(`   Failure result: ok=${rf.ok}  status=${!rf.ok ? rf.status : "—"}  retryable=${!rf.ok ? rf.retryable : "—"}`);

const qf = await readQueue();
console.log(`   Queue entries after failure: ${qf.length} (expected 1)`);
const qfEntry = qf[0] ? JSON.parse(qf[0]) as Record<string, unknown> : null;
if (qfEntry) {
  console.log(`   Queued fields: ${Object.keys(qfEntry).join(", ")}`);
  console.log(`   PII (email) in queue: ${"email" in qfEntry}`);
}

// Restore real URL and drain
if (origUrl !== undefined) process.env["MARTIN_INTAKE_URL"] = origUrl;
else delete process.env["MARTIN_INTAKE_URL"];

console.log("\n5. Draining retry queue against live endpoint...");
await retryQueuedIntake();

const qAfterDrain = await readQueue();
console.log(`   Queue entries after drain: ${qAfterDrain.length} (expected 0 on success)`);

// ── Results ──────────────────────────────────────────────────────────────────
console.log("\n=== Results ===");
const firstOk = r1.ok;
const idempotencyOk = r2.ok && r2.status === "duplicate";
const noPiiInQueue = qfEntry ? !("email" in qfEntry) : true;
const drainOk = qAfterDrain.length === 0;

console.log(`Live endpoint submission:   ${firstOk ? "PASS" : "FAIL"}`);
console.log(`Idempotency (409/duplicate):${idempotencyOk ? " PASS" : " FAIL — got " + r2.status}`);
console.log(`No PII in queue:            ${noPiiInQueue ? "PASS" : "FAIL"}`);
console.log(`Retry queue drained:        ${drainOk ? "PASS" : "FAIL — " + qAfterDrain.length + " entries remain"}`);

const allPass = firstOk && noPiiInQueue && drainOk;
process.exit(allPass ? 0 : 1);
