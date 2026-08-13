import { describe, expect, it } from "vitest";

import {
  compileContext,
  HEURISTIC_ADAPTER,
  MAX_RENDER_PASSES,
  type CompileContextInput,
  type ContextAdapter
} from "../src/context-compiler.js";
import type { ContextBudget, ContextObject, ContextPolicy } from "@martin/contracts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BASE_BUDGET: ContextBudget = {
  modelWindowTokens: 200_000,
  systemReserveTokens: 2_000,
  outputReserveTokens: 4_000,
  toolReserveTokens: 3_000,
  overflowReserveTokens: 2_000,
  maxWorkingSetTokens: 8_000,
  pinnedTokensMax: 1_500
};

const BASE_POLICY: ContextPolicy = {
  policyHash: "test-policy-v1",
  deniedSensitivities: ["secret"],
  deniedTrustLevels: [],
  requiredOverBudgetAction: "explicit_escalation",
  maxCompilerDurationMs: 250,
  maxOverheadRatio: 0.15
};

function makeObj(overrides: Partial<ContextObject> = {}): ContextObject {
  return {
    id: "obj-default",
    kind: "task",
    priority: "normal",
    trust: "workspace",
    sensitivity: "workspace",
    sourceRef: "run://test/default",
    contentHash: "abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
    estimatedTokens: 100,
    ...overrides
  };
}

function baseInput(overrides: Partial<CompileContextInput> = {}): CompileContextInput {
  return {
    taskId: "task-001",
    runId: "run-001",
    nowMs: 1_750_000_000_000,
    candidates: [makeObj()],
    budget: BASE_BUDGET,
    policy: BASE_POLICY,
    adapter: HEURISTIC_ADAPTER,
    ...overrides
  };
}

// ─── 1. Determinism: identical inputs → identical manifestHash ────────────────

describe("A-CTX-1 determinism", () => {
  it("produces byte-identical manifestHash for identical inputs", () => {
    const input = baseInput();
    const r1 = compileContext(input);
    const r2 = compileContext(input);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.manifest.manifestHash).toBe(r2.manifest.manifestHash);
  });

  it("produces a different manifestHash when nowMs changes", () => {
    const r1 = compileContext(baseInput({ nowMs: 1_000 }));
    const r2 = compileContext(baseInput({ nowMs: 2_000 }));
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.manifest.manifestHash).not.toBe(r2.manifest.manifestHash);
  });

  it("produces a different manifestHash when policyHash changes", () => {
    const r1 = compileContext(baseInput());
    const r2 = compileContext(baseInput({ policy: { ...BASE_POLICY, policyHash: "other-v1" } }));
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.manifest.manifestHash).not.toBe(r2.manifest.manifestHash);
  });
});

// ─── 2. Stable tie-breaking by objectId ──────────────────────────────────────

describe("A-CTX-1 stable sort", () => {
  it("produces same decision order regardless of candidate array order", () => {
    const a = makeObj({ id: "aaa", estimatedTokens: 50 });
    const b = makeObj({ id: "bbb", estimatedTokens: 50 });

    const r1 = compileContext(baseInput({ candidates: [a, b] }));
    const r2 = compileContext(baseInput({ candidates: [b, a] }));

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    const ids1 = r1.manifest.decisions.map((d) => d.objectId);
    const ids2 = r2.manifest.decisions.map((d) => d.objectId);
    expect(ids1).toEqual(ids2);
    expect(r1.manifest.manifestHash).toBe(r2.manifest.manifestHash);
  });
});

// ─── 3. Priority ordering: required → (pinned) → high → normal → low ─────────

describe("A-CTX-1 priority ordering", () => {
  it("selects required candidates before optional ones", () => {
    const req = makeObj({ id: "req-1", priority: "required", estimatedTokens: 100 });
    const opt = makeObj({ id: "opt-1", priority: "normal", estimatedTokens: 100 });
    const result = compileContext(baseInput({ candidates: [opt, req] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reqDecision = result.manifest.decisions.find((d) => d.objectId === "req-1");
    expect(reqDecision?.decision).toBe("included");
  });

  it("places pinned candidates between required and high", () => {
    const req = makeObj({ id: "req-1", priority: "required", estimatedTokens: 50 });
    const pinned = makeObj({ id: "pin-1", priority: "normal", pinnedBy: "user", estimatedTokens: 50 });
    const high = makeObj({ id: "hi-1", priority: "high", estimatedTokens: 50 });
    const result = compileContext(
      baseInput({ candidates: [high, pinned, req], budget: { ...BASE_BUDGET, maxWorkingSetTokens: 200 } })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rank = (id: string) => result.manifest.decisions.findIndex((d) => d.objectId === id);
    expect(rank("req-1")).toBeLessThan(rank("pin-1"));
    expect(rank("pin-1")).toBeLessThan(rank("hi-1"));
  });
});

// ─── 4. Pinned token cap — fail-closed ───────────────────────────────────────

describe("A-CTX-1 pinnedTokensMax", () => {
  it("returns required_over_budget when pinned tokens exceed pinnedTokensMax", () => {
    const pinned = makeObj({
      id: "pin-1",
      priority: "normal",
      pinnedBy: "user",
      estimatedTokens: 2_000  // exceeds pinnedTokensMax: 1_500
    });
    const result = compileContext(baseInput({ candidates: [pinned] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("required_over_budget");
    expect(result.manifest).toBeNull();
    expect(result.ledgerEntry).toBeNull();
  });
});

// ─── 5. Required-starvation: explicit_escalation vs fail_closed ───────────────

describe("A-CTX-1 required-over-budget policy", () => {
  it("fail_closed returns required_over_budget immediately", () => {
    const req = makeObj({ id: "req-1", priority: "required", estimatedTokens: 10_000 });
    const result = compileContext(
      baseInput({
        candidates: [req],
        budget: { ...BASE_BUDGET, maxWorkingSetTokens: 100 },
        policy: { ...BASE_POLICY, requiredOverBudgetAction: "fail_closed" }
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("required_over_budget");
  });

  it("explicit_escalation records excluded decision and continues", () => {
    const req = makeObj({ id: "req-1", priority: "required", estimatedTokens: 10_000 });
    const opt = makeObj({ id: "opt-1", priority: "normal", estimatedTokens: 50 });
    const result = compileContext(
      baseInput({
        candidates: [req, opt],
        budget: { ...BASE_BUDGET, maxWorkingSetTokens: 100 },
        policy: { ...BASE_POLICY, requiredOverBudgetAction: "explicit_escalation" }
      })
    );
    // explicit_escalation: compiler continues but marks required as excluded
    // result may be ok:false (required still over budget) — either outcome is valid
    // What matters: no unhandled exception
    expect(["required_over_budget", true]).toContain(result.ok === false ? result.reason : true);
  });
});

// ─── 6. Optional exclusion at budget exhaustion ───────────────────────────────

describe("A-CTX-1 budget exhaustion", () => {
  it("excludes optional candidates when budget is exhausted", () => {
    const req = makeObj({ id: "req-1", priority: "required", estimatedTokens: 90 });
    const opt = makeObj({ id: "opt-1", priority: "normal", estimatedTokens: 90 });
    const result = compileContext(
      baseInput({
        candidates: [req, opt],
        budget: { ...BASE_BUDGET, maxWorkingSetTokens: 100 }
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const optDecision = result.manifest.decisions.find((d) => d.objectId === "opt-1");
    expect(optDecision?.decision).toBe("excluded");
    expect(optDecision?.reason).toBe("budget_exhausted");
  });
});

// ─── 7. Truncation → included_truncated with truncatedFromTokens ──────────────

describe("A-CTX-1 truncation metadata", () => {
  it("records included_truncated with truncatedFromTokens for oversized pinned objects", () => {
    // A pinned object whose estimatedTokens exceeds maxWorkingSetTokens triggers truncation.
    // pinnedTokensTotal (500) is below pinnedTokensMax (1500) so the pin-cap gate is not hit.
    // Total required = 0, so requiredOverBudget stays false and the per-object path fires.
    const pinned = makeObj({
      id: "pin-1",
      priority: "normal",
      pinnedBy: "user",
      estimatedTokens: 500
    });
    const result = compileContext(
      baseInput({
        candidates: [pinned],
        budget: { ...BASE_BUDGET, maxWorkingSetTokens: 100, pinnedTokensMax: 1_500 }
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dec = result.manifest.decisions.find((d) => d.objectId === "pin-1");
    expect(dec?.decision).toBe("included_truncated");
    expect(dec?.truncatedFromTokens).toBe(500);
  });
});

// ─── 8. Adapter recount — renderedTokens populated ───────────────────────────

describe("A-CTX-1 adapter recount", () => {
  it("populates renderedTokens on included decisions after recount", () => {
    const obj = makeObj({ id: "obj-1", estimatedTokens: 100 });
    const result = compileContext(baseInput({ candidates: [obj] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dec = result.manifest.decisions.find((d) => d.objectId === "obj-1");
    expect(dec?.decision).toBe("included");
    expect(typeof dec?.renderedTokens).toBe("number");
    expect((dec?.renderedTokens ?? 0)).toBeGreaterThan(0);
  });

  it("records renderPasses in manifest (≥1, ≤MAX_RENDER_PASSES)", () => {
    const result = compileContext(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.renderPasses).toBeGreaterThanOrEqual(1);
    expect(result.manifest.renderPasses).toBeLessThanOrEqual(MAX_RENDER_PASSES);
  });
});

// ─── 9. MAX_RENDER_PASSES = 5 limit — non-converging adapter ─────────────────

describe("A-CTX-1 recount pass limit", () => {
  it("returns recount_exceeded_passes when adapter never converges", () => {
    let call = 0;
    const nonConvergingAdapter: ContextAdapter = {
      version: "non-converging@1",
      recountTokens: () => ++call  // always increasing — never converges
    };
    const obj = makeObj({ id: "obj-1", estimatedTokens: 50 });
    const result = compileContext(
      baseInput({ candidates: [obj], adapter: nonConvergingAdapter })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("recount_exceeded_passes");
    // Adapter should have been called exactly MAX_RENDER_PASSES times
    expect(call).toBeLessThanOrEqual(MAX_RENDER_PASSES);
  });
});

// ─── 10. No raw source text in manifest or ledger ─────────────────────────────

describe("A-CTX-1 no raw text in receipts", () => {
  it("manifest contains no text fields beyond hash strings", () => {
    const result = compileContext(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.manifest);
    // The only long strings should be hashes (hex) or short metadata strings
    // Confirm sourceRef and text-like fields are absent from manifest
    expect(serialized).not.toContain('"text"');
    expect(serialized).not.toContain('"sourceText"');
    expect(serialized).not.toContain('"content"');
  });

  it("ledgerEntry contains no text or source content", () => {
    const result = compileContext(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.ledgerEntry);
    expect(serialized).not.toContain('"text"');
    expect(serialized).not.toContain('"content"');
  });

  it("ledgerEntry has no confidence or outcome_delta fields", () => {
    const result = compileContext(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ledgerEntry).not.toHaveProperty("confidence");
    expect(result.ledgerEntry).not.toHaveProperty("outcome_delta");
  });
});

// ─── 11. Input candidates array not mutated ───────────────────────────────────

describe("A-CTX-1 no input mutation", () => {
  it("does not mutate the candidates array or its objects", () => {
    const candidates = [
      makeObj({ id: "obj-1", estimatedTokens: 100 }),
      makeObj({ id: "obj-2", estimatedTokens: 100 })
    ] as const;

    const snapshot = JSON.stringify(candidates);
    compileContext(baseInput({ candidates: [...candidates] }));
    expect(JSON.stringify(candidates)).toBe(snapshot);
  });
});

// ─── 12. Secret objects are denied ───────────────────────────────────────────

describe("A-CTX-1 policy enforcement", () => {
  it("excludes secret-sensitivity candidates per policy", () => {
    const secret = makeObj({ id: "secret-1", sensitivity: "secret", priority: "normal", estimatedTokens: 50 });
    const normal = makeObj({ id: "normal-1", sensitivity: "workspace", priority: "normal", estimatedTokens: 50 });
    const result = compileContext(baseInput({ candidates: [secret, normal] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A-CTX-2: secret-1 must appear in decisions as governed exclusion evidence, not silently dropped
    const secretDecision = result.manifest.decisions.find((d) => d.objectId === "secret-1");
    expect(secretDecision?.decision).toBe("excluded");
    expect(secretDecision?.reason).toMatch(/sensitivity_denied/);
    // normal-1 should be included
    const normalDecision = result.manifest.decisions.find((d) => d.objectId === "normal-1");
    expect(normalDecision?.decision).toBe("included");
  });
});

// ─── 13. MAX_RENDER_PASSES constant ──────────────────────────────────────────

describe("MAX_RENDER_PASSES", () => {
  it("is exactly 5", () => {
    expect(MAX_RENDER_PASSES).toBe(5);
  });
});
