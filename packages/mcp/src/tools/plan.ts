import { resolveSafeRepoRoot } from "../server-validation.js";
import {
  buildPlanProposal,
  type MartinPlanProposal,
  type MartinPolicyPack
} from "./workflow-governance.js";

export interface MartinPlanInput {
  objective: string;
  workingDirectory?: string;
  context?: string;
  verificationPlan?: string[];
  allowedPaths?: string[];
  deniedPaths?: string[];
  policyPack?: MartinPolicyPack;
  maxUsd?: number;
  maxIterations?: number;
  maxTokens?: number;
  maxMinutes?: number;
  maxFilesChanged?: number;
  maxCommands?: number;
}

export interface MartinPlanOutput extends MartinPlanProposal {
  workingDirectory: string;
}

export async function martinPlanTool(input: MartinPlanInput): Promise<MartinPlanOutput> {
  const workingDirectory = resolveSafeRepoRoot(input.workingDirectory);
  const proposal = buildPlanProposal(workingDirectory, input);
  return {
    workingDirectory,
    ...proposal
  };
}
