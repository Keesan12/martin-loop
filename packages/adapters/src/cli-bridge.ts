import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import { diffStatsFromNumstat } from "./runtime-support.js";

export type SpawnLike = (
  command: string,
  args?: readonly string[],
  options?: SpawnOptions
) => ChildProcess;

export interface SubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface VerificationOutcome {
  passed: boolean;
  summary: string;
}

export async function runSubprocess(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; spawnImpl?: SpawnLike }
): Promise<SubprocessResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    let proc: ChildProcess;
    try {
      proc = (options.spawnImpl ?? spawn)(command, args, {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: message,
        timedOut: false
      });
      return;
    }

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, options.timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut
      });
    });

    proc.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: error.message,
        timedOut: false
      });
    });
  });
}

export async function runVerification(
  commands: string[],
  cwd: string,
  timeoutMs: number,
  verificationStack?: Array<{ command: string; type: string; fastFail?: boolean }>,
  spawnImpl?: SpawnLike
): Promise<VerificationOutcome> {
  const steps = verificationStack && verificationStack.length > 0
    ? verificationStack.map((step) => ({
        command: step.command,
        fastFail: step.fastFail !== false
      }))
    : commands.map((command) => ({ command, fastFail: true }));

  if (steps.length === 0) {
    return { passed: true, summary: "No verification commands specified." };
  }

  const failedSteps: string[] = [];

  for (const step of steps) {
    const parts = step.command.trim().split(/\s+/u);
    const bin = parts[0];
    const args = parts.slice(1);

    if (!bin) {
      continue;
    }

    const result = await runSubprocess(bin, args, { cwd, timeoutMs, spawnImpl });

    if (result.timedOut) {
      return { passed: false, summary: `Verification timed out: ${step.command}` };
    }

    if (result.exitCode !== 0) {
      const detail = truncate(result.stderr.trim() || result.stdout.trim(), 500);
      const summary = `Verification failed: ${step.command}\n${detail}`;
      if (step.fastFail) {
        return { passed: false, summary };
      }
      failedSteps.push(step.command);
    }
  }

  if (failedSteps.length > 0) {
    return { passed: false, summary: `Failed steps: ${failedSteps.join(", ")}` };
  }

  return { passed: true, summary: `All ${String(steps.length)} verification step(s) passed.` };
}

export async function readGitExecutionArtifacts(
  repoRoot: string,
  timeoutMs: number,
  spawnImpl?: SpawnLike
): Promise<{
  changedFiles?: string[];
  diffStats?: ReturnType<typeof diffStatsFromNumstat>;
}> {
  const changedFilesResult = await runSubprocess(
    "git",
    ["diff", "--name-only", "HEAD"],
    { cwd: repoRoot, timeoutMs, spawnImpl }
  );
  const numstatResult = await runSubprocess(
    "git",
    ["diff", "--numstat", "HEAD"],
    { cwd: repoRoot, timeoutMs, spawnImpl }
  );

  const changedFiles =
    changedFilesResult.exitCode === 0
      ? changedFilesResult.stdout
          .split(/\r?\n/u)
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];
  const diffStats =
    numstatResult.exitCode === 0 ? diffStatsFromNumstat(numstatResult.stdout) : undefined;

  return {
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(diffStats ? { diffStats } : {})
  };
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `...${text.slice(-(maxLength - 3))}`;
}
