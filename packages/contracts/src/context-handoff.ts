/**
 * Context Handoff — A-CTX-2 contracts.
 *
 * Chain verification circuit breaker for upstream-to-downstream context handoff.
 *
 * Rule: a downstream agent MUST NOT execute before verifyContextHandoff returns ok=true.
 * Healthy handoffs are silent. Broken handoffs stop execution and return one reason code
 * plus one recovery instruction. Never silently discard excluded or unverifiable context.
 */

// ─── Chain integrity ──────────────────────────────────────────────────────────

/**
 * Overall integrity state of the upstream chain.
 * "verified"          — all upstream receipts and artifacts check out
 * "evidence_boundary" — upstream integrity could not be established (no receipt)
 * "tamper_detected"   — receipt hash or artifact hash does not match
 * "incomplete"        — required fields or artifacts are absent
 * "unsupported_schema"— handoff schemaVersion is not recognised
 */
export type ChainIntegrityState =
  | "verified"
  | "evidence_boundary"
  | "tamper_detected"
  | "incomplete"
  | "unsupported_schema";

// ─── Claim verification ───────────────────────────────────────────────────────

export type HandoffClaimState =
  | "verified"
  | "unverified"
  | "rejected"
  | "unknown";

/** A single verifiable statement carried across the handoff boundary. */
export interface ContextHandoffClaim {
  claimId: string;
  statement: string;
  evidenceRefs: string[];
  verificationState: HandoffClaimState;
}

// ─── Artifacts ────────────────────────────────────────────────────────────────

/** A content-addressed artifact that must be present and hash-stable across the boundary. */
export interface ContextHandoffArtifact {
  path?: string;
  sha256: string;
  required: boolean;
  label?: string;
}

// ─── Receipt ──────────────────────────────────────────────────────────────────

export const HANDOFF_SCHEMA_VERSION = "martin.handoff.v1" as const;

/**
 * Immutable record produced by the upstream agent and verified before the
 * downstream agent executes.
 *
 * upstreamIntegrity propagates from the parent handoff — it can never be
 * upgraded by downstream success. A "tamper_detected" upstream remains
 * "tamper_detected" regardless of what the current agent does.
 */
export interface ContextHandoffReceipt {
  schemaVersion: typeof HANDOFF_SCHEMA_VERSION;
  handoffId: string;
  chainId: string;
  missionId?: string;

  producerRunId: string;
  /** SHA-256 of the upstream run's canonical receipt file. */
  producerReceiptHash: string;

  /** Parent handoff IDs for multi-hop chain lineage. */
  parentHandoffIds?: string[];
  claims: ContextHandoffClaim[];
  artifacts: ContextHandoffArtifact[];

  /** Free-text assumptions that have not yet been verified at handoff time. */
  unresolvedAssumptions: string[];

  upstreamIntegrity:
    | "verified"
    | "evidence_boundary"
    | "tamper_detected"
    | "incomplete";

  createdAt: string;
}

// ─── Exclusion decision ───────────────────────────────────────────────────────

/**
 * Safe ledger record for a context object that was denied before reaching
 * executable context.
 *
 * MUST NOT contain the secret value or raw denied content — only safe
 * identity, hashes, and reason codes.
 */
export interface ContextExclusionDecision {
  decision: "excluded";
  objectId: string;
  reasonCode:
    | "secret_detected"
    | "policy_denied"
    | "authority_boundary"
    | "integrity_unverified";
  reason: string;
  /** SHA-256 of the denied content — never the content itself. */
  sourceHash?: string;
  excludedAt: string;
}

// ─── Verification result ──────────────────────────────────────────────────────

export interface ContextHandoffVerification {
  ok: boolean;
  integrity: ChainIntegrityState;
  reasons: Array<{
    code: string;
    message: string;
    claimId?: string;
    artifactSha256?: string;
  }>;
}

// ─── Circuit breaker result ───────────────────────────────────────────────────

/**
 * Decision produced by decideContextCircuitBreak.
 *
 * Healthy:  { shouldStop: false, silent: true }
 * Broken:   { shouldStop: true, silent: false, reasonCode, message, nextAction }
 */
export interface ContextCircuitBreakResult {
  shouldStop: boolean;
  /** true = healthy, no human-visible output; false = must surface to caller */
  silent: boolean;
  verification: ContextHandoffVerification;
  reasonCode?: string;
  message?: string;
  nextAction?: string;
}
