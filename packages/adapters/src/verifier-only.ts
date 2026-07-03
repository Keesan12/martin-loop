import type { MartinAdapter } from "@martin/core";

import { readGitChangedFiles, runVerification, type SpawnLike } from "./cli-bridge.js";
import { createAdapterCapabilities, normalizeUsage } from "./runtime-support.js";

export interface VerifierOnlyAdapterOptions {
  workingDirectory?: string;
  verifyTimeoutMs?: number;
  label?: string;
  spawnImpl?: SpawnLike;
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
        diffArtifacts: true
      })
    },
    async execute(request) {
      const shouldTrackVerifierWrites =
        request.context.verificationPlan.length > 0 ||
        (request.context.verificationStack?.length ?? 0) > 0;

      const baselineChangedFiles = shouldTrackVerifierWrites
        ? new Set(await readGitChangedFiles(workingDirectory, 5_000, options.spawnImpl))
        : new Set<string>();
      const verification = await runVerification(
        request.context.verificationPlan,
        workingDirectory,
        verifyTimeoutMs,
        request.context.verificationStack,
        options.spawnImpl
      );
      const changedFiles = shouldTrackVerifierWrites
        ? (await readGitChangedFiles(workingDirectory, 5_000, options.spawnImpl)).filter(
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
