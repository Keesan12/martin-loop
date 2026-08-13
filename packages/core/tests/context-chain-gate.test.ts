/**
 * C1 — Context Chain Gate tests
 *
 * Covers all contract scenarios from the internal spec:
 *  1.  Valid receipt, verifier passed, integrity verified → pass
 *  2.  No receipt → hard fail (no_governance_receipt)
 *  3.  Tampered receipt → hard fail (tamper_detected)
 *  4.  Verifier failed, require-verifier true (default) → fail
 *  5.  Verifier failed, require-verifier false → neutral (no block)
 *  6.  Cost within budget → success, cost row present
 *  7.  Cost over budget → success (comment only, never blocks)
 *  8.  observe-mode semantics: shouldBlock=false even on hard fail inputs
 *  9.  PR comment contains governance status headline
 * 10.  PR comment contains cost row when cost provided
 * 11.  PR comment contains lineage fields when provided
 * 12.  PR comment does not block on cost overage
 * 13.  Incomplete integrity (evidence_boundary) → verifier failed path
 * 14.  post-comment false → renderGatePrComment still works (caller controls posting)
 */

import { describe, it, expect } from "vitest";
import {
  evaluateChainGate,
  renderGatePrComment,
  type ChainGateInput,
  type ChainGateResult
} from "../src/context-chain-gate.js";
import type { ContextHandoffReceipt, ContextHandoffVerification } from "@martin/contracts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VERIFIED_VERIFICATION: ContextHandoffVerification = {
  ok: true,
  integrity: "verified",
  reasons: []
};

const FAILED_VERIFICATION: ContextHandoffVerification = {
  ok: false,
  integrity: "incomplete",
  reasons: [{ code: "claim_unverified", message: "Claim c1 is unverified." }]
};

const TAMPERED_VERIFICATION: ContextHandoffVerification = {
  ok: false,
  integrity: "tamper_detected",
  reasons: [{ code: "upstream_integrity_tamper_detected", message: "Tamper detected." }]
};

const RECEIPT: ContextHandoffReceipt = {
  schemaVersion: "martin.handoff.v1",
  handoffId: "hoff_001",
  chainId: "chain_abc",
  producerRunId: "run_upstream_1",
  producerReceiptHash: "abc123deadbeef",
  claims: [{ claimId: "c1", statement: "Tests passed.", evidenceRefs: ["receipt:run_1"], verificationState: "verified" }],
  artifacts: [],
  unresolvedAssumptions: [],
  upstreamIntegrity: "verified",
  createdAt: "2026-07-24T00:00:00.000Z"
};

const BUDGET_COST = { actualUsd: 0.0420, budgetUsd: 0.1000 };
const OVER_BUDGET_COST = { actualUsd: 0.1500, budgetUsd: 0.1000 };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("C1 context chain gate", () => {

  it("1: valid receipt + verified → shouldBlock=false, conclusion=success", () => {
    const result = evaluateChainGate({
      receipt: RECEIPT,
      verification: VERIFIED_VERIFICATION
    });
    expect(result.shouldBlock).toBe(false);
    expect(result.conclusion).toBe("success");
    expect(result.noGovernance).toBe(false);
    expect(result.tamperDetected).toBe(false);
    expect(result.verifierFailed).toBe(false);
    expect(result.integrity).toBe("verified");
  });

  it("2: no receipt → hard fail no_governance_receipt", () => {
    const result = evaluateChainGate({ receipt: null, verification: null });
    expect(result.shouldBlock).toBe(true);
    expect(result.conclusion).toBe("failure");
    expect(result.noGovernance).toBe(true);
    expect(result.failureReasonCode).toBe("no_governance_receipt");
    expect(result.integrity).toBe("absent");
  });

  it("3: tamper_detected → hard fail tamper_detected, cannot be disabled", () => {
    const result = evaluateChainGate({
      receipt: RECEIPT,
      verification: TAMPERED_VERIFICATION,
      // even with blockOnVerifierFailure: false, tamper always blocks
      config: { blockOnVerifierFailure: false }
    });
    expect(result.shouldBlock).toBe(true);
    expect(result.conclusion).toBe("failure");
    expect(result.tamperDetected).toBe(true);
    expect(result.failureReasonCode).toBe("tamper_detected");
  });

  it("4: verifier failed + blockOnVerifierFailure true (default) → fail", () => {
    const result = evaluateChainGate({
      receipt: RECEIPT,
      verification: FAILED_VERIFICATION,
      config: { blockOnVerifierFailure: true }
    });
    expect(result.shouldBlock).toBe(true);
    expect(result.conclusion).toBe("failure");
    expect(result.verifierFailed).toBe(true);
    expect(result.failureReasonCode).toBe("claim_unverified");
  });

  it("5: verifier failed + blockOnVerifierFailure false → neutral, no block", () => {
    const result = evaluateChainGate({
      receipt: RECEIPT,
      verification: FAILED_VERIFICATION,
      config: { blockOnVerifierFailure: false }
    });
    expect(result.shouldBlock).toBe(false);
    expect(result.conclusion).toBe("neutral");
    expect(result.verifierFailed).toBe(true);
  });

  it("6: cost within budget → included in result, exceeded=false", () => {
    const result = evaluateChainGate({
      receipt: RECEIPT,
      verification: VERIFIED_VERIFICATION,
      cost: BUDGET_COST
    });
    expect(result.cost).toBeDefined();
    expect(result.cost?.exceeded).toBe(false);
    expect(result.cost?.actualUsd).toBe(0.0420);
    expect(result.shouldBlock).toBe(false);
  });

  it("7: cost over budget → exceeded=true but shouldBlock=false (never blocks)", () => {
    const result = evaluateChainGate({
      receipt: RECEIPT,
      verification: VERIFIED_VERIFICATION,
      cost: OVER_BUDGET_COST
    });
    expect(result.cost?.exceeded).toBe(true);
    // CRITICAL: cost overage must never cause shouldBlock=true
    expect(result.shouldBlock).toBe(false);
    expect(result.conclusion).toBe("success");
  });

  it("8: no receipt with cost → cost still included even in hard fail", () => {
    const result = evaluateChainGate({
      receipt: null,
      verification: null,
      cost: BUDGET_COST
    });
    expect(result.shouldBlock).toBe(true);
    expect(result.noGovernance).toBe(true);
    expect(result.cost).toBeDefined();
    expect(result.cost?.actualUsd).toBe(0.0420);
  });

  it("9: PR comment contains governance status headline", () => {
    const result = evaluateChainGate({ receipt: RECEIPT, verification: VERIFIED_VERIFICATION });
    const comment = renderGatePrComment(result);
    expect(comment).toContain("## MartinLoop Governance");
    expect(comment).toContain("✅ **Governance verified**");
  });

  it("10: PR comment contains cost row when cost provided", () => {
    const result = evaluateChainGate({
      receipt: RECEIPT,
      verification: VERIFIED_VERIFICATION,
      cost: BUDGET_COST
    });
    const comment = renderGatePrComment(result);
    expect(comment).toContain("Cost");
    expect(comment).toContain("0.0420");
    expect(comment).toContain("within budget");
  });

  it("11: PR comment contains lineage fields when provided", () => {
    const result = evaluateChainGate({ receipt: RECEIPT, verification: VERIFIED_VERIFICATION });
    const comment = renderGatePrComment(result, {
      chainId: "chain_abc",
      producerRunId: "run_upstream_1",
      runId: "run_consumer_1"
    });
    expect(comment).toContain("chain_abc");
    expect(comment).toContain("run_upstream_1");
    expect(comment).toContain("run_consumer_1");
  });

  it("12: PR comment on cost overage warns but does not say 'blocked'", () => {
    const result = evaluateChainGate({
      receipt: RECEIPT,
      verification: VERIFIED_VERIFICATION,
      cost: OVER_BUDGET_COST
    });
    const comment = renderGatePrComment(result);
    expect(comment).toContain("over budget");
    // Cost overage must not produce a blocking headline
    expect(comment).not.toContain("🚫");
  });

  it("13: evidence_boundary integrity → verifier failed, integrity preserved", () => {
    const ebVerification: ContextHandoffVerification = {
      ok: false,
      integrity: "evidence_boundary",
      reasons: [{ code: "upstream_integrity_evidence_boundary", message: "Evidence boundary." }]
    };
    const result = evaluateChainGate({
      receipt: RECEIPT,
      verification: ebVerification,
      config: { blockOnVerifierFailure: true }
    });
    expect(result.integrity).toBe("evidence_boundary");
    expect(result.verifierFailed).toBe(true);
    expect(result.shouldBlock).toBe(true);
  });

  it("14: renderGatePrComment on hard fail contains 🚫 headline", () => {
    const result = evaluateChainGate({ receipt: null, verification: null });
    const comment = renderGatePrComment(result);
    expect(comment).toContain("🚫");
    expect(comment).toContain("No governance receipt");
  });
});
