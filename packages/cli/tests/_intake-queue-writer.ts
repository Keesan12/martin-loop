/**
 * Child-process helper for the multi-process concurrency test.
 * Spawned by cli-milestone-state-intake.test.ts test 18.
 *
 * Env vars:
 *   HOME / USERPROFILE  — overridden to the test temp directory
 *   MARTIN_INTAKE_URL   — set to a non-routable address so submitToIntake fails
 *                         and the entry is queued via appendFile
 *   INTAKE_UNIQUE_ID    — unique string embedded in createdAt so each spawned
 *                         process produces a distinct queue entry
 */
import { submitToIntake } from "../src/cli-milestone-state.js";

const id = process.env["INTAKE_UNIQUE_ID"] ?? String(Date.now());

await submitToIntake({
  source: "martin-cli",
  event: "feedback",
  cliVersion: "0.0.0-concurrent-test",
  score: 3,
  consentToContact: false,
  platform: process.platform,
  // Embed the unique ID in createdAt so each process produces a distinct dedup key.
  createdAt: `2099-01-01T00:00:${id.slice(0, 2).padStart(2, "0")}.000Z`,
});

process.exit(0);
