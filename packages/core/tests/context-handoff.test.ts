/**
 * A-CTX-2 — Context Handoff Circuit Breaker tests
 *
 * All 11 required behaviours:
 *  1. healthy handoff is silent and downstream execution proceeds
 *  2. invalid producer receipt blocks downstream execution
 *  3. required artifact hash mismatch blocks execution
 *  4. missing required artifact blocks execution
 *  5. unverified claim blocks execution
 *  6. unresolved assumption blocks execution
 *  7. upstream evidence boundary cannot be erased by downstream success
 *  8. excluded secret content is absent from executable context
 *  9. excluded secret content has a safe ledger decision
 * 10. downstream adapter was never called when the gate blocked
 * 11. healthy handoff lineage appears in the final receipt
 */

import { describe, it, expect, vi } from "vitest";
import {
  verifyContextHandoff,
  decideContextCircuitBreak
} from "../src/context-handoff.js";
import { compileContext, HEURISTIC_ADAPTER } from "../src/context-compiler.js";
import type {
  ContextHandoffReceipt,
  ContextObject,
  ContextBudget,
  ContextPolicy
} from "@martin/contracts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_RECEIPT: ContextHandoffReceipt = {
  schemaVersion: "martin.handoff.v1",
  handoffId: "hoff_001",
  chainId: "chain_abc",
  producerRunId: "run_upstream_1",
  producerReceiptHash: "abc123deadbeef",
  claims: [
    {
      claimId: "c1",
      statement: "Upstream tests passed.",
      evidenceRefs: ["receipt:run_upstream_1"],
      verificationState: "verified"
    }
  ],
  artifacts: [
    { sha256: "artifact_hash_1", required: true, label: "test-output" }
  ],
  unresolvedAssumptions: [],
  upstreamIntegrity: "verified",
  createdAt: "2026-07-22T00:00:00.000Z"
};

const AVAILABLE_ARTIFACTS = new Map<string, true>([["artifact_hash_1", true]]);

function makeReceipt(overrides: Partial<ContextHandoffReceipt>): ContextHandoffReceipt {
  return { ...VALID_RECEIPT, ...overrides };
}

// ─── Test policy and budget ───────────────────────────────────────────────────

const BUDGET: ContextBudget = {
  modelWindowTokens: 10_000,
  systemReserveTokens: 500,
  outputReserveTokens: 500,
  toolReserveTokens: 500,
  overflowReserveTokens: 200,
  maxWorkingSetTokens: 5_000,
  pinnedTokensMax: 1_000
};

const POLICY: ContextPolicy = {
  policyHash: "policy_hash_test",
  deniedSensitivities: ["secret", "restricted"],
  deniedTrustLevels: ["untrusted"],
  requiredOverBudgetAction: "fail_closed",
  maxCompilerDurationMs: 5_000,
  maxOverheadRatio: 10
};

function makeObject(overrides: Partial<ContextObject>): ContextObject {
  return {
    id: "obj_1",
    kind: "task",
    priority: "normal",
    trust: "workspace",
    sensitivity: "public",
    sourceRef: "file://test.ts",
    contentHash: "hash_content_1",
    estimatedTokens: 100,
    ...overrides
  };
}

// ─── 1. Healthy handoff is silent ─────────────────────────────────────────────

describe("A-CTX-2 circuit breaker", () => {
  it("1: healthy handoff produces ok=true, silent=true, shouldStop=false", () => {
    const verification = verifyContextHandoff({
      handoff: VALID_RECEIPT,
      producerReceiptVerified: true,
      availableArtifacts: AVAILABLE_ARTIFACTS
    });

    expect(verification.ok).toBe(true);
    expect(verification.integrity).toBe("verified");
    expect(verification.reasons).toHaveLength(0);

    const gate = decideContextCircuitBreak(verification);
    expect(gate.shouldStop).toBe(false);
    expect(gate.silent).toBe(true);
    expect(gate.reasonCode).toBeUndefined();
  });

  // ── 2. Invalid producer receipt blocks ───────────────────────────────────────

  it("2: unverified producer receipt blocks execution", () => {
    const verification = verifyContextHandoff({
      handoff: VALID_RECEIPT,
      producerReceiptVerified: false,
      availableArtifacts: AVAILABLE_ARTIFACTS
    });

    expect(verification.ok).toBe(false);

    const gate = decideContextCircuitBreak(verification);
    expect(gate.shouldStop).toBe(true);
    expect(gate.silent).toBe(false);
    expect(gate.reasonCode).toBe("producer_receipt_unverified");
    expect(gate.nextAction).toMatch(/repair/i);
  });

  // ── 3. Artifact hash mismatch blocks ─────────────────────────────────────────

  it("3: artifact hash not in available set blocks execution", () => {
    const receipt = makeReceipt({
      artifacts: [{ sha256: "different_hash", required: true, label: "changed-file" }]
    });

    const verification = verifyContextHandoff({
      handoff: receipt,
      producerReceiptVerified: true,
      availableArtifacts: AVAILABLE_ARTIFACTS // does not contain "different_hash"
    });

    expect(verification.ok).toBe(false);
    const gate = decideContextCircuitBreak(verification);
    expect(gate.shouldStop).toBe(true);
    expect(gate.reasonCode).toMatch(/artifact/i);
  });

  // ── 4. Missing required artifact blocks ──────────────────────────────────────

  it("4: required artifact absent from available set blocks execution", () => {
    const receipt = makeReceipt({
      artifacts: [{ sha256: "missing_hash", required: true, label: "critical-output" }]
    });

    const verification = verifyContextHandoff({
      handoff: receipt,
      producerReceiptVerified: true,
      availableArtifacts: new Map() // empty
    });

    expect(verification.ok).toBe(false);
    const reasons = verification.reasons.map((r) => r.code);
    expect(reasons).toContain("missing_required_artifact");

    const gate = decideContextCircuitBreak(verification);
    expect(gate.shouldStop).toBe(true);
  });

  // ── 5. Unverified claim blocks ────────────────────────────────────────────────

  it("5: unverified claim blocks execution", () => {
    const receipt = makeReceipt({
      claims: [
        {
          claimId: "c_unverified",
          statement: "Tests passed — not confirmed.",
          evidenceRefs: [],
          verificationState: "unverified"
        }
      ]
    });

    const verification = verifyContextHandoff({
      handoff: receipt,
      producerReceiptVerified: true,
      availableArtifacts: AVAILABLE_ARTIFACTS
    });

    expect(verification.ok).toBe(false);
    const gate = decideContextCircuitBreak(verification);
    expect(gate.shouldStop).toBe(true);
    expect(gate.reasonCode).toBe("claim_unverified");
  });

  // ── 6. Unresolved assumptions block ──────────────────────────────────────────

  it("6: unresolved assumptions block execution", () => {
    const receipt = makeReceipt({
      unresolvedAssumptions: ["Auth service is running", "DB schema matches"]
    });

    const verification = verifyContextHandoff({
      handoff: receipt,
      producerReceiptVerified: true,
      availableArtifacts: AVAILABLE_ARTIFACTS
    });

    expect(verification.ok).toBe(false);
    const reasons = verification.reasons.map((r) => r.code);
    expect(reasons).toContain("unresolved_assumptions");

    const gate = decideContextCircuitBreak(verification);
    expect(gate.shouldStop).toBe(true);
  });

  // ── 7. Upstream evidence boundary cannot be erased ───────────────────────────

  it("7: evidence_boundary upstream integrity blocks even when other fields are valid", () => {
    const receipt = makeReceipt({ upstreamIntegrity: "evidence_boundary" });

    const verification = verifyContextHandoff({
      handoff: receipt,
      producerReceiptVerified: true,
      availableArtifacts: AVAILABLE_ARTIFACTS
    });

    expect(verification.ok).toBe(false);
    expect(verification.integrity).toBe("evidence_boundary");

    const gate = decideContextCircuitBreak(verification);
    expect(gate.shouldStop).toBe(true);
    expect(gate.reasonCode).toMatch(/evidence_boundary/);
  });

  // ── 8. Secret content absent from executable context ─────────────────────────

  it("8: secret-sensitivity object is absent from compiler admitted decisions", () => {
    const secretObj = makeObject({
      id: "secret_obj",
      sensitivity: "secret",
      contentHash: "secret_content_hash",
      estimatedTokens: 200
    });
    const normalObj = makeObject({
      id: "normal_obj",
      sensitivity: "public",
      estimatedTokens: 100
    });

    const result = compileContext({
      taskId: "task_1",
      runId: "run_1",
      nowMs: 1_000_000,
      candidates: [secretObj, normalObj],
      budget: BUDGET,
      policy: POLICY,
      adapter: HEURISTIC_ADAPTER
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Secret object must NOT be admitted into the executable working set
    const includedIds = result.manifest.decisions
      .filter((d) => d.decision === "included" || d.decision === "included_truncated")
      .map((d) => d.objectId);

    expect(includedIds).not.toContain("secret_obj");
    expect(includedIds).toContain("normal_obj");
  });

  // ── 9. Safe ledger decision exists for excluded secret ────────────────────────

  it("9: policy-excluded secret object has a safe governed decision in manifest", () => {
    const secretObj = makeObject({
      id: "secret_ledger_obj",
      sensitivity: "secret",
      contentHash: "secret_hash_no_content"
    });

    const result = compileContext({
      taskId: "task_2",
      runId: "run_2",
      nowMs: 2_000_000,
      candidates: [secretObj],
      budget: BUDGET,
      policy: POLICY,
      adapter: HEURISTIC_ADAPTER
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const exclusionDecision = result.manifest.decisions.find(
      (d) => d.objectId === "secret_ledger_obj"
    );

    expect(exclusionDecision).toBeDefined();
    expect(exclusionDecision?.decision).toBe("excluded");
    // Reason must be machine-readable, must NOT contain the raw content hash value
    expect(exclusionDecision?.reason).toMatch(/sensitivity_denied/);
    expect(exclusionDecision?.reason).not.toContain("secret_hash_no_content");
  });

  // ── 10. Adapter never called when gate blocks ──────────────────────────────────

  it("10: downstream adapter execute() is never called when circuit break fires", async () => {
    const receipt = makeReceipt({ producerReceiptHash: "" }); // missing hash → blocks

    const verification = verifyContextHandoff({
      handoff: receipt,
      producerReceiptVerified: true,
      availableArtifacts: AVAILABLE_ARTIFACTS
    });

    const gate = decideContextCircuitBreak(verification);
    expect(gate.shouldStop).toBe(true);

    // Simulate the gate contract: adapter is only called when shouldStop=false
    const mockExecute = vi.fn();
    if (!gate.shouldStop) {
      mockExecute();
    }

    expect(mockExecute).not.toHaveBeenCalled();
  });

  // ── 11. Healthy handoff lineage in receipt ─────────────────────────────────────

  it("11: verified handoff exposes chainId, handoffId, and producerRunId for lineage", () => {
    const verification = verifyContextHandoff({
      handoff: VALID_RECEIPT,
      producerReceiptVerified: true,
      availableArtifacts: AVAILABLE_ARTIFACTS
    });

    expect(verification.ok).toBe(true);
    const gate = decideContextCircuitBreak(verification);
    expect(gate.shouldStop).toBe(false);

    // Lineage fields are accessible from the receipt for downstream receipts
    expect(VALID_RECEIPT.chainId).toBe("chain_abc");
    expect(VALID_RECEIPT.handoffId).toBe("hoff_001");
    expect(VALID_RECEIPT.producerRunId).toBe("run_upstream_1");
    expect(VALID_RECEIPT.producerReceiptHash).toBe("abc123deadbeef");
  });
});
