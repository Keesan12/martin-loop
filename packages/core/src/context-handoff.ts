/**
 * Context Handoff Verifier — A-CTX-2
 *
 * Pure functions for verifying upstream-to-downstream context handoffs and
 * deciding whether to circuit-break before the downstream agent executes.
 *
 * Standing rules:
 *   - These functions are pure and side-effect-free.
 *   - verifyContextHandoff fails closed — any ambiguity → not ok.
 *   - decideContextCircuitBreak is the sole gate before adapter execution.
 *   - The downstream adapter MUST NOT be called when shouldStop is true.
 */

import type {
  ChainIntegrityState,
  ContextCircuitBreakResult,
  ContextHandoffArtifact,
  ContextHandoffClaim,
  ContextHandoffReceipt,
  ContextHandoffVerification
} from "@martin/contracts";
import { HANDOFF_SCHEMA_VERSION } from "@martin/contracts";

// ─── Supported schema versions ────────────────────────────────────────────────

const SUPPORTED_SCHEMAS = new Set<string>([HANDOFF_SCHEMA_VERSION]);

// ─── Verify ───────────────────────────────────────────────────────────────────

export interface VerifyContextHandoffInput {
  handoff: ContextHandoffReceipt;
  /** true when the producer receipt file hash has been independently confirmed */
  producerReceiptVerified: boolean;
  /** Map of sha256 → true for every artifact hash available to the verifier */
  availableArtifacts: ReadonlyMap<string, true>;
}

/**
 * Deterministically verifies a context handoff.
 *
 * Returns ok=false when ANY of the following is true:
 *   - schemaVersion is not in SUPPORTED_SCHEMAS
 *   - producerReceiptVerified is false
 *   - upstreamIntegrity is not "verified"
 *   - a required artifact is absent from availableArtifacts
 *   - an artifact sha256 does not appear in availableArtifacts (hash changed)
 *   - any required claim has state "unverified" or "rejected"
 *   - any claim has state "unknown"
 *   - unresolvedAssumptions is non-empty
 *   - handoffId, chainId, producerRunId, or producerReceiptHash is blank
 */
export function verifyContextHandoff(
  input: VerifyContextHandoffInput
): ContextHandoffVerification {
  const { handoff, producerReceiptVerified, availableArtifacts } = input;

  const reasons: ContextHandoffVerification["reasons"] = [];

  // ── Schema ──────────────────────────────────────────────────────────────────
  if (!SUPPORTED_SCHEMAS.has(handoff.schemaVersion)) {
    return {
      ok: false,
      integrity: "unsupported_schema",
      reasons: [
        {
          code: "unsupported_schema",
          message: `Handoff schemaVersion "${handoff.schemaVersion}" is not supported. Supported: ${[...SUPPORTED_SCHEMAS].join(", ")}.`
        }
      ]
    };
  }

  // ── Required identity fields ─────────────────────────────────────────────────
  if (!isPresent(handoff.handoffId)) {
    reasons.push({ code: "missing_handoff_id", message: "handoffId is required." });
  }
  if (!isPresent(handoff.chainId)) {
    reasons.push({ code: "missing_chain_id", message: "chainId is required." });
  }
  if (!isPresent(handoff.producerRunId)) {
    reasons.push({ code: "missing_producer_run_id", message: "producerRunId is required." });
  }
  if (!isPresent(handoff.producerReceiptHash)) {
    reasons.push({ code: "missing_producer_receipt_hash", message: "producerReceiptHash is required." });
  }

  // ── Producer receipt verification ────────────────────────────────────────────
  if (!producerReceiptVerified) {
    reasons.push({
      code: "producer_receipt_unverified",
      message: "The producer receipt hash could not be independently verified."
    });
  }

  // ── Upstream integrity propagation ───────────────────────────────────────────
  if (handoff.upstreamIntegrity !== "verified") {
    reasons.push({
      code: `upstream_integrity_${handoff.upstreamIntegrity}`,
      message: `Upstream integrity is "${handoff.upstreamIntegrity}" — cannot proceed.`
    });
  }

  // ── Artifact verification ────────────────────────────────────────────────────
  for (const artifact of handoff.artifacts) {
    const present = availableArtifacts.has(artifact.sha256);
    if (artifact.required && !present) {
      reasons.push({
        code: "missing_required_artifact",
        message: `Required artifact is absent (sha256: ${artifact.sha256}${artifact.label ? `, label: ${artifact.label}` : ""}).`,
        artifactSha256: artifact.sha256
      });
    } else if (!present) {
      reasons.push({
        code: "artifact_hash_mismatch",
        message: `Artifact hash not found in available set (sha256: ${artifact.sha256}${artifact.label ? `, label: ${artifact.label}` : ""}).`,
        artifactSha256: artifact.sha256
      });
    }
  }

  // ── Claim verification ────────────────────────────────────────────────────────
  for (const claim of handoff.claims) {
    if (claim.verificationState === "rejected") {
      reasons.push({
        code: "claim_rejected",
        message: `Claim "${claim.claimId}" was rejected: ${claim.statement}`,
        claimId: claim.claimId
      });
    } else if (claim.verificationState === "unverified") {
      reasons.push({
        code: "claim_unverified",
        message: `Claim "${claim.claimId}" is unverified: ${claim.statement}`,
        claimId: claim.claimId
      });
    } else if (claim.verificationState === "unknown") {
      reasons.push({
        code: "claim_unknown",
        message: `Claim "${claim.claimId}" has unknown verification state: ${claim.statement}`,
        claimId: claim.claimId
      });
    }
  }

  // ── Unresolved assumptions ────────────────────────────────────────────────────
  if (handoff.unresolvedAssumptions.length > 0) {
    reasons.push({
      code: "unresolved_assumptions",
      message: `${handoff.unresolvedAssumptions.length} assumption(s) remain unresolved: ${handoff.unresolvedAssumptions.slice(0, 3).join("; ")}${handoff.unresolvedAssumptions.length > 3 ? " …" : ""}`
    });
  }

  const ok = reasons.length === 0;
  const integrity = ok ? "verified" : deriveIntegrity(handoff, reasons);

  return { ok, integrity, reasons };
}

// ─── Circuit breaker ──────────────────────────────────────────────────────────

/**
 * Converts a ContextHandoffVerification into a gate decision.
 *
 * Healthy:  { shouldStop: false, silent: true }
 * Broken:   { shouldStop: true, silent: false, reasonCode, message, nextAction }
 */
export function decideContextCircuitBreak(
  verification: ContextHandoffVerification
): ContextCircuitBreakResult {
  if (verification.ok) {
    return {
      shouldStop: false,
      silent: true,
      verification
    };
  }

  const first = verification.reasons[0];

  return {
    shouldStop: true,
    silent: false,
    verification,
    reasonCode: first?.code ?? "handoff_verification_failed",
    message: first?.message ?? "Context handoff verification failed.",
    nextAction: "Repair or replace the upstream handoff receipt, then retry."
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isPresent(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function deriveIntegrity(
  handoff: ContextHandoffReceipt,
  reasons: ContextHandoffVerification["reasons"]
): ChainIntegrityState {
  const codes = reasons.map((r) => r.code);

  if (codes.includes("unsupported_schema")) return "unsupported_schema";

  if (
    codes.some(
      (c) =>
        c === "upstream_integrity_tamper_detected" ||
        c === "artifact_hash_mismatch"
    )
  ) {
    return "tamper_detected";
  }

  if (codes.includes("producer_receipt_unverified") || codes.includes("upstream_integrity_evidence_boundary")) {
    return "evidence_boundary";
  }

  return "incomplete";
}
