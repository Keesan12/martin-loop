import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { MartinAdapter } from "@martin/core";

import {
  readGitExecutionArtifacts,
  resolveGitRepositoryRoot,
  runSubprocess,
  runVerification,
  type SpawnLike
} from "./cli-bridge.js";
import { createAdapterCapabilities, normalizeUsage } from "./runtime-support.js";

export interface VerifierOnlyAdapterOptions {
  workingDirectory?: string;
  verifyTimeoutMs?: number;
  spawnImpl?: SpawnLike;
  label?: string;
  adapterId?: string;
  providerId?: string;
  model?: string;
  successSummary?: string;
  successWithChangesSummary?: string;
  failureSummary?: string;
}

export function createVerifierOnlyAdapter(
  options: VerifierOnlyAdapterOptions = {}
): MartinAdapter {
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const verifyTimeoutMs = options.verifyTimeoutMs ?? 60_000;
  const providerId = options.providerId ?? "verifier";
  const model = options.model ?? "verify-only";

  return {
    adapterId: options.adapterId ?? `direct:${providerId}:${model}`,
    kind: "direct-provider",
    label: options.label ?? "Verifier-only adapter",
    metadata: {
      providerId,
      model,
      transport: "cli",
      capabilities: createAdapterCapabilities({
        usageSettlement: "actual",
        diffVisibility: "git",
        verifierCompatibility: "verify_only"
      })
    },
    async execute(request) {
      const hasVerificationSteps =
        request.context.verificationPlan.length > 0 ||
        (request.context.verificationStack?.length ?? 0) > 0;
      const gitRepoRoot = resolveGitRepositoryRoot(workingDirectory);
      const beforeSnapshot =
        hasVerificationSteps && gitRepoRoot
          ? await captureWorktreeSnapshot(gitRepoRoot, verifyTimeoutMs, options.spawnImpl)
          : undefined;
      const verification = await runVerification(
        request.context.verificationPlan,
        workingDirectory,
        verifyTimeoutMs,
        request.context.verificationStack,
        options.spawnImpl
      );
      const execution =
        hasVerificationSteps && gitRepoRoot
          ? await readGitExecutionArtifacts(gitRepoRoot, 5_000, options.spawnImpl)
          : {};
      const afterSnapshot =
        hasVerificationSteps && gitRepoRoot
          ? await captureWorktreeSnapshot(gitRepoRoot, verifyTimeoutMs, options.spawnImpl)
          : undefined;
      const changedFiles =
        beforeSnapshot && afterSnapshot ? diffWorktreeSnapshots(beforeSnapshot, afterSnapshot) : [];
      const normalizedExecution =
        execution.changedFiles !== undefined || changedFiles.length > 0 || !hasVerificationSteps
          ? {
              ...execution,
              changedFiles
            }
          : execution;

      if (verification.passed) {
        return {
          status: "completed",
          summary:
            changedFiles.length > 0
              ? options.successWithChangesSummary ?? `Verifier-only run completed but modified files: ${changedFiles.join(", ")}`
              : options.successSummary ?? "Verifier-only run completed without file edits.",
          usage: normalizeUsage({
            actualUsd: 0,
            tokensIn: 0,
            tokensOut: 0,
            provenance: "actual"
          }),
          verification,
          execution: normalizedExecution
        };
      }

      return {
        status: "failed",
        summary: options.failureSummary ?? "Verifier-only run failed.",
        usage: normalizeUsage({
            actualUsd: 0,
            tokensIn: 0,
            tokensOut: 0,
            provenance: "actual"
          }),
        verification,
        execution: normalizedExecution,
        failure: {
          message: verification.summary
        }
      };
    }
  };
}

async function captureWorktreeSnapshot(
  workingDirectory: string,
  timeoutMs: number,
  spawnImpl?: SpawnLike
): Promise<Map<string, string>> {
  const [tracked, untracked] = await Promise.all([
    runSubprocess("git", ["diff", "--name-only", "HEAD"], {
      cwd: workingDirectory,
      timeoutMs,
      spawnImpl
    }),
    runSubprocess("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: workingDirectory,
      timeoutMs,
      spawnImpl
    })
  ]);

  if (tracked.exitCode !== 0 && untracked.exitCode !== 0) {
    return new Map();
  }

  const files = new Set([
    ...parseChangedFiles(tracked.stdout),
    ...parseChangedFiles(untracked.stdout)
  ]);
  const snapshot = new Map<string, string>();

  for (const file of files) {
    const digest = await hashFile(join(workingDirectory, file));
    snapshot.set(file, digest);
  }

  return snapshot;
}

function parseChangedFiles(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function hashFile(filePath: string): Promise<string> {
  try {
    const contents = await readFile(filePath);
    return createHash("sha256").update(contents).digest("hex");
  } catch {
    return "__missing__";
  }
}

function diffWorktreeSnapshots(
  before: Map<string, string>,
  after: Map<string, string>
): string[] {
  const changed = new Set<string>();

  for (const [file, digest] of before) {
    if (after.get(file) !== digest) {
      changed.add(file);
    }
  }

  for (const [file, digest] of after) {
    if (before.get(file) !== digest) {
      changed.add(file);
    }
  }

  return [...changed].sort();
}
