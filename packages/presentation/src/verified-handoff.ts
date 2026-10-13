import type {
  CostProvenance,
  EvidenceStatus,
  VerifiedHandoffOutcome,
  VerifiedHandoffV1,
} from "@martin/contracts";

import { renderTable } from "./table.js";
import { horizontalRule, terminalWidth, truncateVisible } from "./text.js";
import {
  bold,
  paint,
  type MartinTone,
  type RenderEnvironment,
} from "./theme.js";

export interface VerifiedHandoffRenderOptions {
  readonly width?: number;
  readonly environment?: RenderEnvironment;
}

function outcomeTone(outcome: VerifiedHandoffOutcome): MartinTone {
  if (outcome === "VERIFIED") {
    return "success";
  }
  if (outcome === "STOPPED") {
    return "danger";
  }
  return "warning";
}

function evidenceTone(status: EvidenceStatus): MartinTone {
  if (status === "PASSED") {
    return "success";
  }
  if (status === "FAILED" || status === "CONTRADICTED") {
    return "danger";
  }
  return "warning";
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").toLowerCase();
}

function checkSymbol(status: EvidenceStatus): string {
  if (status === "PASSED") {
    return "✓";
  }
  if (status === "FAILED" || status === "CONTRADICTED") {
    return "✕";
  }
  return "•";
}

function formatCost(usd: number, provenance: CostProvenance): string {
  if (provenance === "unavailable") return "unavailable";
  const amount = "$" + usd.toFixed(2);
  if (provenance === "actual") return amount + " provider-settled actual";
  if (provenance === "calculated") return amount + " calculated from observed usage";
  return amount + " estimated";
}

/**
 * Single source of truth for the trust-authority outcome calculation.
 * Both terminal and Markdown renderers call this — never duplicate.
 * Fail-closed: omitting executionMode or governanceClaimEligible downgrades
 * VERIFIED → NEEDS_REVIEW, so legacy handoffs cannot claim full governance.
 */
function resolveHandoffAuthority(handoff: VerifiedHandoffV1): {
  executionMode: string;
  governanceClaimEligible: boolean;
  effectiveOutcome: VerifiedHandoffOutcome;
} {
  const executionMode = handoff.executionMode ?? "simulated";
  const governanceClaimEligible =
    executionMode === "governed" && handoff.governanceClaimEligible === true;
  const lifecycleTruth = handoff.lifecycleTruth;
  const canonicalEvidenceSupportsVerified =
    governanceClaimEligible &&
    handoff.sourceStatus.status === "completed" &&
    handoff.sourceStatus.lifecycleState === "completed" &&
    lifecycleTruth !== undefined &&
    lifecycleTruth.evidenceAvailable === true &&
    lifecycleTruth.terminationClass === "operational_exit" &&
    lifecycleTruth.reasonCode === "goal_met" &&
    handoff.fileEffects !== undefined &&
    handoff.verification.status === "PASSED" &&
    handoff.verification.checks.length > 0 &&
    handoff.verification.checks.every((check) => check.status === "PASSED") &&
    handoff.receiptIntegrity.state === "verified" &&
    handoff.unresolvedWork.length === 0;
  const effectiveOutcome: VerifiedHandoffOutcome =
    handoff.outcome === "VERIFIED" && !canonicalEvidenceSupportsVerified
      ? "NEEDS_REVIEW"
      : handoff.outcome;
  return { executionMode, governanceClaimEligible, effectiveOutcome };
}

function formatExecution(handoff: VerifiedHandoffV1): string {
  return `${humanize(handoff.sourceStatus.status)} / ${humanize(handoff.sourceStatus.lifecycleState)}`;
}

function formatTerminationReason(handoff: VerifiedHandoffV1): string {
  const truth = handoff.lifecycleTruth;
  if (!truth?.evidenceAvailable) return "unavailable";
  if (!truth.reasonCode) return truth.terminationClass === "none" ? "none" : "unknown";
  return `${humanize(truth.reasonCode)}${truth.reason ? `: ${truth.reason}` : ""}`;
}

function formatExhaustedLimits(handoff: VerifiedHandoffV1): string {
  const truth = handoff.lifecycleTruth;
  if (!truth?.evidenceAvailable) return "unavailable";
  return truth.exhaustedLimits.length > 0
    ? truth.exhaustedLimits.map(humanize).join(", ")
    : "none";
}

function formatFileEffectList(
  handoff: VerifiedHandoffV1,
  field: "touchedDuringExecution" | "netChangedAtCompletion" | "revertedBeforeCompletion",
): string {
  const effects = handoff.fileEffects;
  if (!effects || effects.observationStatus === "unavailable") return "unavailable";
  return effects[field].length > 0 ? effects[field].join(", ") : "none";
}

export function renderVerifiedHandoff(
  handoff: VerifiedHandoffV1,
  options: VerifiedHandoffRenderOptions = {},
): string {
  const environment = options.environment ?? {};
  const width = terminalWidth(options.width);
  const bounded = (line: string): string => truncateVisible(line, width);
  const { executionMode, governanceClaimEligible, effectiveOutcome } =
    resolveHandoffAuthority(handoff);
  const outcome = effectiveOutcome.replace("_", " ");
  const labelWidth = 30;
  const checks = handoff.verification.checks.map((check) => ({
    check: check.command,
    status: paint(
      checkSymbol(check.status) + " " + check.status.replace("_", " "),
      evidenceTone(check.status),
      environment,
    ),
  }));

  const lines = [
    horizontalRule(width, "━"),
    bold("MARTINLOOP VERIFIED HANDOFF", environment) +
      " — " +
      paint(outcome, outcomeTone(effectiveOutcome), environment),
    horizontalRule(width, "━"),
    "",
    bounded("Task".padEnd(labelWidth) + handoff.task.objective),
    bounded("Run".padEnd(labelWidth) + handoff.loopId),
    bounded("Execution Mode".padEnd(labelWidth) + executionMode.replaceAll("_", " ")),
    bounded("Governed Claim".padEnd(labelWidth) + (governanceClaimEligible ? "ELIGIBLE" : "INELIGIBLE")),
    bounded("Execution".padEnd(labelWidth) + formatExecution(handoff)),
    bounded(
      "Verification".padEnd(labelWidth) + handoff.verification.status.replace("_", " "),
    ),
    bounded("Receipt Integrity".padEnd(labelWidth) + handoff.receiptIntegrity.state),
    bounded("Termination Reason".padEnd(labelWidth) + formatTerminationReason(handoff)),
    bounded("Exhausted Limits".padEnd(labelWidth) + formatExhaustedLimits(handoff)),
    bounded("Touched During Execution".padEnd(labelWidth) + formatFileEffectList(handoff, "touchedDuringExecution")),
    bounded("Net Changed at Completion".padEnd(labelWidth) + formatFileEffectList(handoff, "netChangedAtCompletion")),
    bounded("Reverted Before Completion".padEnd(labelWidth) + formatFileEffectList(handoff, "revertedBeforeCompletion")),
    bounded("Scope".padEnd(labelWidth) + handoff.scope.status.replaceAll("_", " ")),
    bounded("Test Integrity".padEnd(labelWidth) + handoff.testIntegrity.verdict),
    bounded("Attempts".padEnd(labelWidth) + handoff.usage.attempts),
    bounded(
      "Cost".padEnd(labelWidth) +
        formatCost(handoff.usage.actualUsd, handoff.usage.costProvenance),
    ),
  ];

  if (checks.length > 0) {
    lines.push(
      "",
      bold("VERIFICATION EVIDENCE", environment),
      renderTable(
        checks,
        [
          { header: "CHECK", value: (row) => row.check, minWidth: 24 },
          { header: "STATUS", value: (row) => row.status, minWidth: 18 },
        ],
        width,
      ),
    );
  }

  if (handoff.stopReason) {
    lines.push(
      "",
      bold("STOP REASON", environment),
      bounded("  " + paint(humanize(handoff.stopReason), "danger", environment)),
    );
  }

  lines.push("", bold("UNRESOLVED", environment));
  if (handoff.unresolvedWork.length === 0) {
    lines.push("  None recorded.");
  } else {
    lines.push(...handoff.unresolvedWork.map((item) => bounded("  - " + item)));
  }

  lines.push(
    "",
    bold("RECOVERY", environment),
    bounded("  " + handoff.recovery.summary),
    "",
    bold("NEXT", environment),
    bounded("  " + handoff.nextAction),
    horizontalRule(width, "━"),
  );

  return lines.map(bounded).join("\n");
}

/**
 * Renders a VerifiedHandoffV1 as plain Markdown (no ANSI).
 *
 * CRITICAL: replicates the exact effectiveOutcome trust-authority check from
 * renderVerifiedHandoff so that CLI and MCP surfaces always agree on
 * VERIFIED / NEEDS REVIEW / STOPPED for the same input.
 */
export function renderVerifiedHandoffMarkdown(
  handoff: VerifiedHandoffV1,
  options: VerifiedHandoffRenderOptions = {},
): string {
  void options; // width/environment unused in plain Markdown
  const { executionMode, governanceClaimEligible, effectiveOutcome } =
    resolveHandoffAuthority(handoff);
  const outcome = effectiveOutcome.replace("_", " ");

  const lines: string[] = [
    `## MartinLoop Verified Handoff — ${outcome}`,
    "",
    "| Field | Value |",
    "|-------|-------|",
    `| Task | ${handoff.task.objective} |`,
    `| Run | ${handoff.loopId} |`,
    `| Execution Mode | ${executionMode.replaceAll("_", " ")} |`,
    `| Governed Claim | ${governanceClaimEligible ? "ELIGIBLE" : "INELIGIBLE"} |`,
    `| Execution | ${formatExecution(handoff)} |`,
    `| Verification | ${handoff.verification.status.replace("_", " ")} |`,
    `| Receipt Integrity | ${handoff.receiptIntegrity.state} |`,
    `| Termination Reason | ${formatTerminationReason(handoff)} |`,
    `| Exhausted Limits | ${formatExhaustedLimits(handoff)} |`,
    `| Touched During Execution | ${formatFileEffectList(handoff, "touchedDuringExecution")} |`,
    `| Net Changed at Completion | ${formatFileEffectList(handoff, "netChangedAtCompletion")} |`,
    `| Reverted Before Completion | ${formatFileEffectList(handoff, "revertedBeforeCompletion")} |`,
    `| Scope | ${handoff.scope.status.replaceAll("_", " ")} |`,
    `| Test Integrity | ${handoff.testIntegrity.verdict} |`,
    `| Attempts | ${handoff.usage.attempts} |`,
    `| Cost | ${formatCost(handoff.usage.actualUsd, handoff.usage.costProvenance)} |`,
  ];

  if (handoff.verification.checks.length > 0) {
    lines.push(
      "",
      "### Verification Evidence",
      "",
      "| Check | Status |",
      "|-------|--------|",
      ...handoff.verification.checks.map(
        (check) =>
          `| ${check.command} | ${checkSymbol(check.status)} ${check.status.replace("_", " ")} |`,
      ),
    );
  }

  if (handoff.stopReason) {
    lines.push(
      "",
      "### Stop Reason",
      "",
      handoff.stopReason.replaceAll("_", " ").toLowerCase(),
    );
  }

  lines.push("", "### Unresolved");
  if (handoff.unresolvedWork.length === 0) {
    lines.push("", "None recorded.");
  } else {
    lines.push("", ...handoff.unresolvedWork.map((item) => `- ${item}`));
  }

  lines.push(
    "",
    "### Recovery",
    "",
    handoff.recovery.summary,
    "",
    "### Next",
    "",
    handoff.nextAction,
  );

  return lines.join("\n");
}
