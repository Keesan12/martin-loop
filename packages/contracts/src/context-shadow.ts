/**
 * Context Shadow — A-CTX-0 schema contracts.
 *
 * Shadow mode observes the existing prompt without altering it.
 * No source text is retained in manifests or receipts — only hashes and counts.
 */

export const CONTEXT_SHADOW_MANIFEST_VERSION =
  "context-shadow-manifest/1" as const;

export const CONTEXT_C5_VERSION = "context-c5/1" as const;

export type ContextEvidence =
  | "observed"
  | "configured"
  | "inferred"
  | "unknown";

export type ContextShadowSegmentKind =
  | "system"
  | "mission"
  | "task"
  | "workspace"
  | "diagnostic"
  | "tool"
  | "other";

export interface ContextShadowSegmentInput {
  segmentId: string;
  kind: ContextShadowSegmentKind;
  required: boolean;
  text: string;
}

export interface ContextShadowDecisionV1 {
  segmentId: string;
  kind: string;
  /** SHA-256 of segment.text — never the source text itself. */
  contentHash: string;
  estimatedTokens: number;
  /** Always true in shadow mode — actual prompt is never altered. */
  actuallyIncluded: true;
  /** What the shadow compiler would have decided if it controlled selection. */
  proposedDecision: "included" | "excluded";
  reason:
    | "required"
    | "within_shadow_budget"
    | "shadow_budget_exhausted"
    | "required_over_budget";
}

export interface ContextShadowManifestV1 {
  schemaVersion: typeof CONTEXT_SHADOW_MANIFEST_VERSION;
  manifestId: string;
  /** SHA-256 of the canonical JSON of the manifest (excluding manifestId and manifestHash). */
  manifestHash: string;
  /** SHA-256 of the canonical compiler input, for cross-run determinism checks. */
  compilerInputHash: string;
  runId: string;
  taskId?: string;
  adapter: string;
  model?: string;
  capturedAt: string;
  mode: "shadow";
  modelWindowTokens: number | null;
  modelWindowEvidence: ContextEvidence;
  shadowBudgetTokens: number;
  /** SHA-256 of framed source segments — confirms prompt identity without storing content. */
  actualPromptHash: string;
  /** Estimated token count of all segments (actual prompt). */
  actualEstimatedTokens: number;
  /** Estimated token count of shadow-selected segments only. */
  proposedEstimatedTokens: number;
  /** True if required segments alone exceed shadowBudgetTokens. */
  requiredOverBudget: boolean;
  decisions: ContextShadowDecisionV1[];
}

export interface ContextC5EnvelopeV1 {
  schemaVersion: typeof CONTEXT_C5_VERSION;
  resource: "context";
  event: "shadow_compiled";
  runId: string;
  taskId?: string;
  manifestId: string;
  manifestHash: string;
  adapter: string;
  model?: string;
  mode: "shadow";
  actualEstimatedTokens: number;
  proposedEstimatedTokens: number;
  candidateCount: number;
  includedCount: number;
  excludedCount: number;
  requiredOverBudget: boolean;
  modelWindowTokens: number | null;
  modelWindowEvidence: ContextEvidence;
  createdAt: string;
}
