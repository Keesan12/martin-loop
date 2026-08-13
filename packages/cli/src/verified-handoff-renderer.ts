// SPDX-FileCopyrightText: MartinLoop contributors
// SPDX-License-Identifier: Apache-2.0

import type { VerifiedHandoffV1 } from "@martin/contracts";

const WIDTH = 72;

export function renderVerifiedHandoffHuman(handoff: VerifiedHandoffV1): string {
  const divider = "=".repeat(WIDTH);
  const checks = handoff.verification.checks.length
    ? handoff.verification.checks.map(
        (c) => `  ${symbol(c.status)} ${c.command} — ${c.status}`
      )
    : ["  · No individual verification steps were recorded."];

  const unresolved = handoff.unresolvedWork.length
    ? handoff.unresolvedWork.map((item) => `  - ${item}`)
    : ["  - None recorded."];

  return [
    divider,
    ` MARTINLOOP VERIFIED HANDOFF — ${handoff.outcome}`,
    divider,
    `Task: ${handoff.task.objective}`,
    `Run: ${handoff.loopId}`,
    `Verification: ${handoff.verification.status}`,
    ...checks,
    `Scope: ${handoff.scope.status}`,
    `Test Integrity: ${handoff.testIntegrity.verdict}`,
    `Attempts: ${handoff.usage.attempts}`,
    `Cost: $${handoff.usage.actualUsd.toFixed(2)} (${handoff.usage.costProvenance})`,
    "Unresolved:",
    ...unresolved,
    `Recovery: ${handoff.recovery.summary}`,
    `Next: ${handoff.nextAction}`,
    divider,
  ].join("\n");
}

function symbol(status: string): string {
  if (status === "PASSED") return "✓";
  if (status === "FAILED" || status === "CONTRADICTED") return "✕";
  return "·";
}
