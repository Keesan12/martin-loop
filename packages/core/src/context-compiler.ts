/**
 * Context Compiler — A-CTX-1
 *
 * Deterministic working-set selector. Given a set of ContextObject candidates,
 * a budget, a policy, and an explicit nowMs, produces a ContextManifest whose
 * hash is identical for identical inputs on any platform.
 *
 * Shadow mode: the manifest is computed and emitted but the original provider
 * packet is returned byte-for-byte unchanged.
 *
 * Standing invariants:
 *   - nowMs is ALWAYS a captured input — never Date.now() internally
 *   - No raw source text in manifest or ledger receipt — hashes and counts only
 *   - No confidence float, no outcome_delta — both permanently banned
 *   - Fault budget accumulates by taskId, not runId
 *   - required-over-budget is an explicit failure, never a silent drop
 *   - MAX_RENDER_PASSES = 5 — hard constant
 */

import { createHash } from "node:crypto";

import type {
  ContextBudget,
  ContextCandidateDecision,
  ContextLedgerEntry,
  ContextManifest,
  ContextObject,
  ContextPolicy
} from "@martin/contracts";
import { CONTEXT_LEDGER_VERSION, CONTEXT_MANIFEST_VERSION } from "@martin/contracts";

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_RENDER_PASSES = 5;

// ─── Adapter interface ────────────────────────────────────────────────────────

/**
 * Minimal adapter interface for token recounting.
 * Implementations may call the provider SDK's token counter.
 * Must not make network calls to the provider inference endpoint.
 */
export interface ContextAdapter {
  readonly version: string;
  /** Recount the actual rendered tokens for a serialized text segment. */
  recountTokens(text: string): number;
}

/** Fallback adapter: char÷4 heuristic, no external calls. */
export const HEURISTIC_ADAPTER: ContextAdapter = {
  version: "heuristic@1",
  recountTokens: (text: string) =>
    text.length === 0 ? 0 : Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4))
};

// ─── Inputs / outputs ─────────────────────────────────────────────────────────

export interface CompileContextInput {
  taskId: string;
  runId: string;
  /** Must be a captured value — never call Date.now() inside the compiler. */
  nowMs: number;
  candidates: readonly ContextObject[];
  budget: ContextBudget;
  policy: ContextPolicy;
  adapter: ContextAdapter;
}

export type CompileContextOutput =
  | { ok: true; manifest: ContextManifest; ledgerEntry: ContextLedgerEntry }
  | { ok: false; reason: "required_over_budget" | "recount_exceeded_passes"; manifest: null; ledgerEntry: null };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
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

/** Priority order for selection: required → pinned → high → normal → low */
const PRIORITY_RANK: Record<ContextObject["priority"], number> = {
  required: 0,
  high: 2,
  normal: 3,
  low: 4
};

/** Pinned objects slot between required and high. */
function selectionRank(obj: ContextObject): number {
  if (obj.priority === "required") return 0;
  if (obj.pinnedBy !== undefined) return 1;
  return PRIORITY_RANK[obj.priority];
}

// ─── Compiler ────────────────────────────────────────────────────────────────

export function compileContext(input: CompileContextInput): CompileContextOutput {
  const { taskId, runId, nowMs, candidates, budget, policy, adapter } = input;

  // ── Eligibility filter — policy-denied objects become governed exclusion records ──
  //
  // A-CTX-2 fix: denied objects must NOT silently disappear. They enter decisions[]
  // as "excluded" with a reason code so the exclusion is visible as governed evidence.
  // executableContext = admittedObjects only; ledgerDecisions = admitted + excluded.
  const policyExcluded: ContextCandidateDecision[] = [];
  const eligibleList: ContextObject[] = [];

  for (const obj of candidates) {
    if (policy.deniedSensitivities.includes(obj.sensitivity)) {
      policyExcluded.push({
        objectId: obj.id,
        decision: "excluded",
        reason: `sensitivity_denied:${obj.sensitivity}`
      });
    } else if (policy.deniedTrustLevels.includes(obj.trust)) {
      policyExcluded.push({
        objectId: obj.id,
        decision: "excluded",
        reason: `trust_denied:${obj.trust}`
      });
    } else {
      eligibleList.push(obj);
    }
  }
  const eligible = eligibleList;

  // ── Compute compilerInputHash ────────────────────────────────────────────
  const inputFingerprint = {
    taskId,
    runId,
    nowMs,
    adapterVersion: adapter.version,
    policyHash: policy.policyHash,
    budget: {
      modelWindowTokens: budget.modelWindowTokens,
      maxWorkingSetTokens: budget.maxWorkingSetTokens,
      pinnedTokensMax: budget.pinnedTokensMax
    },
    candidateIds: eligible.map((o) => o.id).sort()
  };

  // ── Pinned token cap ─────────────────────────────────────────────────────
  const pinnedTokensTotal = eligible
    .filter((o) => o.pinnedBy !== undefined)
    .reduce((s, o) => s + o.estimatedTokens, 0);

  if (pinnedTokensTotal > budget.pinnedTokensMax) {
    // Fail-closed: reject the entire batch, not individual pins
    return { ok: false, reason: "required_over_budget", manifest: null, ledgerEntry: null };
  }

  // ── Sort by selection rank, then objectId as stable tie-breaker ──────────
  const sorted = [...eligible].sort((a, b) => {
    const rankDiff = selectionRank(a) - selectionRank(b);
    if (rankDiff !== 0) return rankDiff;
    // Stable tie-breaker: objectId lexicographic
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // ── Selection pass ───────────────────────────────────────────────────────
  let remaining = budget.maxWorkingSetTokens;
  const decisions: ContextCandidateDecision[] = [];
  let requiredOverBudget = false;

  // Required objects total token check first
  const requiredTokens = sorted
    .filter((o) => o.priority === "required")
    .reduce((s, o) => s + o.estimatedTokens, 0);

  if (requiredTokens > remaining) {
    requiredOverBudget = true;
    if (policy.requiredOverBudgetAction === "fail_closed") {
      return { ok: false, reason: "required_over_budget", manifest: null, ledgerEntry: null };
    }
    // explicit_escalation: record and continue — all required marked excluded
  }

  for (const obj of sorted) {
    const isRequired = obj.priority === "required";

    if (requiredOverBudget && isRequired) {
      decisions.push({
        objectId: obj.id,
        decision: "excluded",
        reason: "required_over_budget"
      });
      continue;
    }

    if (obj.estimatedTokens <= remaining) {
      decisions.push({
        objectId: obj.id,
        decision: "included",
        reason: isRequired ? "required" : obj.pinnedBy !== undefined ? "pinned" : "within_budget"
      });
      remaining -= obj.estimatedTokens;
    } else {
      // Attempt truncation for required/pinned, exclude otherwise
      if (isRequired || obj.pinnedBy !== undefined) {
        decisions.push({
          objectId: obj.id,
          decision: "included_truncated",
          truncatedFromTokens: obj.estimatedTokens,
          reason: isRequired ? "required_truncated" : "pinned_truncated"
        });
        // Truncated objects consume whatever is left
        remaining = 0;
      } else {
        decisions.push({
          objectId: obj.id,
          decision: "excluded",
          reason: "budget_exhausted"
        });
      }
    }
  }

  // ── Adapter recount (up to MAX_RENDER_PASSES) ────────────────────────────
  const includedDecisions = decisions.filter(
    (d) => d.decision === "included" || d.decision === "included_truncated"
  );

  let totalRenderedTokens = 0;
  let renderPasses = 0;
  let recountConverged = false;

  const includedObjects = new Map(eligible.map((o) => [o.id, o]));

  for (let pass = 0; pass < MAX_RENDER_PASSES; pass++) {
    renderPasses = pass + 1;
    let passTotal = 0;

    for (const d of includedDecisions) {
      const obj = includedObjects.get(d.objectId);
      if (!obj) continue;
      // In shadow mode we use the contentHash as a proxy text for recounting
      const recounted = adapter.recountTokens(obj.contentHash);
      d.renderedTokens = recounted;
      passTotal += recounted;
    }

    if (passTotal === totalRenderedTokens && pass > 0) {
      recountConverged = true;
      break;
    }
    totalRenderedTokens = passTotal;
    if (pass === 0) recountConverged = false;
  }

  if (!recountConverged && renderPasses >= MAX_RENDER_PASSES) {
    return { ok: false, reason: "recount_exceeded_passes", manifest: null, ledgerEntry: null };
  }

  // ── Merge policy exclusions — excluded objects precede selection decisions ──
  //
  // A-CTX-2: executableContext = admittedObjects (decisions[]);
  //          ledgerDecisions   = [...policyExcluded, ...decisions]
  // Policy-excluded objects never enter the admitted working set, but their
  // exclusion is visible as governed evidence in the manifest and ledger.
  const allDecisions: ContextCandidateDecision[] = [...policyExcluded, ...decisions];

  // ── Manifest hash ────────────────────────────────────────────────────────
  const manifestHashInput = canonicalJson({
    adapterVersion: adapter.version,
    budget: inputFingerprint.budget,
    decisions: allDecisions.map((d) => ({
      decision: d.decision,
      objectId: d.objectId,
      reason: d.reason,
      ...(d.truncatedFromTokens !== undefined
        ? { truncatedFromTokens: d.truncatedFromTokens }
        : {})
    })),
    nowMs,
    policyHash: policy.policyHash,
    runId,
    taskId,
    totalRenderedTokens
  });
  const manifestHash = sha256(manifestHashInput);

  const compilationDurationMs = 0; // In shadow mode: nowMs is frozen; duration is metadata-only

  const manifest: ContextManifest = {
    schemaVersion: CONTEXT_MANIFEST_VERSION,
    manifestHash,
    taskId,
    runId,
    nowMs,
    adapterVersion: adapter.version,
    policyHash: policy.policyHash,
    budget,
    decisions: allDecisions,
    totalRenderedTokens,
    renderPasses,
    compilationDurationMs
  };

  const totalIncluded = allDecisions.filter(
    (d) => d.decision === "included" || d.decision === "included_truncated"
  ).length;
  const totalExcluded = allDecisions.filter((d) => d.decision === "excluded").length;
  const totalFaultLoaded = allDecisions.filter((d) => d.decision === "fault_loaded").length;

  const ledgerEntry: ContextLedgerEntry = {
    schemaVersion: CONTEXT_LEDGER_VERSION,
    entryType: "context",
    taskId,
    runId,
    manifestHash,
    totalIncluded,
    totalExcluded,
    totalFaultLoaded,
    overflowCount: requiredOverBudget ? 1 : 0,
    faultBudgetUsed: 0,
    adapterVersion: adapter.version
  };

  return { ok: true, manifest, ledgerEntry };
}
