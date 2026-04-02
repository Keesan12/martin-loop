import type { LoopTask } from "@martin/contracts";

export interface SafetyLeashDecision {
  allowed: boolean;
  riskLevel: "safe" | "blocked";
  blockedCommands: string[];
  reason?: string;
}

const BLOCKED_PATTERNS: RegExp[] = [
  /(^|\s)rm\s+-rf(\s|$)/u,
  /git\s+reset\s+--hard/iu,
  /git\s+clean\s+-fd/iu,
  /curl\b[^\n|]*\|\s*(sh|bash)/iu,
  /wget\b[^\n|]*\|\s*(sh|bash)/iu,
  /(^|\s)sudo(\s|$)/u,
  /(^|\s)mkfs(\.|\s|$)/u,
  /(^|\s)dd\s+if=/u,
  /(shutdown|reboot)(\s|$)/iu,
  /:\(\)\{:\|:&\};:/u,
  /chmod\s+-R\s+777\s+\//iu,
  /(kubectl|docker)\s+.*\b(delete|prune|rm)\b/iu,
  /ssh\s+/iu,
  /scp\s+/iu
];

export function evaluateVerificationLeash(
  task: Pick<LoopTask, "verificationPlan" | "verificationStack">
): SafetyLeashDecision {
  const commands = [
    ...(task.verificationPlan ?? []),
    ...((task.verificationStack ?? []).map((step) => step.command))
  ].filter(Boolean);

  const blockedCommands = commands.filter((command) =>
    BLOCKED_PATTERNS.some((pattern) => pattern.test(command))
  );

  if (blockedCommands.length > 0) {
    return {
      allowed: false,
      riskLevel: "blocked",
      blockedCommands,
      reason: "Safety leash blocked destructive or unbounded verifier commands."
    };
  }

  return {
    allowed: true,
    riskLevel: "safe",
    blockedCommands: []
  };
}
