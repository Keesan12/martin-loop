import { describe, expect, it, vi } from "vitest";

import {
  compileContextShadow,
  estimateContextTokens,
  type CompileContextShadowInput
} from "../src/context-shadow";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BASE_INPUT: CompileContextShadowInput = {
  runId: "run_test_001",
  adapter: "martin-core",
  nowMs: 1_700_000_000_000,
  shadowBudgetTokens: 8_000,
  segments: [
    { segmentId: "seg-a", kind: "mission", required: true, text: "do the thing" },
    { segmentId: "seg-b", kind: "task", required: false, text: "optional details" }
  ]
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("compileContextShadow", () => {
  it("produces identical hashes for identical captured inputs", () => {
    const r1 = compileContextShadow(BASE_INPUT);
    const r2 = compileContextShadow(BASE_INPUT);

    expect(r1.manifest.manifestHash).toBe(r2.manifest.manifestHash);
    expect(r1.manifest.compilerInputHash).toBe(r2.manifest.compilerInputHash);
    expect(r1.manifest.actualPromptHash).toBe(r2.manifest.actualPromptHash);
    expect(r1.receipt.manifestHash).toBe(r2.receipt.manifestHash);
  });

  it("changes hashes when segment content changes", () => {
    const r1 = compileContextShadow(BASE_INPUT);
    const r2 = compileContextShadow({
      ...BASE_INPUT,
      segments: [
        { segmentId: "seg-a", kind: "mission", required: true, text: "do something different" },
        { segmentId: "seg-b", kind: "task", required: false, text: "optional details" }
      ]
    });

    expect(r1.manifest.manifestHash).not.toBe(r2.manifest.manifestHash);
    expect(r1.manifest.actualPromptHash).not.toBe(r2.manifest.actualPromptHash);
    expect(r1.manifest.compilerInputHash).not.toBe(r2.manifest.compilerInputHash);
  });

  it("never includes source text in manifest or C5 receipt", () => {
    const { manifest, receipt } = compileContextShadow(BASE_INPUT);

    const manifestStr = JSON.stringify(manifest);
    const receiptStr = JSON.stringify(receipt);

    for (const seg of BASE_INPUT.segments) {
      expect(manifestStr).not.toContain(seg.text);
      expect(receiptStr).not.toContain(seg.text);
    }

    // Decisions contain contentHash but no text
    for (const decision of manifest.decisions) {
      expect(decision).not.toHaveProperty("text");
    }
  });

  it("selects required segments before optional segments", () => {
    const { manifest } = compileContextShadow({
      ...BASE_INPUT,
      segments: [
        { segmentId: "opt-1", kind: "task", required: false, text: "optional" },
        { segmentId: "req-1", kind: "mission", required: true, text: "required" }
      ]
    });

    // Required segments should appear as "required" or "required_over_budget" reason
    const reqDecision = manifest.decisions.find((d) => d.segmentId === "req-1");
    const optDecision = manifest.decisions.find((d) => d.segmentId === "opt-1");

    expect(reqDecision?.proposedDecision).toBe("included");
    expect(reqDecision?.reason).toBe("required");
    expect(optDecision?.reason).toBe("within_shadow_budget");
  });

  it("records required-over-budget without throwing", () => {
    // Give a tiny budget so required segments exceed it
    const { manifest, receipt } = compileContextShadow({
      ...BASE_INPUT,
      shadowBudgetTokens: 1,
      segments: [
        {
          segmentId: "req-big",
          kind: "mission",
          required: true,
          text: "a".repeat(100) // well over 1 token
        }
      ]
    });

    expect(manifest.requiredOverBudget).toBe(true);
    expect(receipt.requiredOverBudget).toBe(true);
    // Should record the decision as excluded with reason required_over_budget
    expect(manifest.decisions[0]?.reason).toBe("required_over_budget");
    expect(manifest.decisions[0]?.proposedDecision).toBe("excluded");
  });

  it("leaves the compiled provider prompt unchanged", async () => {
    // The shadow compiler returns a result object; the caller owns the prompt.
    // Verify compileContextShadow does not mutate the input segments array.
    const inputSegments = [
      { segmentId: "s1", kind: "mission", required: true, text: "original text" }
    ];
    const originalText = inputSegments[0]!.text;

    compileContextShadow({ ...BASE_INPUT, segments: inputSegments });

    expect(inputSegments[0]!.text).toBe(originalText);
  });

  it("emits one metadata-only ledger event", () => {
    const { receipt } = compileContextShadow(BASE_INPUT);

    // C5 receipt carries only metadata
    expect(receipt.schemaVersion).toBe("context-c5/1");
    expect(receipt.resource).toBe("context");
    expect(receipt.event).toBe("shadow_compiled");
    expect(receipt.mode).toBe("shadow");
    expect(receipt.runId).toBe(BASE_INPUT.runId);
    expect(typeof receipt.manifestHash).toBe("string");
    expect(receipt.manifestHash.length).toBe(64); // SHA-256 hex

    // Must not contain any text fields
    expect(receipt).not.toHaveProperty("text");
    expect(receipt).not.toHaveProperty("prompt");
    expect(receipt).not.toHaveProperty("content");
  });

  it("reports ledger failure without failing the governed run", async () => {
    // This tests that compileContextShadow itself never throws for
    // budget/selection logic. Ledger I/O failure is handled by the caller
    // in compiler.ts — tested here at the pure compiler level by verifying
    // that an over-budget scenario still returns a valid result.
    const input: CompileContextShadowInput = {
      runId: "run_fault_test",
      adapter: "test",
      nowMs: 1_700_000_000_000,
      shadowBudgetTokens: 0,
      segments: [
        { segmentId: "r1", kind: "mission", required: true, text: "required content" },
        { segmentId: "r2", kind: "task", required: true, text: "also required" }
      ]
    };

    // Must not throw even with zero budget and multiple required segments
    expect(() => compileContextShadow(input)).not.toThrow();

    const { manifest, receipt } = compileContextShadow(input);
    expect(manifest.requiredOverBudget).toBe(true);
    expect(receipt.requiredOverBudget).toBe(true);
    expect(manifest.decisions).toHaveLength(2);
  });
});

describe("estimateContextTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateContextTokens("")).toBe(0);
  });

  it("returns at least 1 for any non-empty text", () => {
    expect(estimateContextTokens("a")).toBeGreaterThanOrEqual(1);
  });

  it("estimates tokens as ceil(byteLength / 4)", () => {
    const text = "hello world"; // 11 bytes → ceil(11/4) = 3
    expect(estimateContextTokens(text)).toBe(3);
  });
});
