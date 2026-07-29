// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

/**
 * MartinLoop Memory Store — real tests.
 *
 * Validates the append-only memory store that aggregates user preferences,
 * consent signals, and behavioral patterns over time without ever overwriting.
 * All tests use real filesystem operations with temp directories.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  appendMemory,
  readMemoryEntries,
  getPreference,
  buildMemorySummary,
  recordPreference,
  recordConsent,
  type MemoryEntry
} from "../src/persistence/memory-store.js";

let tempDir: string;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("appendMemory", () => {
  it("creates memory.jsonl and appends a single entry", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-test-"));
    const entry: MemoryEntry = {
      timestamp: new Date().toISOString(),
      kind: "preference",
      key: "budget.default",
      value: 5,
      source: "explicit",
      confidence: 1.0
    };

    await appendMemory(tempDir, entry);
    const entries = await readMemoryEntries(tempDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.key).toBe("budget.default");
    expect(entries[0]!.value).toBe(5);
  });

  it("appends multiple entries without overwriting — order preserved", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-test-"));

    await appendMemory(tempDir, {
      timestamp: "2026-01-01T00:00:00.000Z",
      kind: "preference",
      key: "model.direct",
      value: "haiku",
      source: "explicit",
      confidence: 1.0
    });
    await appendMemory(tempDir, {
      timestamp: "2026-01-02T00:00:00.000Z",
      kind: "preference",
      key: "model.direct",
      value: "sonnet",
      source: "explicit",
      confidence: 1.0
    });
    await appendMemory(tempDir, {
      timestamp: "2026-01-03T00:00:00.000Z",
      kind: "consent",
      key: "consent.gate.bypass",
      value: { approved: false },
      source: "explicit",
      confidence: 1.0
    });

    const entries = await readMemoryEntries(tempDir);
    expect(entries).toHaveLength(3);
    // Order preserved — first appended is first
    expect(entries[0]!.value).toBe("haiku");
    expect(entries[1]!.value).toBe("sonnet");
    expect(entries[2]!.kind).toBe("consent");
  });
});

describe("readMemoryEntries", () => {
  it("returns empty array when no memory file exists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-test-"));
    const entries = await readMemoryEntries(tempDir);
    expect(entries).toEqual([]);
  });
});

describe("getPreference", () => {
  it("returns undefined when no matching key exists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-test-"));
    const pref = await getPreference(tempDir, "nonexistent.key");
    expect(pref).toBeUndefined();
  });

  it("returns the most recent entry for a key", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-test-"));
    await recordPreference(tempDir, "budget.default", 2);
    await recordPreference(tempDir, "budget.default", 5);
    await recordPreference(tempDir, "budget.default", 10);

    const pref = await getPreference(tempDir, "budget.default");
    expect(pref?.value).toBe(10); // most recent wins
  });

  it("only matches exact key — doesn't match partial keys", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-test-"));
    await recordPreference(tempDir, "budget.default", 5);

    const pref = await getPreference(tempDir, "budget");
    expect(pref).toBeUndefined();
  });
});

describe("buildMemorySummary", () => {
  it("returns zero totals for empty entries", () => {
    const summary = buildMemorySummary([]);
    expect(summary.totalEntries).toBe(0);
    expect(summary.recentPreferences).toEqual([]);
    expect(summary.recentConsents).toEqual([]);
  });

  it("groups entries by kind correctly", () => {
    const entries: MemoryEntry[] = [
      { timestamp: "t1", kind: "preference", key: "k1", value: 1, source: "explicit", confidence: 1 },
      { timestamp: "t2", kind: "preference", key: "k2", value: 2, source: "explicit", confidence: 1 },
      { timestamp: "t3", kind: "consent", key: "k3", value: true, source: "explicit", confidence: 1 },
      { timestamp: "t4", kind: "feedback", key: "k4", value: "good", source: "explicit", confidence: 1 }
    ];

    const summary = buildMemorySummary(entries);
    expect(summary.totalEntries).toBe(4);
    expect(summary.byKind.preference).toHaveLength(2);
    expect(summary.byKind.consent).toHaveLength(1);
    expect(summary.recentPreferences).toHaveLength(2);
    expect(summary.recentConsents).toHaveLength(1);
    expect(summary.recentFeedback).toHaveLength(1);
  });

  it("limits byKind to 20 most recent entries per kind", () => {
    const entries: MemoryEntry[] = Array.from({ length: 30 }, (_, i) => ({
      timestamp: `t${i}`,
      kind: "preference" as const,
      key: `key-${i}`,
      value: i,
      source: "inferred" as const,
      confidence: 0.6
    }));

    const summary = buildMemorySummary(entries);
    expect(summary.byKind.preference?.length).toBe(20); // capped at 20
    // Most recent 20 (indices 10-29) are kept
    expect(summary.byKind.preference?.[0]?.value).toBe(10);
    expect(summary.byKind.preference?.[19]?.value).toBe(29);
  });
});

describe("recordPreference", () => {
  it("stores explicit preference with confidence 1.0", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-test-"));
    await recordPreference(tempDir, "model.auth", "opus", "explicit");

    const pref = await getPreference(tempDir, "model.auth");
    expect(pref?.value).toBe("opus");
    expect(pref?.source).toBe("explicit");
    expect(pref?.confidence).toBe(1.0);
    expect(pref?.kind).toBe("preference");
  });

  it("stores inferred preference with confidence 0.6", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-test-"));
    await recordPreference(tempDir, "pattern.gate.skipped", true, "inferred");

    const pref = await getPreference(tempDir, "pattern.gate.skipped");
    expect(pref?.confidence).toBe(0.6);
    expect(pref?.source).toBe("inferred");
  });
});

describe("recordConsent", () => {
  it("records consent approval with full confidence", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-test-"));
    await recordConsent(tempDir, "auto.model.select", true, { engine: "claude" });

    const entries = await readMemoryEntries(tempDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("consent");
    expect(entries[0]!.key).toBe("consent.auto.model.select");
    expect(entries[0]!.confidence).toBe(1.0);
    const val = entries[0]!.value as { approved: boolean; context: { engine: string } };
    expect(val.approved).toBe(true);
    expect(val.context.engine).toBe("claude");
  });
});
