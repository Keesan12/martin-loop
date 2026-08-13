/**
 * Context Shadow Compiler — A-CTX-0
 *
 * Deterministic shadow manifest emitter. Observes the compiled prompt and
 * records what a context-aware selector would have chosen, without altering
 * the actual provider input in any way.
 *
 * Invariants:
 *   - nowMs is always a captured input; Date.now() is never called internally
 *   - No source text appears in any output type
 *   - Required segments are always preferred first
 *   - required-over-budget is recorded, never thrown
 *   - Manifest hash covers metadata only (no content)
 */

import { createHash } from "node:crypto";

import type {
  ContextC5EnvelopeV1,
  ContextEvidence,
  ContextShadowDecisionV1,
  ContextShadowManifestV1
} from "@martin/contracts";
import { CONTEXT_SHADOW_MANIFEST_VERSION, CONTEXT_C5_VERSION } from "@martin/contracts";

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface ContextShadowSegment {
  segmentId: string;
  kind: string;
  required: boolean;
  text: string;
}

export interface CompileContextShadowInput {
  runId: string;
  taskId?: string;
  adapter: string;
  model?: string;
  /** Milliseconds since epoch — must be explicit. Never call Date.now() here. */
  nowMs: number;
  shadowBudgetTokens: number;
  modelWindowTokens?: number;
  modelWindowEvidence?: ContextEvidence;
  segments: readonly ContextShadowSegment[];
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

export interface CompileContextShadowResult {
  manifest: ContextShadowManifestV1;
  receipt: ContextC5EnvelopeV1;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalize(v)])
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function estimateContextTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

// ─── Compiler ────────────────────────────────────────────────────────────────

export function compileContextShadow(
  input: CompileContextShadowInput
): CompileContextShadowResult {
  const { runId, adapter, nowMs, shadowBudgetTokens, segments } = input;

  // Validate: all segmentIds must be non-empty and unique
  const seen = new Set<string>();
  for (const seg of segments) {
    if (!seg.segmentId || seg.segmentId.trim() === "") {
      throw new Error("compileContextShadow: segmentId must be non-empty");
    }
    if (seen.has(seg.segmentId)) {
      throw new Error(
        `compileContextShadow: duplicate segmentId "${seg.segmentId}"`
      );
    }
    seen.add(seg.segmentId);
  }

  // Hash each segment's content — never expose the text itself
  const hashed = segments.map((seg) => ({
    segmentId: seg.segmentId,
    kind: seg.kind,
    required: seg.required,
    contentHash: sha256(seg.text),
    estimatedTokens: estimateContextTokens(seg.text)
  }));

  // Compute actualPromptHash from all segments in original order
  const actualPromptHash = sha256(
    canonicalJson(
      hashed.map((h) => ({ segmentId: h.segmentId, contentHash: h.contentHash }))
    )
  );

  const actualEstimatedTokens = hashed.reduce(
    (sum, h) => sum + h.estimatedTokens,
    0
  );

  // Compute compilerInputHash — includes nowMs for cross-run determinism
  const compilerInputHash = sha256(
    canonicalJson({
      adapter,
      nowMs,
      segments: hashed.map((h) => ({
        segmentId: h.segmentId,
        kind: h.kind,
        required: h.required,
        contentHash: h.contentHash,
        estimatedTokens: h.estimatedTokens
      })),
      shadowBudgetTokens,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.model === undefined ? {} : { model: input.model })
    })
  );

  // Shadow selection: required first (in original order), then optional
  const required = hashed.filter((h) => h.required);
  const optional = hashed.filter((h) => !h.required);

  let remaining = shadowBudgetTokens;
  const decisions: ContextShadowDecisionV1[] = [];

  // Required segments — always included even if over budget
  let requiredOverBudget = false;
  const requiredTokens = required.reduce((s, h) => s + h.estimatedTokens, 0);
  if (requiredTokens > shadowBudgetTokens) {
    requiredOverBudget = true;
  }

  for (const h of required) {
    const included = !requiredOverBudget;
    decisions.push({
      segmentId: h.segmentId,
      kind: h.kind,
      contentHash: h.contentHash,
      estimatedTokens: h.estimatedTokens,
      actuallyIncluded: true,
      proposedDecision: included ? "included" : "excluded",
      reason: requiredOverBudget ? "required_over_budget" : "required"
    });
    if (!requiredOverBudget) {
      remaining -= h.estimatedTokens;
    }
  }

  // Optional segments — include while budget remains
  for (const h of optional) {
    if (h.estimatedTokens <= remaining) {
      decisions.push({
        segmentId: h.segmentId,
        kind: h.kind,
        contentHash: h.contentHash,
        estimatedTokens: h.estimatedTokens,
        actuallyIncluded: true,
        proposedDecision: "included",
        reason: "within_shadow_budget"
      });
      remaining -= h.estimatedTokens;
    } else {
      decisions.push({
        segmentId: h.segmentId,
        kind: h.kind,
        contentHash: h.contentHash,
        estimatedTokens: h.estimatedTokens,
        actuallyIncluded: true,
        proposedDecision: "excluded",
        reason: "shadow_budget_exhausted"
      });
    }
  }

  // Restore original segment order in decisions list
  const orderMap = new Map(segments.map((s, i) => [s.segmentId, i]));
  decisions.sort(
    (a, b) => (orderMap.get(a.segmentId) ?? 0) - (orderMap.get(b.segmentId) ?? 0)
  );

  const proposedEstimatedTokens = decisions
    .filter((d) => d.proposedDecision === "included")
    .reduce((s, d) => s + d.estimatedTokens, 0);

  const capturedAt = new Date(nowMs).toISOString();
  const manifestId = sha256(`${runId}:${compilerInputHash}:${capturedAt}`);

  // Manifest hash covers metadata only — no content
  const manifestHashInput = canonicalJson({
    adapter,
    capturedAt,
    compilerInputHash,
    manifestId,
    mode: "shadow",
    modelWindowEvidence: input.modelWindowEvidence ?? "unknown",
    modelWindowTokens: input.modelWindowTokens ?? null,
    requiredOverBudget,
    runId,
    shadowBudgetTokens,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.model === undefined ? {} : { model: input.model })
  });
  const manifestHash = sha256(manifestHashInput);

  const includedCount = decisions.filter(
    (d) => d.proposedDecision === "included"
  ).length;
  const excludedCount = decisions.filter(
    (d) => d.proposedDecision === "excluded"
  ).length;

  const manifest: ContextShadowManifestV1 = {
    schemaVersion: CONTEXT_SHADOW_MANIFEST_VERSION,
    manifestId,
    manifestHash,
    compilerInputHash,
    runId,
    adapter,
    capturedAt,
    mode: "shadow",
    modelWindowTokens: input.modelWindowTokens ?? null,
    modelWindowEvidence: input.modelWindowEvidence ?? "unknown",
    shadowBudgetTokens,
    actualPromptHash,
    actualEstimatedTokens,
    proposedEstimatedTokens,
    requiredOverBudget,
    decisions,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.model === undefined ? {} : { model: input.model })
  };

  const receipt: ContextC5EnvelopeV1 = {
    schemaVersion: CONTEXT_C5_VERSION,
    resource: "context",
    event: "shadow_compiled",
    runId,
    manifestId,
    manifestHash,
    mode: "shadow",
    adapter,
    actualEstimatedTokens,
    proposedEstimatedTokens,
    candidateCount: decisions.length,
    includedCount,
    excludedCount,
    requiredOverBudget,
    modelWindowTokens: input.modelWindowTokens ?? null,
    modelWindowEvidence: input.modelWindowEvidence ?? "unknown",
    createdAt: capturedAt,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.model === undefined ? {} : { model: input.model })
  };

  return { manifest, receipt };
}
