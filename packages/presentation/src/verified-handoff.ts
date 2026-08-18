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

function formatCost(usd: number, provenance: CostProvenance): string {
  if (provenance === "unavailable") {
    return "unavailable";
  }

  const amount = "$" + usd.toFixed(2);
  if (provenance === "actual") {
    return amount + " provider-settled actual";
  }
  if (provenance === "calculated") {
    return amount + " calculated from observed usage";
  }
  return amount + " estimated";
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

export function renderVerifiedHandoff(
  handoff: VerifiedHandoffV1,
  options: VerifiedHandoffRenderOptions = {},
): string {
  const environment = options.environment ?? {};
  const width = terminalWidth(options.width);
  const bounded = (line: string): string => truncateVisible(line, width);
  const executionMode = handoff.executionMode ?? "simulated";
  const governanceClaimEligible =
    executionMode === "governed" && handoff.governanceClaimEligible === true;
  const effectiveOutcome =
    handoff.outcome === "VERIFIED" && !governanceClaimEligible
      ? "NEEDS_REVIEW"
      : handoff.outcome;
  const outcome = effectiveOutcome.replace("_", " ");
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
    bounded("Task".padEnd(20) + handoff.task.objective),
    bounded("Run".padEnd(20) + handoff.loopId),
    bounded("Execution Mode".padEnd(20) + executionMode.replaceAll("_", " ")),
    bounded("Governed Claim".padEnd(20) + (governanceClaimEligible ? "ELIGIBLE" : "INELIGIBLE")),
    bounded(
      "Verification".padEnd(20) + handoff.verification.status.replace("_", " "),
    ),
    bounded("Scope".padEnd(20) + handoff.scope.status.replaceAll("_", " ")),
    bounded("Test Integrity".padEnd(20) + handoff.testIntegrity.verdict),
    bounded("Receipt Integrity".padEnd(20) + handoff.receiptIntegrity.state),
    bounded("Attempts".padEnd(20) + handoff.usage.attempts),
    bounded(
      "Cost".padEnd(20) +
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
