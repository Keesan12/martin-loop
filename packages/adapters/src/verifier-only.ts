import type { MartinAdapter, RunParentSwarmPipelineInput } from "@martin/core";

import { readGitChangedFiles, runVerification, type SpawnLike } from "./cli-bridge.js";
import { createAdapterCapabilities, normalizeUsage } from "./runtime-support.js";

export interface VerifierOnlyAdapterOptions {
  workingDirectory?: string;
  verifyTimeoutMs?: number;
  label?: string;
  spawnImpl?: SpawnLike;
}

export interface SwarmVerifierExecutorOptions {
  verifyTimeoutMs?: number;
  spawnImpl?: SpawnLike;
  now?: () => string;
}

type ParentSwarmVerifierExecutor = RunParentSwarmPipelineInput["verifierExecutor"];

/** Adapter-side executor for Core's injected, full-binding parent verifier boundary. */
export function createSwarmVerifierExecutor(
  options: SwarmVerifierExecutorOptions = {}
): ParentSwarmVerifierExecutor {
  const verifyTimeoutMs = options.verifyTimeoutMs ?? 120_000;
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async execute(request) {
      const startedAt = now();
      const verification = await runVerification(
        request.commands.map((step) => step.command),
        request.cwd,
        verifyTimeoutMs,
        request.commands.map((step) => ({ ...step })),
        options.spawnImpl,
        {
          runId: request.swarmId,
          workspaceId: request.workspaceId,
          cwd: request.cwd
        },
        request.signal
      );
      const completedAt = now();
      return {
        passed: verification.passed,
        processCloseState: verification.processCloseState,
        binding: {
          swarmId: request.swarmId,
          workspaceId: request.workspaceId,
          cwd: request.cwd,
          parentPolicyVersion: request.parentPolicyVersion,
          baselineCommit: request.baselineCommit,
          integratedTreeHash: request.integratedTreeHash,
          commands: request.commands.map((step) => step.command)
        },
        subprocessResults: verification.steps.map((step) => ({
          command: step.command,
          launched: step.launched,
          completed: step.completed,
          timedOut: step.timedOut,
          exitCode: step.exitCode ?? null,
          startedAt,
          ...(step.completed ? { completedAt } : {})
        }))
      };
    }
  };
}

export function createVerifierOnlyAdapter(
  options: VerifierOnlyAdapterOptions = {}
): MartinAdapter {
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const verifyTimeoutMs = options.verifyTimeoutMs ?? 120_000;

  return {
    adapterId: "direct:verifier:verify-only",
    kind: "direct-provider",
    label: options.label ?? "Verifier-only adapter",
    metadata: {
      providerId: "verifier",
      model: "verify-only",
      transport: "cli",
      capabilities: createAdapterCapabilities({
        usageSettlement: true,
        diffArtifacts: true,
        workspaceMutations: false
      })
    },
    async execute(request) {
      const shouldTrackVerifierWrites =
        request.context.verificationPlan.length > 0 ||
        (request.context.verificationStack?.length ?? 0) > 0;

      const baselineChangedFiles = shouldTrackVerifierWrites
        ? new Set(await readGitChangedFiles(workingDirectory, 5_000))
        : new Set<string>();
      const verification = await runVerification(
        request.context.verificationPlan,
        workingDirectory,
        verifyTimeoutMs,
        request.context.verificationStack,
        options.spawnImpl,
        {
          runId: request.loopId,
          workspaceId: request.workspaceId,
          attemptId: request.attemptId,
          cwd: workingDirectory,
          ...(request.context.runsRoot ? { runsRoot: request.context.runsRoot } : {}),
          ...(request.context.executionProfile ? { executionProfile: request.context.executionProfile } : {}),
          ...(request.context.allowedNetworkDomains?.length ? { allowedNetworkDomains: [...request.context.allowedNetworkDomains] } : {}),
        },
        request.signal
      );
      const changedFiles = shouldTrackVerifierWrites
        ? (await readGitChangedFiles(workingDirectory, 5_000)).filter(
            (file) => !baselineChangedFiles.has(file)
          )
        : [];
      const execution = { changedFiles };

      if (verification.passed) {
        return {
          status: "completed",
          summary:
            changedFiles.length > 0
              ? `Verifier-only run completed but modified files: ${changedFiles.join(", ")}`
              : "Verifier-only run completed without file edits.",
          usage: normalizeUsage({
            actualUsd: 0,
            tokensIn: 0,
            tokensOut: 0,
            provenance: "actual"
          }),
          verification,
          execution
        };
      }

      return {
        status: "failed",
        summary: "Verifier-only run failed.",
        usage: normalizeUsage({
          actualUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
          provenance: "actual"
        }),
        verification,
        execution,
        failure: {
          message: verification.summary
        }
      };
    }
  };
}
