/**
 * Real integration tests for the intake retry queue.
 * No mocks — real file I/O, real HTTP servers, real network errors.
 *
 * Queue file isolation: tests override HOME / USERPROFILE to a temp directory
 * so that intakeDraftPath() resolves inside the temp dir, not ~/.martin.
 *
 * State file (STATE_PATH) is computed at module load time and cannot be
 * redirected via env — the opt-out test writes to the real state path and
 * restores it on cleanup.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  intakeDeliveryFromResult,
  retryQueuedIntake,
  submitToIntake,
  type IntakePayload,
} from "../src/cli-milestone-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spin up a real HTTP server that responds with a fixed status code. */
function startServer(
  statusCode: number,
  body: object = {}
): Promise<{ url: string; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_, res) => {
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** Override HOME so intakeDraftPath() resolves inside tempDir. */
function setFakeHome(tempDir: string): () => void {
  const origHome = process.env["HOME"];
  const origUserProfile = process.env["USERPROFILE"];
  process.env["HOME"] = tempDir;
  process.env["USERPROFILE"] = tempDir;
  return () => {
    if (origHome !== undefined) process.env["HOME"] = origHome;
    else delete process.env["HOME"];
    if (origUserProfile !== undefined) process.env["USERPROFILE"] = origUserProfile;
    else delete process.env["USERPROFILE"];
  };
}

/** Override MARTIN_INTAKE_URL for a single test. */
function setIntakeUrl(url: string): () => void {
  const orig = process.env["MARTIN_INTAKE_URL"];
  process.env["MARTIN_INTAKE_URL"] = url;
  return () => {
    if (orig !== undefined) process.env["MARTIN_INTAKE_URL"] = orig;
    else delete process.env["MARTIN_INTAKE_URL"];
  };
}

const BASE_PAYLOAD: IntakePayload = {
  source: "martin-cli",
  event: "feedback",
  cliVersion: "0.0.0-test",
  score: 4,
  email: "test@example.com",
  consentToContact: true,
  platform: process.platform,
  createdAt: new Date().toISOString(),
};

// Real state path — computed at module load time inside cli-milestone-state.ts
const REAL_STATE_PATH = join(homedir(), ".martin", "milestone-state.json");

describe("intake delivery outcomes", () => {
  it("records an accepted server response with its submission id", () => {
    expect(intakeDeliveryFromResult({ ok: true, status: "accepted", submissionId: "receipt-123" }))
      .toMatchObject({ status: "accepted", submissionId: "receipt-123" });
  });

  it("records retryable delivery failures as queued without PII", () => {
    expect(intakeDeliveryFromResult({
      ok: false,
      status: "network_error",
      retryable: true,
      message: "offline"
    })).toMatchObject({ status: "queued" });
  });

  it("records permanent delivery failures as rejected", () => {
    expect(intakeDeliveryFromResult({
      ok: false,
      status: "rejected",
      retryable: false,
      message: "invalid payload"
    })).toMatchObject({ status: "rejected" });
  });
});

// ---------------------------------------------------------------------------
// Queue file isolation setup
// ---------------------------------------------------------------------------

let tempHome: string;
let restoreHome: () => void;
let restoreUrl: () => void;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "martin-intake-test-"));
  restoreHome = setFakeHome(tempHome);
  // Default to ECONNREFUSED so network calls fail fast
  restoreUrl = setIntakeUrl("http://127.0.0.1:1");
});

afterEach(async () => {
  restoreUrl();
  restoreHome();
  await rm(tempHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Email never written to disk
// ---------------------------------------------------------------------------

describe("email never written to disk", () => {
  it("does not write the email field into intake-draft.jsonl on network failure", async () => {
    await submitToIntake(BASE_PAYLOAD); // ECONNREFUSED → queued

    const draftPath = join(tempHome, ".martin", "intake-draft.jsonl");
    const raw = await readFile(draftPath, "utf8");

    expect(raw).not.toContain("test@example.com");
    expect(raw).not.toContain("email");
  });
});

// ---------------------------------------------------------------------------
// 2. Directory and file are created on first use
// ---------------------------------------------------------------------------

describe("directory and file created on first use", () => {
  it("creates ~/.martin/intake-draft.jsonl when it does not exist", async () => {
    // tempHome starts empty — no .martin directory
    await submitToIntake(BASE_PAYLOAD);

    const draftPath = join(tempHome, ".martin", "intake-draft.jsonl");
    const raw = await readFile(draftPath, "utf8");
    expect(raw.trim().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Queue capped at 50 entries
// ---------------------------------------------------------------------------

describe("queue capped at 50 entries", () => {
  it("does not exceed 50 entries when more than 50 failures are submitted", async () => {
    // Submit 60 entries — each gets a unique createdAt to avoid deduplication
    for (let i = 0; i < 60; i++) {
      await submitToIntake({
        ...BASE_PAYLOAD,
        createdAt: new Date(Date.now() + i).toISOString(),
      });
    }

    const draftPath = join(tempHome, ".martin", "intake-draft.jsonl");
    const raw = await readFile(draftPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// 4. Entries older than 30 days removed on read
// ---------------------------------------------------------------------------

describe("30-day retention", () => {
  it("drops entries older than 30 days when reading the queue", async () => {
    const draftPath = join(tempHome, ".martin", "intake-draft.jsonl");
    await mkdir(dirname(draftPath), { recursive: true });

    const oldEntry = JSON.stringify({
      source: "martin-cli",
      event: "feedback",
      cliVersion: "0.0.0-test",
      score: 3,
      consentToContact: false,
      platform: process.platform,
      createdAt: "2020-01-01T00:00:00.000Z",
      _failedAt: "2020-01-01T00:00:00.000Z", // 30+ days ago
      _reason: "network_error",
    });
    const freshEntry = JSON.stringify({
      source: "martin-cli",
      event: "feedback",
      cliVersion: "0.0.0-test",
      score: 5,
      consentToContact: false,
      platform: process.platform,
      createdAt: new Date().toISOString(),
      _failedAt: new Date().toISOString(),
      _reason: "network_error",
    });

    await writeFile(draftPath, `${oldEntry}\n${freshEntry}\n`, "utf8");

    // retryQueuedIntake reads the queue (dropping old entries) then attempts retry
    // The retry to 127.0.0.1:1 will fail — but the old entry should be gone from the file
    await retryQueuedIntake();

    const raw = await readFile(draftPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    // Old entry should have been dropped on read; fresh entry re-queued after failure
    expect(lines.length).toBe(1);
    const retained = JSON.parse(lines[0]!) as { score: number };
    expect(retained.score).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 5. Duplicate entries suppressed (same event:cliVersion:createdAt)
// ---------------------------------------------------------------------------

describe("duplicate suppression", () => {
  it("replaces an existing entry rather than appending a second copy", async () => {
    const payload: IntakePayload = {
      ...BASE_PAYLOAD,
      createdAt: "2099-01-01T00:00:00.000Z", // fixed timestamp → same dedup key
    };

    await submitToIntake(payload);
    await submitToIntake(payload); // same createdAt — should replace, not append

    const draftPath = join(tempHome, ".martin", "intake-draft.jsonl");
    const raw = await readFile(draftPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Retryable failure retained in queue
// ---------------------------------------------------------------------------

describe("retryable failure retained", () => {
  it("keeps the entry in the queue after a network error during retryQueuedIntake", async () => {
    // Queue one entry via network failure
    await submitToIntake(BASE_PAYLOAD);

    // Retry also fails (still pointing at :1)
    await retryQueuedIntake();

    const draftPath = join(tempHome, ".martin", "intake-draft.jsonl");
    const raw = await readFile(draftPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Successful retry removes the entry from the queue
// ---------------------------------------------------------------------------

describe("successful retry removes entry from queue", () => {
  it("clears the queue entry after the server responds 200", async () => {
    // Queue one entry via initial network failure
    await submitToIntake(BASE_PAYLOAD);

    const draftPath = join(tempHome, ".martin", "intake-draft.jsonl");
    const before = await readFile(draftPath, "utf8");
    expect(before.split("\n").filter(Boolean).length).toBe(1);

    // Now point at a real server that returns 200
    const server = await startServer(200, { id: "test-sub-id" });
    const restoreForRetry = setIntakeUrl(server.url);
    try {
      await retryQueuedIntake();
    } finally {
      restoreForRetry();
      await server.stop();
    }

    const after = await readFile(draftPath, "utf8").catch(() => "");
    expect(after.split("\n").filter(Boolean).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. 422 not queued
// ---------------------------------------------------------------------------

describe("422 not queued", () => {
  it("does not write to the queue when the server responds 422", async () => {
    const server = await startServer(422);
    const restore = setIntakeUrl(server.url);
    try {
      const result = await submitToIntake(BASE_PAYLOAD);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe("rejected");
    } finally {
      restore();
      await server.stop();
    }

    const draftPath = join(tempHome, ".martin", "intake-draft.jsonl");
    const raw = await readFile(draftPath, "utf8").catch(() => "");
    expect(raw.split("\n").filter(Boolean).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Opt-out clears and disables queue
// ---------------------------------------------------------------------------

describe("opt-out clears and disables queue", () => {
  it("empties the queue and stops queueing when feedback.optedOut is true", async () => {
    // First queue an entry under normal conditions
    await submitToIntake(BASE_PAYLOAD);

    const draftPath = join(tempHome, ".martin", "intake-draft.jsonl");
    const before = await readFile(draftPath, "utf8");
    expect(before.split("\n").filter(Boolean).length).toBe(1);

    // Write a state file with optedOut: true at the REAL state path
    // (STATE_PATH is fixed at module load time — env override does not reach it)
    const existingState = await readFile(REAL_STATE_PATH, "utf8").catch(() => null);
    const optedOutState = {
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
      feedback: { shownCount: 0, scores: [], featureVotes: [], email: null, optedOut: true },
      waitlist: { status: "not_asked", declinedCount: 0, email: null, shownAt: null },
      suppressUntilRun: 0,
    };

    await mkdir(dirname(REAL_STATE_PATH), { recursive: true });
    await writeFile(REAL_STATE_PATH, JSON.stringify(optedOutState), "utf8");

    try {
      await retryQueuedIntake();

      const after = await readFile(draftPath, "utf8").catch(() => "");
      expect(after.split("\n").filter(Boolean).length).toBe(0);

      // Attempting to queue another entry while opted out — should not appear
      await submitToIntake({ ...BASE_PAYLOAD, createdAt: new Date(Date.now() + 999).toISOString() });
      const afterSecond = await readFile(draftPath, "utf8").catch(() => "");
      expect(afterSecond.split("\n").filter(Boolean).length).toBe(0);
    } finally {
      // Restore original state file
      if (existingState !== null) {
        await writeFile(REAL_STATE_PATH, existingState, "utf8");
      } else {
        await rm(REAL_STATE_PATH, { force: true });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Engagement failure never changes governed-run result
// ---------------------------------------------------------------------------

describe("engagement failure does not affect governed-run result", () => {
  it("retryQueuedIntake() resolves even when every submission fails", async () => {
    // Queue multiple entries
    for (let i = 0; i < 3; i++) {
      await submitToIntake({ ...BASE_PAYLOAD, createdAt: new Date(Date.now() + i).toISOString() });
    }

    // retryQueuedIntake must not throw — governed run result is never affected
    await expect(retryQueuedIntake()).resolves.toBeUndefined();
  });

  it("submitToIntake() resolves with a structured result — never throws", async () => {
    const result = await submitToIntake(BASE_PAYLOAD);
    // Never throws — always returns IntakeSubmissionResult
    expect(typeof result.ok).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// 11. 429 is queued (rate-limited — retryable)
// ---------------------------------------------------------------------------

describe("429 rate-limit is retried", () => {
  it("queues the entry when the server responds 429", async () => {
    const server = await startServer(429);
    const restore = setIntakeUrl(server.url);
    try {
      const result = await submitToIntake(BASE_PAYLOAD);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.retryable).toBe(true);
        expect(result.status).toBe("server_error");
      }
    } finally {
      restore();
      await server.stop();
    }

    const draftPath = join(tempHome, ".martin", "intake-draft.jsonl");
    const raw = await readFile(draftPath, "utf8");
    expect(raw.split("\n").filter(Boolean).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 12. 500 is queued (retryable server error)
// ---------------------------------------------------------------------------

describe("500 server error is retried", () => {
  it("queues the entry when the server responds 500", async () => {
    const server = await startServer(500);
    const restore = setIntakeUrl(server.url);
    try {
      await submitToIntake(BASE_PAYLOAD);
    } finally {
      restore();
      await server.stop();
    }

    const draftPath = join(tempHome, ".martin", "intake-draft.jsonl");
    const raw = await readFile(draftPath, "utf8");
    expect(raw.split("\n").filter(Boolean).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 13. 400 is NOT queued (permanent client-side failure)
// ---------------------------------------------------------------------------

describe("400 bad request is not retried", () => {
  it("does not queue the entry and marks retryable false when server responds 400", async () => {
    const server = await startServer(400);
    const restore = setIntakeUrl(server.url);
    let result: Awaited<ReturnType<typeof submitToIntake>> | undefined;
    try {
      result = await submitToIntake(BASE_PAYLOAD);
    } finally {
      restore();
      await server.stop();
    }

    expect(result!.ok).toBe(false);
    if (!result!.ok) expect(result!.retryable).toBe(false);

    const draftPath = join(tempHome, ".martin", "intake-draft.jsonl");
    const raw = await readFile(draftPath, "utf8").catch(() => "");
    expect(raw.split("\n").filter(Boolean).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 14. Timeout queues entry and resolves within ~4s
// ---------------------------------------------------------------------------

describe("timeout (3s abort) queues the entry", () => {
  it("resolves with timeout result and queues entry when server never responds", async () => {
    // Server accepts connections but never sends a response
    const server = await new Promise<{ url: string; stop: () => Promise<void> }>((resolve) => {
      const s = createServer(() => { /* intentionally hang */ });
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address() as { port: number };
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          stop: () => new Promise((r) => s.close(() => r())),
        });
      });
    });
    const restore = setIntakeUrl(server.url);
    const start = Date.now();
    let result: Awaited<ReturnType<typeof submitToIntake>> | undefined;
    try {
      result = await submitToIntake(BASE_PAYLOAD);
    } finally {
      restore();
    }

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5_000); // resolves within 5s despite 3s timeout
    await server.stop();
    expect(result!.ok).toBe(false);
    if (!result!.ok) {
      expect(result!.status).toBe("timeout");
      expect(result!.retryable).toBe(true);
    }

    const draftPath = join(tempHome, ".martin", "intake-draft.jsonl");
    const raw = await readFile(draftPath, "utf8");
    expect(raw.split("\n").filter(Boolean).length).toBe(1);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// 15. Malformed JSONL line is dropped silently; valid entries survive flush
// ---------------------------------------------------------------------------

describe("malformed queue entries do not block flush", () => {
  it("drops a corrupted line and retains valid entries on retryQueuedIntake", async () => {
    const draftPath = join(tempHome, ".martin", "intake-draft.jsonl");
    await mkdir(dirname(draftPath), { recursive: true });

    const valid = (score: number) => JSON.stringify({
      source: "martin-cli",
      event: "feedback",
      cliVersion: "0.0.0-test",
      score,
      consentToContact: false,
      platform: process.platform,
      createdAt: new Date(Date.now() + score).toISOString(),
      _failedAt: new Date().toISOString(),
      _reason: "network_error",
    });

    await writeFile(draftPath, `${valid(3)}\n{{not json at all\n${valid(5)}\n`, "utf8");

    // retryQueuedIntake with failing URL — both valid entries should be retained
    await retryQueuedIntake();

    const raw = await readFile(draftPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    const scores = lines.map((l) => (JSON.parse(l) as { score: number }).score).sort();
    expect(scores).toEqual([3, 5]);
  });
});

// ---------------------------------------------------------------------------
// 16. Legacy queue entries with email field are sanitized on flush
// ---------------------------------------------------------------------------

describe("PII migration — email stripped from legacy entries", () => {
  it("removes email field from queue entries written by older CLI versions", async () => {
    const draftPath = join(tempHome, ".martin", "intake-draft.jsonl");
    await mkdir(dirname(draftPath), { recursive: true });

    // Legacy entry (old CLI version that did not strip email before queueing)
    const legacyEntry = JSON.stringify({
      source: "martin-cli",
      event: "feedback",
      cliVersion: "0.0.0-old",
      score: 4,
      email: "shouldnotbhere@example.com",
      consentToContact: true,
      platform: process.platform,
      createdAt: new Date().toISOString(),
      _failedAt: new Date().toISOString(),
      _reason: "network_error",
    });

    await writeFile(draftPath, `${legacyEntry}\n`, "utf8");

    // retryQueuedIntake sanitizes then retries (fails → re-queues without email)
    await retryQueuedIntake();

    const raw = await readFile(draftPath, "utf8");
    expect(raw).not.toContain("shouldnotbhere@example.com");
    expect(raw).not.toContain('"email"');
  });
});

// ---------------------------------------------------------------------------
// 17. Stale temp file does not corrupt queue
// ---------------------------------------------------------------------------

describe("interrupted atomic write — stale temp file is overwritten", () => {
  it("a leftover .tmp file from a previous crashed process does not corrupt the queue", async () => {
    const draftPath = join(tempHome, ".martin", "intake-draft.jsonl");
    await mkdir(dirname(draftPath), { recursive: true });

    // Plant a stale temp file with garbage content
    const staleTmp = `${draftPath}.99999.tmp`;
    await writeFile(staleTmp, "stale garbage content", "utf8");

    // Normal submission — should write a clean queue file ignoring the stale tmp
    await submitToIntake(BASE_PAYLOAD);

    const raw = await readFile(draftPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]!) as { source: string };
    expect(entry.source).toBe("martin-cli");
  });
});

// ---------------------------------------------------------------------------
// 18. Multi-process concurrent writes — both entries preserved
// ---------------------------------------------------------------------------

describe("multi-process concurrent queue writes", () => {
  it("both entries survive when two processes append to the queue simultaneously", async () => {
    const __dirname = fileURLToPath(new URL(".", import.meta.url));
    // Use node + tsx/esm loader — avoids shell and spaces-in-path issues on Windows.
    // process.execPath is the absolute path to the running node binary.
    const nodeBin = process.execPath;
    // Windows --import requires a file:// URL, not a native path
    const tsxEsmUrl = pathToFileURL(
      resolve(__dirname, "../../../node_modules/tsx/dist/esm/index.cjs")
    ).href;
    const helperPath = resolve(__dirname, "_intake-queue-writer.ts");

    const draftPath = join(tempHome, ".martin", "intake-draft.jsonl");

    /** Spawn one queue-writer process and wait for it to exit. */
    function spawnWriter(id: string): Promise<string> {
      return new Promise((res, rej) => {
        const chunks: Buffer[] = [];
        const child = spawn(
          nodeBin,
          ["--import", tsxEsmUrl, helperPath],
          {
            cwd: join(__dirname, ".."),
            env: {
              ...process.env,
              HOME: tempHome,
              USERPROFILE: tempHome,
              MARTIN_INTAKE_URL: "http://127.0.0.1:1",
              INTAKE_UNIQUE_ID: id,
              // suppress tsx version banner noise
              TSX_TSCONFIG_PATH: join(__dirname, "../tsconfig.json"),
            },
          }
        );
        child.stderr?.on("data", (d: Buffer) => chunks.push(d));
        child.on("error", rej);
        child.on("close", (code) =>
          code === 0
            ? res("")
            : rej(new Error(`writer ${id} exited ${code}: ${Buffer.concat(chunks).toString().slice(0, 300)}`))
        );
      });
    }

    // Launch both writers simultaneously, wait for both to finish
    await Promise.all([spawnWriter("00"), spawnWriter("01")]);

    const raw = await readFile(draftPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);

    // Both entries must be present — lock-serialized writes preserve both
    expect(lines.length).toBe(2);

    // Neither entry may contain an email field
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect("email" in parsed).toBe(false);
    }
  }, 30_000);
});
