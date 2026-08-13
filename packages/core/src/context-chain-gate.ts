/**
 * Context Chain Gate — C1
 *
 * Converts chain verification evidence into a merge-gate decision and
 * a PR comment (Infracost-style). Two things hard-fail. Everything else
 * is configurable or comment-only.
 *
 * Hard failures (always block merge):
 *   1. no_governance_receipt — no receipt at all
 *   2. tamper_detected       — receipt hash does not match producer run
 *
 * Configurable gate (team decides; default: warn only):
 *   3. verifier_failed — unverified claims, incomplete integrity,
 *                        missing artifacts, unresolved assumptions
 *
 * Comment-only (never block, always visible):
 *   - Cost: actual vs budget — money is already spent, blocking adds friction
 *   - Chain lineage: chainId, producerRunId, consumerRunId
 *   - Integrity state
 *
 * Standing rules:
 *   - Pure functions, no side effects.
 *   - evaluateChainGate never reads environment variables or config files.
 *   - renderGatePrComment produces valid GitHub-flavored markdown.
 *   - No fake data, no placeholder behaviour.
 */

import type { ContextHandoffReceipt } from "@martin/contracts";
import type { ChainIntegrityState, ContextHandoffVerification } from "@martin/contracts";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface ChainGateConfig {
  /**
   * When true, a failed verifier (unverified claims, incomplete integrity,
   * missing artifacts, unresolved assumptions) blocks the merge.
   * Default: false — warn in PR comment, do not block.
   */
  blockOnVerifierFailure: boolean;
}

const DEFAULT_CONFIG: ChainGateConfig = {
  blockOnVerifierFailure: false
};

// ─── Inputs ───────────────────────────────────────────────────────────────────

export interface ChainGateCost {
  actualUsd: number;
  budgetUsd: number;
}

export interface ChainGateInput {
  /** null means no receipt was provided — triggers the hard no_governance_receipt failure. */
  receipt: ContextHandoffReceipt | null;
  /** null when receipt is null. Must be provided when receipt is non-null. */
  verification: ContextHandoffVerification | null;
  cost?: ChainGateCost;
  config?: Partial<ChainGateConfig>;
}

// ─── Result ───────────────────────────────────────────────────────────────────

export type ChainGateConclusion = "failure" | "neutral" | "success";

export interface ChainGateResult {
  // Hard failures (always block)
  noGovernance: boolean;
  tamperDetected: boolean;
  // Configurable gate
  verifierFailed: boolean;
  // Derived decision
  shouldBlock: boolean;
  conclusion: ChainGateConclusion;
  failureReasonCode?: string;
  failureMessage?: string;
  // Cost — comment-only, never a block signal
  cost?: ChainGateCost & { exceeded: boolean };
  // Integrity state for display
  integrity: ChainIntegrityState | "absent";
}

// ─── Gate evaluation ─────────────────────────────────────────────────────────

/**
 * Evaluates whether the chain gate should block merge, and assembles
 * the data needed for the PR comment.
 *
 * Call order:
 *   1. Check for missing receipt (hard fail).
 *   2. Check for tamper_detected integrity (hard fail).
 *   3. Check verifier result against config (configurable gate).
 *   4. Return success / neutral with full comment data.
 */
export function evaluateChainGate(input: ChainGateInput): ChainGateResult {
  const config: ChainGateConfig = { ...DEFAULT_CONFIG, ...input.config };

  const costResult =
    input.cost !== undefined
      ? { ...input.cost, exceeded: input.cost.actualUsd > input.cost.budgetUsd }
      : undefined;

  // ── Hard fail 1: no governance receipt ───────────────────────────────────
  if (input.receipt === null || input.verification === null) {
    return {
      noGovernance: true,
      tamperDetected: false,
      verifierFailed: false,
      shouldBlock: true,
      conclusion: "failure",
      failureReasonCode: "no_governance_receipt",
      failureMessage:
        "No MartinLoop governance receipt was found for this run. " +
        "Every AI-authored PR must carry a verified governance receipt.",
      integrity: "absent",
      ...(costResult !== undefined ? { cost: costResult } : {})
    };
  }

  const integrity = input.verification.integrity;

  // ── Hard fail 2: tampered receipt ─────────────────────────────────────────
  if (integrity === "tamper_detected") {
    return {
      noGovernance: false,
      tamperDetected: true,
      verifierFailed: false,
      shouldBlock: true,
      conclusion: "failure",
      failureReasonCode: "tamper_detected",
      failureMessage:
        "Governance receipt integrity check failed: tamper detected. " +
        "The receipt hash does not match the producer run record.",
      integrity,
      ...(costResult !== undefined ? { cost: costResult } : {})
    };
  }

  // ── Configurable gate: verifier failed ───────────────────────────────────
  const verifierFailed = !input.verification.ok;
  const blockOnVerifier = verifierFailed && config.blockOnVerifierFailure;

  if (blockOnVerifier) {
    const first = input.verification.reasons[0];
    return {
      noGovernance: false,
      tamperDetected: false,
      verifierFailed: true,
      shouldBlock: true,
      conclusion: "failure",
      failureReasonCode: first?.code ?? "verifier_failed",
      failureMessage: first?.message ?? "Context chain verification failed.",
      integrity,
      ...(costResult !== undefined ? { cost: costResult } : {})
    };
  }

  // ── Pass (or warn-only verifier failure) ──────────────────────────────────
  return {
    noGovernance: false,
    tamperDetected: false,
    verifierFailed,
    shouldBlock: false,
    conclusion: verifierFailed ? "neutral" : "success",
    integrity,
    ...(costResult !== undefined ? { cost: costResult } : {})
  };
}

// ─── PR comment renderer ─────────────────────────────────────────────────────

export interface GatePrCommentOptions {
  runId?: string;
  chainId?: string;
  handoffId?: string;
  producerRunId?: string;
  prNumber?: number;
  headSha?: string;
}

/**
 * Renders an Infracost-style GitHub PR comment summarising the gate result.
 *
 * Hard failures and cost overruns are shown prominently.
 * Cost is always present when provided — never omitted, never a blocking signal.
 * Lineage fields (chainId, producerRunId, runId) provide audit trail links.
 */
export function renderGatePrComment(
  result: ChainGateResult,
  options: GatePrCommentOptions = {}
): string {
  const lines: string[] = [];

  lines.push("## MartinLoop Governance");
  lines.push("");

  // Status headline
  if (result.noGovernance) {
    lines.push("🚫 **No governance receipt** — merge is blocked.");
  } else if (result.tamperDetected) {
    lines.push("🚫 **Tampered receipt** — merge is blocked.");
  } else if (result.verifierFailed && result.shouldBlock) {
    lines.push("⚠️ **Verifier failed** — merge is blocked (configured as required).");
  } else if (result.verifierFailed) {
    lines.push("⚠️ **Verifier warnings** — merge is permitted, review recommended.");
  } else {
    lines.push("✅ **Governance verified** — chain integrity confirmed.");
  }

  lines.push("");
  lines.push("| Signal | Value | Status |");
  lines.push("|--------|-------|--------|");

  // Chain integrity
  const integrityIcon =
    result.integrity === "verified"
      ? "✅"
      : result.integrity === "absent" || result.integrity === "tamper_detected"
        ? "🚫"
        : "⚠️";
  lines.push(`| Chain integrity | \`${result.integrity}\` | ${integrityIcon} |`);

  // Cost — always comment-only, never a block signal
  if (result.cost !== undefined) {
    const { actualUsd, budgetUsd, exceeded } = result.cost;
    const costIcon = exceeded ? "⚠️" : "✅";
    const delta = actualUsd - budgetUsd;
    const costNote = exceeded
      ? `over budget (+$${delta.toFixed(4)})`
      : "within budget";
    lines.push(
      `| Cost | \`$${actualUsd.toFixed(4)}\` / \`$${budgetUsd.toFixed(4)}\` | ${costIcon} ${costNote} |`
    );
  }

  // Lineage (audit trail, never a block signal)
  if (options.chainId) {
    lines.push(`| Chain ID | \`${options.chainId}\` | ℹ️ |`);
  }
  if (options.handoffId) {
    lines.push(`| Handoff ID | \`${options.handoffId}\` | ℹ️ |`);
  }
  if (options.producerRunId) {
    lines.push(`| Producer run | \`${options.producerRunId}\` | ℹ️ |`);
  }
  if (options.runId) {
    lines.push(`| Consumer run | \`${options.runId}\` | ℹ️ |`);
  }

  // Failure detail
  if (result.failureMessage) {
    lines.push("");
    lines.push(`> **Failure:** ${result.failureMessage}`);
  }

  lines.push("");
  lines.push(
    "_Powered by [MartinLoop](https://github.com/Keesan12/martin-loop) governance gate_"
  );

  return lines.join("\n");
}
