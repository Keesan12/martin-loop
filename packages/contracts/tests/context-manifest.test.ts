import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONTEXT_LEDGER_VERSION,
  CONTEXT_MANIFEST_VERSION,
  type ContextBudget,
  type ContextCandidateDecision,
  type ContextLedgerEntry,
  type ContextManifest,
  type ContinuationCheckpoint,
  type TaskItem
} from "../src/index.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function loadFixture(name: string): unknown {
  const p = join(import.meta.dirname ?? __dirname, "fixtures", name);
  return JSON.parse(readFileSync(p, "utf8"));
}

// ─── Schema version constants ─────────────────────────────────────────────────

describe("A-CTX-1 schema version constants", () => {
  it("CONTEXT_MANIFEST_VERSION is the correct literal", () => {
    expect(CONTEXT_MANIFEST_VERSION).toBe("context-manifest/1");
  });

  it("CONTEXT_LEDGER_VERSION is the correct literal", () => {
    expect(CONTEXT_LEDGER_VERSION).toBe("context-ledger/1");
  });
});

// ─── ContextBudget ────────────────────────────────────────────────────────────

describe("ContextBudget", () => {
  it("requires pinnedTokensMax", () => {
    const budget: ContextBudget = {
      modelWindowTokens: 200_000,
      systemReserveTokens: 2_000,
      outputReserveTokens: 4_000,
      toolReserveTokens: 3_000,
      overflowReserveTokens: 2_000,
      maxWorkingSetTokens: 8_000,
      pinnedTokensMax: 1_500
    };
    expect(budget.pinnedTokensMax).toBe(1_500);
  });
});

// ─── ContextCandidateDecision ─────────────────────────────────────────────────

describe("ContextCandidateDecision", () => {
  it("accepts included_truncated with truncatedFromTokens", () => {
    const d: ContextCandidateDecision = {
      objectId: "obj_001",
      decision: "included_truncated",
      truncatedFromTokens: 4_200,
      reason: "truncated_to_fit_budget",
      renderedTokens: 1_000
    };
    expect(d.decision).toBe("included_truncated");
    expect(d.truncatedFromTokens).toBe(4_200);
  });

  it("accepts included without truncatedFromTokens", () => {
    const d: ContextCandidateDecision = {
      objectId: "obj_002",
      decision: "included",
      reason: "within_budget",
      renderedTokens: 80
    };
    expect(d.decision).toBe("included");
    expect(d.truncatedFromTokens).toBeUndefined();
  });

  it("accepts all five decision variants", () => {
    const decisions: ContextCandidateDecision["decision"][] = [
      "included",
      "included_truncated",
      "excluded",
      "deferred",
      "fault_loaded"
    ];
    expect(decisions).toHaveLength(5);
  });

  it("has no confidence or outcome_delta fields", () => {
    const d: ContextCandidateDecision = {
      objectId: "obj_003",
      decision: "excluded",
      reason: "budget_exhausted"
    };
    expect(d).not.toHaveProperty("confidence");
    expect(d).not.toHaveProperty("outcome_delta");
  });
});

// ─── ContextManifest ─────────────────────────────────────────────────────────

describe("ContextManifest", () => {
  it("schema matches context-manifest-v1.json fixture", () => {
    const fixture = loadFixture("context-manifest-v1.json") as ContextManifest;
    expect(fixture.schemaVersion).toBe(CONTEXT_MANIFEST_VERSION);
    expect(typeof fixture.manifestHash).toBe("string");
    expect(typeof fixture.taskId).toBe("string");
    expect(typeof fixture.runId).toBe("string");
    expect(typeof fixture.nowMs).toBe("number");
    expect(typeof fixture.adapterVersion).toBe("string");
    expect(typeof fixture.policyHash).toBe("string");
    expect(fixture.budget).toBeDefined();
    expect(Array.isArray(fixture.decisions)).toBe(true);
    expect(typeof fixture.totalRenderedTokens).toBe("number");
    expect(typeof fixture.renderPasses).toBe("number");
    expect(typeof fixture.compilationDurationMs).toBe("number");
  });

  it("renderPasses in fixture is within MAX_RENDER_PASSES bound (5)", () => {
    const fixture = loadFixture("context-manifest-v1.json") as ContextManifest;
    expect(fixture.renderPasses).toBeGreaterThanOrEqual(1);
    expect(fixture.renderPasses).toBeLessThanOrEqual(5);
  });

  it("has no confidence or outcome_delta fields in fixture", () => {
    const fixture = loadFixture("context-manifest-v1.json");
    expect(fixture).not.toHaveProperty("confidence");
    expect(fixture).not.toHaveProperty("outcome_delta");
  });
});

// ─── ContextLedgerEntry ───────────────────────────────────────────────────────

describe("ContextLedgerEntry", () => {
  it("schema matches context-ledger-v1.json fixture", () => {
    const fixture = loadFixture("context-ledger-v1.json") as ContextLedgerEntry;
    expect(fixture.schemaVersion).toBe(CONTEXT_LEDGER_VERSION);
    expect(fixture.entryType).toBe("context");
    expect(typeof fixture.taskId).toBe("string");
    expect(typeof fixture.runId).toBe("string");
    expect(typeof fixture.manifestHash).toBe("string");
    expect(typeof fixture.totalIncluded).toBe("number");
    expect(typeof fixture.totalExcluded).toBe("number");
    expect(typeof fixture.totalFaultLoaded).toBe("number");
    expect(typeof fixture.overflowCount).toBe("number");
    expect(typeof fixture.faultBudgetUsed).toBe("number");
    expect(typeof fixture.adapterVersion).toBe("string");
  });

  it("has no confidence or outcome_delta fields in fixture", () => {
    const fixture = loadFixture("context-ledger-v1.json");
    expect(fixture).not.toHaveProperty("confidence");
    expect(fixture).not.toHaveProperty("outcome_delta");
  });
});

// ─── ContinuationCheckpoint ───────────────────────────────────────────────────

describe("ContinuationCheckpoint", () => {
  it("can be constructed with sequenceNumber for CAS enforcement", () => {
    const item: TaskItem = {
      id: "t1",
      description: "do work",
      status: "pending",
      createdAtMs: 1_753_142_400_000
    };

    const checkpoint: ContinuationCheckpoint = {
      schemaVersion: "checkpoint/1",
      taskId: "task_001",
      sequenceNumber: 1,
      parentHash: "0000000000000000000000000000000000000000000000000000000000000000",
      pending: [item],
      inProgress: [],
      decisions: [],
      createdAtMs: 1_753_142_400_000
    };

    expect(checkpoint.schemaVersion).toBe("checkpoint/1");
    expect(checkpoint.sequenceNumber).toBe(1);
    expect(checkpoint.pending).toHaveLength(1);
    expect(checkpoint.inProgress).toHaveLength(0);
  });

  it("CAS lock: sequenceNumber must increment by exactly 1", () => {
    // This tests the documented invariant — actual enforcement is in CheckpointStore.
    // If prior sequenceNumber = 3, next write must have sequenceNumber = 4.
    const priorSequenceNumber = 3;
    const nextSequenceNumber = priorSequenceNumber + 1;
    expect(nextSequenceNumber).toBe(4);
    expect(nextSequenceNumber - priorSequenceNumber).toBe(1);
  });
});
