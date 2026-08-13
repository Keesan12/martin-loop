/**
 * Context Runtime — A-CTX-1 contracts.
 *
 * Defines the governed context layer: objects, budgets, manifests, ledger
 * entries, fault protocol, and continuation checkpoints.
 *
 * Non-negotiable invariants (enforced in implementation, not type system):
 *   - No `confidence` float anywhere — use UsageEvidence enums only
 *   - No `outcome_delta` field anywhere — permanently banned
 *   - `nowMs` is always a captured input; never Date.now() inside a compiler
 *   - Secret scan hit → deny persistence entirely; reason-coded ledger entry only
 *   - Fault budget accumulates by taskId, NOT by runId
 */

// ─── Evidence quality ─────────────────────────────────────────────────────────

/**
 * Evidence quality for a metric or measurement.
 *
 * "observed"  = distinctive substring from the object appears verbatim in model output
 * "inferred"  = weak kind correlation, narrow and documented per kind
 * "unknown"   = default; metrics MUST be withheld, never reported as zero
 */
export type UsageEvidence = "observed" | "inferred" | "unknown";

// ─── Context object classification ───────────────────────────────────────────

export type ContextKind =
  | "mission"
  | "policy"
  | "security"
  | "task"
  | "continuation"
  | "working_diff"
  | "diagnostic"
  | "source"
  | "test"
  | "decision"
  | "todo"
  | "receipt_summary"
  | "tool_result";

export type ContextPriority = "required" | "high" | "normal" | "low";

export type ContextTrust =
  | "authoritative"
  | "workspace"
  | "external"
  | "untrusted";

export type ContextSensitivity =
  | "public"
  | "workspace"
  | "restricted"
  | "secret";

// ─── ContextObject ────────────────────────────────────────────────────────────

/** A typed, hashed, provenance-tracked object eligible for working-set inclusion. */
export interface ContextObject {
  /** Stable identifier across revisions. */
  id: string;
  kind: ContextKind;
  priority: ContextPriority;
  trust: ContextTrust;
  sensitivity: ContextSensitivity;
  /** File path, receipt hash, or MCP URI — where the object originates. */
  sourceRef: string;
  /** SHA-256 of raw content. */
  contentHash: string;
  /** Git SHA or equivalent revision of the source file, if known. */
  sourceRevisionHash?: string;
  /** Pre-render token estimate used during selection. */
  estimatedTokens: number;
  /** Set iff the object was manually pinned; counts against pinnedTokensMax. */
  pinnedBy?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// ─── ContextBudget ────────────────────────────────────────────────────────────

/**
 * Token budget for one context compilation pass.
 *
 * pinnedTokensMax REQUIRED: caps manual-pin tokens to prevent deterministic
 * selector starvation. Any pin that would exceed this cap must be rejected.
 */
export interface ContextBudget {
  modelWindowTokens: number;
  systemReserveTokens: number;
  outputReserveTokens: number;
  toolReserveTokens: number;
  overflowReserveTokens: number;
  maxWorkingSetTokens: number;
  /** Hard cap on manually-pinned token allocation. */
  pinnedTokensMax: number;
}

// ─── ContextCandidateDecision ─────────────────────────────────────────────────

/**
 * The compiler's per-object inclusion/exclusion record.
 *
 * "included_truncated" is DISTINCT from "included" — truncation must be
 * explicit in every receipt. Never use "included" for a truncated object.
 */
export interface ContextCandidateDecision {
  objectId: string;
  decision:
    | "included"
    | "included_truncated"
    | "excluded"
    | "deferred"
    | "fault_loaded";
  /**
   * Only present when decision === "included_truncated".
   * Records the pre-truncation token count for receipts.
   */
  truncatedFromTokens?: number;
  /** Machine-readable reason code for this decision. */
  reason: string;
  /** Actual post-render token count after adapter recount. Omitted pre-render. */
  renderedTokens?: number;
}

// ─── ContextManifest ─────────────────────────────────────────────────────────

export const CONTEXT_MANIFEST_VERSION = "context-manifest/1" as const;

/**
 * Immutable record of one context compilation pass.
 *
 * Determinism invariant:
 *   same inputs + policyHash + adapterVersion + nowMs → same manifestHash
 *
 * nowMs MUST be an explicit captured input — never Date.now() inside the
 * compiler or rankContextObject.
 */
export interface ContextManifest {
  schemaVersion: typeof CONTEXT_MANIFEST_VERSION;
  /** SHA-256 of (decisions + budget + policyHash + adapterVersion + nowMs). */
  manifestHash: string;
  taskId: string;
  runId: string;
  /** Explicit input — never Date.now() inside the compiler. */
  nowMs: number;
  adapterVersion: string;
  policyHash: string;
  budget: ContextBudget;
  decisions: ContextCandidateDecision[];
  totalRenderedTokens: number;
  /** Render pass count; must be ≤ MAX_RENDER_PASSES (5). */
  renderPasses: number;
  compilationDurationMs: number;
}

// ─── ContextLedgerEntry ───────────────────────────────────────────────────────

export const CONTEXT_LEDGER_VERSION = "context-ledger/1" as const;

/**
 * Fourth ledger entry type — on the SAME receipt chain as cost and verification.
 *
 * FORBIDDEN: confidence field, outcome_delta field — both permanently banned.
 * overflowCount and faultBudgetUsed accumulate by taskId, NOT by runId.
 */
export interface ContextLedgerEntry {
  schemaVersion: typeof CONTEXT_LEDGER_VERSION;
  entryType: "context";
  taskId: string;
  runId: string;
  manifestHash: string;
  totalIncluded: number;
  totalExcluded: number;
  totalFaultLoaded: number;
  /** Cumulative overflow count — resets per task, never per run. */
  overflowCount: number;
  /** Cumulative fault budget consumed — resets per task, never per run. */
  faultBudgetUsed: number;
  adapterVersion: string;
}

// ─── Context Fault protocol ───────────────────────────────────────────────────

/** Request to demand-load a missing context object on fault. */
export interface ContextFaultRequest {
  objectId: string;
  taskId: string;
  runId: string;
  reason: string;
}

/** Result of a context fault resolution attempt. */
export interface ContextFaultResult {
  objectId: string;
  status: "loaded" | "unavailable" | "secret_blocked" | "budget_exceeded";
  /** Post-render token count when status === "loaded". */
  renderedTokens?: number;
  ledgerEventEmitted: boolean;
}

// ─── ContinuationCheckpoint ───────────────────────────────────────────────────

/** Minimal task item tracked within a ContinuationCheckpoint. */
export interface TaskItem {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  createdAtMs: number;
  completedAtMs?: number;
}

/**
 * Durable task state preserved outside the provider transcript.
 *
 * Write discipline (all enforced in CheckpointStore):
 *   - All writes MUST go through CheckpointStore.withTaskLock (CAS-locked).
 *   - Reject if store.read(taskId).sequenceNumber !== checkpoint.sequenceNumber - 1.
 *   - All array fields MUST be bounded before persistence.
 *   - Old completed entries MUST be compacted into completedSummaryHash.
 *
 * Testing requirement: two real concurrent Node processes, not jest mocks.
 */
export interface ContinuationCheckpoint {
  schemaVersion: "checkpoint/1";
  taskId: string;
  /** CAS lock key: reject write if stored sequenceNumber !== this - 1. */
  sequenceNumber: number;
  /** SHA-256 of the previous checkpoint — integrity chain. */
  parentHash: string;
  /** Old completed[] compacted into a hash-referenced summary to bound size. */
  completedSummaryHash?: string;
  pending: TaskItem[];
  inProgress: TaskItem[];
  decisions: ContextCandidateDecision[];
  createdAtMs: number;
}

// ─── ContextPolicy ────────────────────────────────────────────────────────────

/**
 * Governs what may enter the working set, how much, and why.
 * policyHash must be included in every manifestHash computation.
 */
export interface ContextPolicy {
  policyHash: string;
  /** Sensitivity levels that are unconditionally excluded. */
  deniedSensitivities: ContextSensitivity[];
  /** Trust levels that are unconditionally excluded. */
  deniedTrustLevels: ContextTrust[];
  /** Behaviour when required objects alone exceed budget. */
  requiredOverBudgetAction: "explicit_escalation" | "fail_closed";
  /** Maximum allowed compiler wall-clock duration in ms. */
  maxCompilerDurationMs: number;
  /** Maximum overhead ratio: compilationDurationMs / totalRenderedTokens. */
  maxOverheadRatio: number;
}
