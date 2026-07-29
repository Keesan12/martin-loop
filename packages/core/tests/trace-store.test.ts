// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Trace Intelligence Store — real tests.
 *
 * Validates the append-only trace store that aggregates run data over time.
 * Tests use real filesystem operations with temp directories.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  appendTraceEntry,
  readTraceEntries,
  aggregateTraces,
  getHistoricalDirectSuccessRate,
  type TraceEntry
} from "../src/persistence/trace-store.js";

function makeEntry(overrides: Partial<TraceEntry> = {}): TraceEntry {
  return {
    timestamp: new Date().toISOString(),
    loopId: `loop_${Math.random().toString(36).slice(2, 10)}`,
    objective: "Fix the auth bug",
    engine: "claude",
    selectedRoute: "direct",
    routeConfidence: 0.9,
    budgetUsd: 5,
    actualCostUsd: 1.5,
    preWorkBurnPct: 12,
    attempts: 1,
    status: "completed",
    lifecycleState: "verification_passed",
    verificationPassed: true,
    filesChanged: 3,
    workspaceHash: "abc123",
    ...overrides
  };
}

let tempDir: string;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("appendTraceEntry", () => {
  it("creates the trace file and appends an entry", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "trace-test-"));
    const entry = makeEntry();

    await appendTraceEntry(tempDir, entry);

    const raw = await readFile(join(tempDir, "_martin", "trace-log.jsonl"), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).loopId).toBe(entry.loopId);
  });

  it("appends multiple entries without overwriting", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "trace-test-"));

    await appendTraceEntry(tempDir, makeEntry({ loopId: "loop_first" }));
    await appendTraceEntry(tempDir, makeEntry({ loopId: "loop_second" }));
    await appendTraceEntry(tempDir, makeEntry({ loopId: "loop_third" }));

    const raw = await readFile(join(tempDir, "_martin", "trace-log.jsonl"), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).loopId).toBe("loop_first");
    expect(JSON.parse(lines[1]!).loopId).toBe("loop_second");
    expect(JSON.parse(lines[2]!).loopId).toBe("loop_third");
  });
});

describe("readTraceEntries", () => {
  it("returns empty array when no trace file exists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "trace-test-"));
    const entries = await readTraceEntries(tempDir);
    expect(entries).toEqual([]);
  });

  it("reads all appended entries", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "trace-test-"));
    await appendTraceEntry(tempDir, makeEntry({ actualCostUsd: 1.00 }));
    await appendTraceEntry(tempDir, makeEntry({ actualCostUsd: 2.50 }));

    const entries = await readTraceEntries(tempDir);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.actualCostUsd).toBe(1.00);
    expect(entries[1]!.actualCostUsd).toBe(2.50);
  });
});

describe("aggregateTraces", () => {
  it("returns zero aggregation for empty entries", () => {
    const agg = aggregateTraces([]);
    expect(agg.totalRuns).toBe(0);
    expect(agg.directSuccessRate).toBe(0);
    expect(agg.totalSpendUsd).toBe(0);
  });

  it("calculates correct success rates by route", () => {
    const entries: TraceEntry[] = [
      makeEntry({ selectedRoute: "direct", status: "completed", verificationPassed: true }),
      makeEntry({ selectedRoute: "direct", status: "completed", verificationPassed: true }),
      makeEntry({ selectedRoute: "direct", status: "failed", verificationPassed: false }),
      makeEntry({ selectedRoute: "manager", status: "completed", verificationPassed: true }),
      makeEntry({ selectedRoute: "manager", status: "failed", verificationPassed: false })
    ];

    const agg = aggregateTraces(entries);
    expect(agg.totalRuns).toBe(5);
    expect(agg.directRuns).toBe(3);
    expect(agg.managerRuns).toBe(2);
    expect(agg.directSuccessRate).toBeCloseTo(2 / 3);
    expect(agg.managerSuccessRate).toBe(0.5);
  });

  it("tracks total spend and savings", () => {
    const entries: TraceEntry[] = [
      makeEntry({ budgetUsd: 5, actualCostUsd: 1.5 }),
      makeEntry({ budgetUsd: 3, actualCostUsd: 2.0 })
    ];

    const agg = aggregateTraces(entries);
    expect(agg.totalSpendUsd).toBe(3.5);
    expect(agg.totalSavedUsd).toBe(4.5); // 8 budget - 3.5 spend
  });

  it("ranks failure classes by frequency", () => {
    const entries: TraceEntry[] = [
      makeEntry({ failureClass: "verification_failure" }),
      makeEntry({ failureClass: "verification_failure" }),
      makeEntry({ failureClass: "budget_pressure" }),
      makeEntry({ failureClass: "verification_failure" }),
      makeEntry({ failureClass: "scope_violation" })
    ];

    const agg = aggregateTraces(entries);
    expect(agg.topFailureClasses[0]!.failureClass).toBe("verification_failure");
    expect(agg.topFailureClasses[0]!.count).toBe(3);
  });
});

describe("getHistoricalDirectSuccessRate", () => {
  it("returns undefined with fewer than 5 direct runs", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "trace-test-"));
    await appendTraceEntry(tempDir, makeEntry({ selectedRoute: "direct" }));
    await appendTraceEntry(tempDir, makeEntry({ selectedRoute: "direct" }));

    const rate = await getHistoricalDirectSuccessRate(tempDir);
    expect(rate).toBeUndefined();
  });

  it("returns correct rate with sufficient data", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "trace-test-"));
    for (let i = 0; i < 4; i++) {
      await appendTraceEntry(tempDir, makeEntry({
        selectedRoute: "direct",
        status: "completed",
        verificationPassed: true
      }));
    }
    await appendTraceEntry(tempDir, makeEntry({
      selectedRoute: "direct",
      status: "failed",
      verificationPassed: false
    }));

    const rate = await getHistoricalDirectSuccessRate(tempDir);
    expect(rate).toBe(0.8); // 4/5
  });
});
