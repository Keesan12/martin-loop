import {
  createClaudeCliAdapter,
  createCodexCliAdapter,
  createStubDirectProviderAdapter
} from "@martin/adapters";
import { runMartin } from "@martin/core";
import { DEFAULT_BUDGET, type LoopBudget } from "@martin/contracts";

export interface RunLoopInput {
  objective: string;
  workingDirectory?: string;
  engine?: "claude" | "codex";
  model?: string;
  maxUsd?: number;
  maxIterations?: number;
  maxTokens?: number;
  verificationPlan?: string[];
  workspaceId?: string;
  projectId?: string;
}

export interface RunLoopOutput {
  status: string;
  lifecycleState: string;
  reason: string;
  attempts: number;
  costUsd: number;
  verificationPassed: boolean;
  loopId: string;
}

export async function runLoopTool(input: RunLoopInput): Promise<RunLoopOutput> {
  const workingDirectory = input.workingDirectory ?? process.cwd();
  const engine = input.engine ?? "claude";
  const model = input.model;

  const adapter =
    process.env.MARTIN_LIVE === "false"
      ? createStubDirectProviderAdapter({ label: "Stub adapter (MARTIN_LIVE=false)", providerId: "stub", model: "stub" })
      : engine === "codex"
        ? createCodexCliAdapter({ workingDirectory, ...(model ? { model } : {}) })
        : createClaudeCliAdapter({ workingDirectory, ...(model ? { model } : {}) });

  const partialBudget: Partial<LoopBudget> = {};
  if (input.maxUsd !== undefined) {
    partialBudget.maxUsd = input.maxUsd;
  }
  if (input.maxIterations !== undefined) {
    partialBudget.maxIterations = input.maxIterations;
  }
  if (input.maxTokens !== undefined) {
    partialBudget.maxTokens = input.maxTokens;
  }

  const budget: LoopBudget = {
    ...DEFAULT_BUDGET,
    ...partialBudget
  };

  const result = await runMartin({
    workspaceId: input.workspaceId ?? "ws_mcp",
    projectId: input.projectId ?? "proj_mcp",
    task: {
      title: input.objective.slice(0, 100),
      objective: input.objective,
      verificationPlan: input.verificationPlan ?? []
    },
    budget,
    adapter
  });

  const lastAttempt = result.loop.attempts.at(-1);
  const verificationPassed =
    lastAttempt !== undefined && result.decision.lifecycleState === "completed";

  return {
    status: result.loop.status,
    lifecycleState: result.decision.lifecycleState,
    reason: result.decision.reason,
    attempts: result.loop.attempts.length,
    costUsd: result.loop.cost.actualUsd,
    verificationPassed,
    loopId: result.loop.loopId
  };
}
