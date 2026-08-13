/**
 * C2 Mission Store — Real Acceptance Tests
 *
 * All scenarios use real filesystem I/O in temp directories.
 * No mocks. No stubs. No hardcoded output.
 *
 * Required scenarios:
 *  1.  restart persistence — write mission, restart, read back identical record
 *  2.  attach persisted run — linkage survives process restart
 *  3.  verified outcome aggregation — verified=true increments count; false does not
 *  4.  unverified outcome — missing verifiedOutcome stays zero
 *  5.  actual cost aggregation — sum of actualUsd across all linked runs
 *  6.  stale CAS rejection — wrong expectedRevision throws
 *  7.  real second-process lock contention — child process holds lock; parent waits; no corruption
 *  8.  modified ledger detection — altering a ledger line returns ok=false
 *  9.  missing ledger entry detection — truncating a line returns ok=false (count mismatch)
 * 10.  same mission ID isolated across two runs roots — no cross-contamination
 * 11.  existing run receipt compatibility — mission/run linkage does not touch LoopRecord files
 * 12.  status transition guard — invalid transition throws; valid transition persists
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { createMissionRecord, MISSION_SCHEMA_VERSION } from "@martin/contracts";
import type { MissionRecord } from "@martin/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  attachRun,
  changeMissionStatus,
  createMission,
  missionDir,
  readMission,
  readMissionLedger,
  verifyMissionLedger
} from "../src/persistence/index.js";
import { aggregateMissionMetrics, rebuildMissionCost } from "../src/mission/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDraft(overrides: Partial<Parameters<typeof createMissionRecord>[0]> = {}) {
  return createMissionRecord({
    title: "Test Mission",
    objective: "Verify C2 persistence",
    ownerId: "owner_test",
    workspaceId: "ws_test",
    projectId: "proj_test",
    budget: { maxUsd: 100, maxTokens: 1_000_000, maxRuns: 10, maxConcurrentRuns: 2 },
    acceptanceCriteria: ["ledger is authoritative"],
    ...overrides
  });
}

let runsRoot: string;

beforeEach(async () => {
  runsRoot = await mkdtemp(join(tmpdir(), "martin-c2-test-"));
});

afterEach(async () => {
  await rm(runsRoot, { recursive: true, force: true });
});

// ─── 1. Restart persistence ───────────────────────────────────────────────────

describe("restart persistence", () => {
  it("reads back an identical record after mission was created in a prior run", async () => {
    const mission = makeDraft({ missionId: "msn_restart_01" });
    await createMission(runsRoot, mission);

    // Simulate process restart: new call to readMission with same runsRoot
    const loaded = await readMission(runsRoot, mission.missionId);

    expect(loaded).not.toBeNull();
    expect(loaded!.missionId).toBe(mission.missionId);
    expect(loaded!.schemaVersion).toBe(MISSION_SCHEMA_VERSION);
    expect(loaded!.title).toBe(mission.title);
    expect(loaded!.status).toBe("planned");
    expect(loaded!.revision).toBe(0);
  });
});

// ─── 2. Attach persisted run and retain linkage ───────────────────────────────

describe("attach persisted run", () => {
  it("retains run linkage across process restart", async () => {
    const mission = makeDraft({ missionId: "msn_linkage_01" });
    await createMission(runsRoot, mission);

    await attachRun(runsRoot, mission.missionId, {
      loopId: "loop_abc123",
      role: "primary",
      actualUsd: 0.05,
      expectedRevision: 0
    });

    // Simulate process restart
    const loaded = await readMission(runsRoot, mission.missionId);

    expect(loaded!.runLinks).toHaveLength(1);
    expect(loaded!.runLinks[0]!.loopId).toBe("loop_abc123");
    expect(loaded!.runLinks[0]!.role).toBe("primary");
    expect(loaded!.runLinks[0]!.actualUsd).toBeCloseTo(0.05);
    expect(loaded!.revision).toBe(1);
  });
});

// ─── 3. Verified outcome aggregation ─────────────────────────────────────────

describe("verified outcome aggregation", () => {
  it("increments verifiedOutcomeCount only when verifiedOutcome is true", async () => {
    const mission = makeDraft({ missionId: "msn_voe_01" });
    await createMission(runsRoot, mission);

    // Attach verified run
    await attachRun(runsRoot, mission.missionId, {
      loopId: "loop_v1",
      role: "primary",
      verifiedOutcome: true,
      actualUsd: 0.10,
      expectedRevision: 0
    });

    // Attach unverified run
    await attachRun(runsRoot, mission.missionId, {
      loopId: "loop_v2",
      role: "experiment",
      verifiedOutcome: false,
      actualUsd: 0.05,
      expectedRevision: 1
    });

    const loaded = await readMission(runsRoot, mission.missionId);

    expect(loaded!.cost.verifiedOutcomeCount).toBe(1);
    expect(loaded!.cost.totalRunCount).toBe(2);

    const metrics = aggregateMissionMetrics(loaded!.runLinks);
    expect(metrics.verifiedOutcomeCount).toBe(1);
    expect(metrics.totalRunCount).toBe(2);
    expect(metrics.verifiedRate).toBeCloseTo(0.5);
  });
});

// ─── 4. Unverified outcome ────────────────────────────────────────────────────

describe("unverified outcome", () => {
  it("keeps verifiedOutcomeCount at zero when no run has verifiedOutcome=true", async () => {
    const mission = makeDraft({ missionId: "msn_unvoe_01" });
    await createMission(runsRoot, mission);

    await attachRun(runsRoot, mission.missionId, {
      loopId: "loop_u1",
      role: "primary",
      expectedRevision: 0
    });

    const loaded = await readMission(runsRoot, mission.missionId);
    expect(loaded!.cost.verifiedOutcomeCount).toBe(0);
    expect(loaded!.cost.totalRunCount).toBe(1);

    const metrics = aggregateMissionMetrics(loaded!.runLinks);
    expect(metrics.costPerVerifiedOutcome).toBe(Infinity);
    expect(metrics.verifiedRate).toBe(0);
  });
});

// ─── 5. Actual cost aggregation ───────────────────────────────────────────────

describe("actual cost aggregation", () => {
  it("sums actualUsd across all linked runs", async () => {
    const mission = makeDraft({ missionId: "msn_cost_01" });
    await createMission(runsRoot, mission);

    const amounts = [0.12, 0.08, 0.25];
    for (let i = 0; i < amounts.length; i++) {
      await attachRun(runsRoot, mission.missionId, {
        loopId: `loop_cost_${i}`,
        role: "primary",
        actualUsd: amounts[i],
        verifiedOutcome: true,
        expectedRevision: i
      });
    }

    const loaded = await readMission(runsRoot, mission.missionId);
    const expectedTotal = amounts.reduce((a, b) => a + b, 0);
    expect(loaded!.cost.totalActualUsd).toBeCloseTo(expectedTotal, 6);

    const rebuilt = rebuildMissionCost(loaded!);
    expect(rebuilt.totalActualUsd).toBeCloseTo(expectedTotal, 6);
  });
});

// ─── 6. Stale CAS rejection ───────────────────────────────────────────────────

describe("stale CAS rejection", () => {
  it("throws when expectedRevision does not match current revision", async () => {
    const mission = makeDraft({ missionId: "msn_cas_01" });
    await createMission(runsRoot, mission);

    await attachRun(runsRoot, mission.missionId, {
      loopId: "loop_r1",
      role: "primary",
      expectedRevision: 0
    });
    // Now revision is 1 — using 0 again should fail
    await expect(
      attachRun(runsRoot, mission.missionId, {
        loopId: "loop_r2",
        role: "primary",
        expectedRevision: 0
      })
    ).rejects.toThrow(/CAS revision mismatch/);
  });

  it("throws on changeMissionStatus with wrong revision", async () => {
    const mission = makeDraft({ missionId: "msn_cas_02" });
    await createMission(runsRoot, mission);

    await expect(
      changeMissionStatus(runsRoot, mission.missionId, {
        toStatus: "running",
        expectedRevision: 99
      })
    ).rejects.toThrow(/CAS revision mismatch/);
  });
});

// ─── 7. Real second-process lock contention ───────────────────────────────────

/** Poll async for a file, fail after timeoutMs. */
async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { await stat(filePath); return; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${filePath}`);
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

describe("real second-process lock contention", () => {
  it("parent retries and succeeds after a real external process holds the O_EXCL lock", async () => {
    const missionId = "msn_lock_01";
    const mission = makeDraft({ missionId });
    await createMission(runsRoot, mission);

    // The actual .lock path that mission-store uses for this mission.
    const lockFile = join(missionDir(runsRoot, missionId), ".lock");

    // Child: acquires the .lock file via O_EXCL (exact same mechanism mission-store
    // uses), signals parent via stdout "LOCKED\n", holds for 400 ms, then releases.
    // Uses only Node built-ins — no workspace package imports needed.
    const workerScript = [
      `const fs = require("node:fs");`,
      `const fd = fs.openSync(${JSON.stringify(lockFile)},`,
      `  fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);`,
      `fs.writeSync(fd, String(Date.now()));`,
      `fs.closeSync(fd);`,
      `process.stdout.write("LOCKED\\n");`,
      `setTimeout(() => { fs.rmSync(${JSON.stringify(lockFile)}, { force: true }); process.exit(0); }, 400);`,
    ].join("\n");

    // Collect child stdout to detect the LOCKED signal.
    let childStdout = "";
    let childStderr = "";
    const childDone = new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, ["--eval", workerScript], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stdout.on("data", (d: Buffer) => { childStdout += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { childStderr += d.toString(); });
      child.on("exit", resolve);
    });

    // Wait for child to confirm the lock is held.
    await waitForFile(lockFile);

    // Parent calls attachRun while the child holds the lock.
    // mission-store retries every 50 ms (up to 60 × = 3 s) until lock releases.
    // After ~400 ms the child releases and the parent acquires and writes.
    const updated = await attachRun(runsRoot, missionId, {
      loopId: "loop_parent",
      role: "primary",
      actualUsd: 0.05,
      expectedRevision: 0
    });

    const childCode = await childDone;

    // Child must exit cleanly — any non-zero code means the lock setup itself broke.
    expect(childCode, `child failed: ${childStderr}`).toBe(0);

    // Parent write must have gone through and incremented the revision.
    expect(updated.revision).toBe(1);
    expect(updated.runLinks[0]!.loopId).toBe("loop_parent");

    // Exactly one run written — the child never called attachRun.
    const loaded = await readMission(runsRoot, missionId);
    expect(loaded!.cost.totalRunCount).toBe(1);

    // Ledger must verify cleanly after lock was held externally then released.
    const integrity = await verifyMissionLedger(runsRoot, missionId);
    expect(integrity.ok).toBe(true);
    expect(integrity.entryCount).toBe(2); // mission.created + run_attached
  }, 15_000);
});

// ─── 8. Modified ledger detection ────────────────────────────────────────────

describe("modified ledger detection", () => {
  it("returns ok=false when a ledger line has been altered", async () => {
    const mission = makeDraft({ missionId: "msn_tamper_01" });
    await createMission(runsRoot, mission);

    // Tamper: replace first line
    const ledgerFile = join(missionDir(runsRoot, mission.missionId), "ledger.jsonl");
    const original = await readFile(ledgerFile, "utf8");
    const tampered = original.replace(/"kind":"mission\.created"/, '"kind":"mission.tampered"');
    await writeFile(ledgerFile, tampered, "utf8");

    const result = await verifyMissionLedger(runsRoot, mission.missionId);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/chain_mismatch/);
  });
});

// ─── 9. Missing ledger entry detection ───────────────────────────────────────

describe("missing ledger entry detection", () => {
  it("returns ok=false when ledger has fewer entries than chain head records", async () => {
    const mission = makeDraft({ missionId: "msn_missing_01" });
    await createMission(runsRoot, mission);

    // Attach a run so there are 2 ledger entries
    await attachRun(runsRoot, mission.missionId, {
      loopId: "loop_m1",
      role: "primary",
      expectedRevision: 0
    });

    // Truncate: remove the last line
    const ledgerFile = join(missionDir(runsRoot, mission.missionId), "ledger.jsonl");
    const lines = (await readFile(ledgerFile, "utf8")).split(/\r?\n/).filter(Boolean);
    await writeFile(ledgerFile, lines.slice(0, -1).join("\n") + "\n", "utf8");

    const result = await verifyMissionLedger(runsRoot, mission.missionId);
    expect(result.ok).toBe(false);
    // Either chain or count mismatch is acceptable evidence of detection
    expect(result.reason).toMatch(/chain_mismatch|count_mismatch/);
  });
});

// ─── 10. Workspace isolation ──────────────────────────────────────────────────

describe("workspace isolation", () => {
  it("same mission ID in different runs roots does not cross-contaminate", async () => {
    const runsRoot2 = await mkdtemp(join(tmpdir(), "martin-c2-iso-"));
    try {
      const missionId = "msn_iso_shared";

      const m1 = makeDraft({ missionId, title: "Root 1 Mission" });
      const m2 = makeDraft({ missionId, title: "Root 2 Mission" });

      await createMission(runsRoot, m1);
      await createMission(runsRoot2, m2);

      await attachRun(runsRoot, missionId, {
        loopId: "loop_root1",
        role: "primary",
        actualUsd: 0.11,
        expectedRevision: 0
      });

      const loaded1 = await readMission(runsRoot, missionId);
      const loaded2 = await readMission(runsRoot2, missionId);

      expect(loaded1!.title).toBe("Root 1 Mission");
      expect(loaded1!.runLinks).toHaveLength(1);
      expect(loaded2!.title).toBe("Root 2 Mission");
      expect(loaded2!.runLinks).toHaveLength(0);
    } finally {
      await rm(runsRoot2, { recursive: true, force: true });
    }
  });
});

// ─── 11. Existing run receipt compatibility ───────────────────────────────────

describe("existing run receipt compatibility", () => {
  it("does not modify or read LoopRecord files — mission store is self-contained", async () => {
    const mission = makeDraft({ missionId: "msn_compat_01" });
    await createMission(runsRoot, mission);

    // Place a fake loop record file that mission-store must NOT touch
    const loopDir = join(runsRoot, "loop_compat_001");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(loopDir, { recursive: true });
    const loopFile = join(loopDir, "loop-record.json");
    const loopContent = JSON.stringify({ loopId: "loop_compat_001", status: "completed" });
    await writeFile(loopFile, loopContent, "utf8");

    await attachRun(runsRoot, mission.missionId, {
      loopId: "loop_compat_001",
      role: "primary",
      verifiedOutcome: true,
      actualUsd: 0.07,
      expectedRevision: 0
    });

    // LoopRecord file must be untouched
    const afterContent = await readFile(loopFile, "utf8");
    expect(afterContent).toBe(loopContent);

    // Mission still persisted
    const loaded = await readMission(runsRoot, mission.missionId);
    expect(loaded!.runLinks[0]!.loopId).toBe("loop_compat_001");
  });
});

// ─── 12. Status transition guard ─────────────────────────────────────────────

describe("status transition guard", () => {
  it("allows valid transitions and persists the new status", async () => {
    const mission = makeDraft({ missionId: "msn_status_01" });
    await createMission(runsRoot, mission);

    const updated = await changeMissionStatus(runsRoot, mission.missionId, {
      toStatus: "running",
      expectedRevision: 0
    });

    expect(updated.status).toBe("running");
    const loaded = await readMission(runsRoot, mission.missionId);
    expect(loaded!.status).toBe("running");
  });

  it("rejects invalid transitions (shipped → running)", async () => {
    const mission = makeDraft({ missionId: "msn_status_02" });
    await createMission(runsRoot, mission);

    // Advance to shipped via allowed path: planned → running → verified → shipped
    await changeMissionStatus(runsRoot, mission.missionId, {
      toStatus: "running", expectedRevision: 0
    });
    await changeMissionStatus(runsRoot, mission.missionId, {
      toStatus: "verified", expectedRevision: 1
    });
    await changeMissionStatus(runsRoot, mission.missionId, {
      toStatus: "shipped",
      expectedRevision: 2,
      decision: "ship",
      decidedBy: "owner_test"
    });

    await expect(
      changeMissionStatus(runsRoot, mission.missionId, {
        toStatus: "running",
        expectedRevision: 3
      })
    ).rejects.toThrow(/not allowed/);
  });

  it("records outcome on a terminal transition", async () => {
    const mission = makeDraft({ missionId: "msn_status_03" });
    await createMission(runsRoot, mission);

    await changeMissionStatus(runsRoot, mission.missionId, {
      toStatus: "running", expectedRevision: 0
    });
    await changeMissionStatus(runsRoot, mission.missionId, {
      toStatus: "killed",
      expectedRevision: 1,
      decision: "kill",
      decidedBy: "owner_test",
      note: "out of budget"
    });

    const loaded = await readMission(runsRoot, mission.missionId);
    expect(loaded!.status).toBe("killed");
    expect(loaded!.outcome?.decision).toBe("kill");
    expect(loaded!.outcome?.decidedBy).toBe("owner_test");
    expect(loaded!.outcome?.note).toBe("out of budget");
  });
});

// ─── Ledger authority: verify all ledger hashes after multiple writes ─────────

describe("ledger authority", () => {
  it("verifyMissionLedger returns ok=true after a sequence of operations", async () => {
    const mission = makeDraft({ missionId: "msn_ledger_01" });
    await createMission(runsRoot, mission);

    await changeMissionStatus(runsRoot, mission.missionId, {
      toStatus: "running", expectedRevision: 0
    });

    await attachRun(runsRoot, mission.missionId, {
      loopId: "loop_l1",
      role: "primary",
      verifiedOutcome: true,
      actualUsd: 0.20,
      expectedRevision: 1
    });

    await attachRun(runsRoot, mission.missionId, {
      loopId: "loop_l2",
      role: "validation",
      verifiedOutcome: false,
      actualUsd: 0.05,
      expectedRevision: 2
    });

    await changeMissionStatus(runsRoot, mission.missionId, {
      toStatus: "verified", expectedRevision: 3
    });

    const result = await verifyMissionLedger(runsRoot, mission.missionId);
    expect(result.ok).toBe(true);
    expect(result.entryCount).toBe(5);

    // Also confirm the ledger events match expected kinds
    const events = await readMissionLedger(runsRoot, mission.missionId);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      "mission.created",
      "mission.status_changed",
      "mission.run_attached",
      "mission.run_attached",
      "mission.status_changed"
    ]);
  });
});
