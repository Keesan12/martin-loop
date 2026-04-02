import type { LoopAttempt, LoopTask } from "@martin/contracts";

// ─── Adapter request type (minimal, for the compiler) ────────────────────────

/**
 * The subset of MartinAdapterRequest fields needed by the prompt packet
 * compiler. Defined here (not in index.ts) to avoid circular imports:
 *   index.ts → ./persistence/index.js → ./persistence/compiler.js → ./compiler.js (no cycle)
 */
export interface CompilerAdapterRequest {
  loopId: string;
  attemptId: string;
  context: {
    taskTitle: string;
    objective: string;
    verificationPlan: string[];
    verificationStack?: LoopTask["verificationStack"];
    repoRoot?: string;
    allowedPaths?: string[];
    deniedPaths?: string[];
    acceptanceCriteria?: string[];
    focus: string;
    remainingBudgetUsd: number;
    remainingIterations: number;
    remainingTokens: number;
  };
  previousAttempts: LoopAttempt[];
}

// ─── PromptPacket ─────────────────────────────────────────────────────────────

export interface PromptPacket {
  loopId: string;
  attemptNumber: number;
  contract: {
    objective: string;
    verificationPlan: string[];
    allowedPaths?: string[];
    deniedPaths?: string[];
    acceptanceCriteria?: string[];
  };
  /** Prior failure/intervention pairs as "failureClass:intervention" strings. */
  priorFailurePatterns: string[];
  guidance: string;
  budgetEnvelope: {
    remainingBudgetUsd: number;
    remainingIterations: number;
    remainingTokens: number;
  };
}

/**
 * Compiles a deterministic PromptPacket from a MartinAdapterRequest.
 * This is the context compiler — takes structured request state and produces
 * a reconstructable packet (no chat history required).
 */
export function compilePromptPacket(request: CompilerAdapterRequest): PromptPacket {
  const priorFailurePatterns = request.previousAttempts
    .filter((a) => a.failureClass && a.intervention)
    .map((a) => `${a.failureClass}:${a.intervention}`);

  const guidanceParts: string[] = [
    "Only modify files directly required to satisfy the contract.",
    "Do not touch files outside the allowed paths."
  ];

  if (request.context.allowedPaths && request.context.allowedPaths.length > 0) {
    guidanceParts.push(
      `Allowed paths: ${request.context.allowedPaths.join(", ")}.`
    );
  }

  if (request.context.deniedPaths && request.context.deniedPaths.length > 0) {
    guidanceParts.push(
      `Denied paths (never touch): ${request.context.deniedPaths.join(", ")}.`
    );
  }

  if (priorFailurePatterns.length > 0) {
    guidanceParts.push(
      `Prior failure patterns: ${priorFailurePatterns.join(", ")}. Adjust strategy accordingly.`
    );
  }

  return {
    loopId: request.loopId,
    attemptNumber: request.previousAttempts.length + 1,
    contract: {
      objective: request.context.objective,
      verificationPlan: request.context.verificationPlan,
      ...(request.context.allowedPaths ? { allowedPaths: request.context.allowedPaths } : {}),
      ...(request.context.deniedPaths ? { deniedPaths: request.context.deniedPaths } : {}),
      ...(request.context.acceptanceCriteria
        ? { acceptanceCriteria: request.context.acceptanceCriteria }
        : {})
    },
    priorFailurePatterns,
    guidance: guidanceParts.join(" "),
    budgetEnvelope: {
      remainingBudgetUsd: request.context.remainingBudgetUsd,
      remainingIterations: request.context.remainingIterations,
      remainingTokens: request.context.remainingTokens
    }
  };
}
