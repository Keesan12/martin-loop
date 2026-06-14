import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { existsSync } from "node:fs";

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
  /**
   * True when the subprocess was terminated early because its combined
   * stdout+stderr exceeded `maxOutputBytes` — a circuit breaker against
   * runaway agent sessions that would otherwise burn far more cost/tokens
   * than the loop budget allows before MartinLoop can observe the final
   * (post-hoc) usage report. See `claude-cli.ts` execute() for how this
   * cap is derived from the remaining loop budget.
   */
  outputCapped: boolean;
  /**
   * Set to the inspector's reason string when an `onStdoutChunk` callback
   * requested early termination (e.g. a streaming usage/cost circuit breaker
   * that detected the agent is on track to blow through its budget). Distinct
   * from `outputCapped`, which fires on raw byte volume rather than parsed
   * semantic content.
   */
  terminationReason?: string;
  launched: boolean;
}

export interface VerificationOutcome {
  passed: boolean;
  summary: string;
  steps: VerificationStepOutcome[];
  warnings?: string[];
}

export interface VerificationStepOutcome {
  command: string;
  launched: boolean;
  exitCode?: number;
  timedOut: boolean;
  fastFail: boolean;
  detail?: string;
}

const gitRepositoryRootCache = new Map<string, string | null>();

export async function runSubprocess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    spawnImpl?: SpawnLike;
    stdinData?: string;
    /**
     * Optional circuit breaker: terminate the subprocess once combined
     * stdout+stderr bytes exceed this threshold, instead of waiting for
     * natural completion. Used to bound runaway agent-CLI cost/token spend
     * that can't otherwise be observed until the process exits.
     */
    maxOutputBytes?: number;
    /**
     * Optional semantic inspector invoked with each raw stdout chunk. Used to
     * parse streaming structured output (e.g. Claude's `stream-json` usage
     * events) and request early termination via the supplied `terminate`
     * callback once a semantic threshold (such as cumulative cost) is
     * crossed — well before the subprocess would exit naturally and report
     * a runaway final usage figure.
     */
    onStdoutChunk?: (chunk: Buffer, terminate: (reason: string) => void) => void;
  }
): Promise<SubprocessResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    let outputCapped = false;
    let terminationReason: string | undefined;
    let settled = false;
    let outputBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const stdinMode = options.stdinData !== undefined ? "pipe" : "ignore";

    const resolveOnce = (result: Omit<SubprocessResult, "timedOut" | "outputCapped" | "terminationReason">) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ ...result, timedOut, outputCapped, ...(terminationReason ? { terminationReason } : {}) });
    };

    let proc: ChildProcess;
    try {
      const spawnPlan = createSpawnPlan(command, args, options.cwd, options.spawnImpl !== undefined);
      proc = (options.spawnImpl ?? spawn)(spawnPlan.command, spawnPlan.args, {
        cwd: options.cwd,
        stdio: [stdinMode, "pipe", "pipe"],
        env: process.env
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolveOnce({ exitCode: 1, stdout: "", stderr: message, launched: false });
      return;
    }

    const trackOutput = (chunks: Buffer[], chunk: Buffer) => {
      if (outputCapped || timedOut) {
        return;
      }
      chunks.push(chunk);
      outputBytes += chunk.byteLength;
      if (options.maxOutputBytes !== undefined && outputBytes > options.maxOutputBytes) {
        outputCapped = true;
        proc.kill("SIGTERM");
      }
    };

    const terminateEarly = (reason: string) => {
      if (terminationReason || timedOut || outputCapped) {
        return;
      }
      terminationReason = reason;
      proc.kill("SIGTERM");
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      trackOutput(stdoutChunks, chunk);
      if (options.onStdoutChunk) {
        try {
          options.onStdoutChunk(chunk, terminateEarly);
        } catch (error) {
          terminateEarly(
            `stdout inspector error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      trackOutput(stderrChunks, chunk);
    });

    proc.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      // Some CLIs exit before consuming stdin in tests and on fast-fail paths.
      // Treat the closed pipe as a handled subprocess lifecycle condition.
      if (error.code === "EPIPE") {
        return;
      }
      stderrChunks.push(Buffer.from(`${error.message}\n`, "utf8"));
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, options.timeoutMs);

    proc.on("error", (error) => {
      clearTimeout(timer);
      resolveOnce({ exitCode: 1, stdout: "", stderr: error.message, launched: false });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolveOnce({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        launched: true
      });
    });

    if (options.stdinData !== undefined && proc.stdin) {
      try {
        proc.stdin.end(options.stdinData, "utf8");
      } catch (error) {
        const stdinError = error as NodeJS.ErrnoException;
        if (stdinError.code !== "EPIPE") {
          clearTimeout(timer);
          resolveOnce({
            exitCode: 1,
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: stdinError.message,
            launched: false
          });
        }
      }
    }
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
    return { passed: true, summary: "No verification commands specified.", steps: [] };
  }

  const failedSteps: string[] = [];
  const stepOutcomes: VerificationStepOutcome[] = [];
  const warnings: string[] = [];

  for (const step of steps) {
    const parts = splitCommand(step.command);
    const [bin, ...args] = parts;

    if (!bin) {
      continue;
    }

    const result = await runSubprocess(bin, args, { cwd, timeoutMs, spawnImpl });
    const detail = truncate(result.stderr.trim() || result.stdout.trim(), 500);

    stepOutcomes.push({
      command: step.command,
      launched: result.launched,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      fastFail: step.fastFail,
      ...(detail ? { detail } : {})
    });

    if (result.timedOut) {
      return {
        passed: false,
        summary: `Verification timed out: ${step.command}`,
        steps: stepOutcomes,
        ...(warnings.length ? { warnings } : {})
      };
    }

    if (result.exitCode !== 0) {
      const summary = `Verification failed: ${step.command}\n${detail}`;
      if (!result.launched) {
        warnings.push(`Verifier never launched: ${step.command}`);
      }
      if (step.fastFail) {
        return { passed: false, summary, steps: stepOutcomes, ...(warnings.length ? { warnings } : {}) };
      }
      failedSteps.push(step.command);
    }
  }

  if (failedSteps.length > 0) {
    return {
      passed: false,
      summary: `Failed steps: ${failedSteps.join(", ")}`,
      steps: stepOutcomes,
      ...(warnings.length ? { warnings } : {})
    };
  }

  return {
    passed: true,
    summary: `All ${String(steps.length)} verification step(s) passed.`,
    steps: stepOutcomes,
    ...(warnings.length ? { warnings } : {})
  };
}

export async function readGitExecutionArtifacts(
  repoRoot: string,
  timeoutMs: number,
  spawnImpl?: SpawnLike
): Promise<{
  changedFiles?: string[];
  diffStats?: ReturnType<typeof diffStatsFromNumstat>;
}> {
  if (!resolveGitRepositoryRoot(repoRoot)) {
    return {};
  }

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

export async function readGitChangedFiles(
  repoRoot: string,
  timeoutMs: number,
  spawnImpl?: SpawnLike
): Promise<string[]> {
  if (!resolveGitRepositoryRoot(repoRoot)) {
    return [];
  }

  const statusResult = await runSubprocess(
    "git",
    ["status", "-z", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all", "--", "."],
    { cwd: repoRoot, timeoutMs, spawnImpl }
  );

  if (statusResult.exitCode !== 0) {
    return [];
  }

  return parsePorcelainEntries(statusResult.stdout).filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0
  );
}

export function resolveGitRepositoryRoot(workingDirectory: string): string | undefined {
  const resolvedWorkingDirectory = resolve(workingDirectory);
  const cached = gitRepositoryRootCache.get(resolvedWorkingDirectory);
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  if (!existsSync(resolvedWorkingDirectory)) {
    gitRepositoryRootCache.set(resolvedWorkingDirectory, null);
    return undefined;
  }

  const visited: string[] = [];
  let current = resolvedWorkingDirectory;

  while (true) {
    visited.push(current);

    const currentCached = gitRepositoryRootCache.get(current);
    if (currentCached !== undefined) {
      for (const candidate of visited) {
        gitRepositoryRootCache.set(candidate, currentCached);
      }
      return currentCached ?? undefined;
    }

    if (existsSync(resolve(current, ".git"))) {
      for (const candidate of visited) {
        gitRepositoryRootCache.set(candidate, current);
      }
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      for (const candidate of visited) {
        gitRepositoryRootCache.set(candidate, null);
      }
      return undefined;
    }

    current = parent;
  }
}

export interface SpawnPlan {
  command: string;
  args: string[];
}

export function createSpawnPlan(
  command: string,
  args: string[],
  cwd: string,
  preserveRawForInjectedSpawn: boolean
): SpawnPlan {
  if (preserveRawForInjectedSpawn || process.platform !== "win32") {
    return { command, args };
  }

  // Try to resolve the command to an absolute path using the Windows PATH.
  const resolvedOrUndefined = isAbsolute(command) ? command : resolveWindowsCommand(command, cwd);

  // If resolution failed (command not found in PATH), fall back to cmd.exe shell execution so
  // Windows can resolve the command itself — this covers cases like `pnpm` where the npm global
  // bin directory is present in the shell PATH but not yet visible to this Node.js process.
  if (resolvedOrUndefined === undefined) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/c", command, ...args]
    };
  }

  const extension = extname(resolvedOrUndefined).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/c", resolvedOrUndefined, ...args]
    };
  }

  if (extension === ".ps1") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolvedOrUndefined, ...args]
    };
  }

  return { command: resolvedOrUndefined, args };
}

function resolveWindowsCommand(command: string, cwd: string): string | undefined {
  const hasPathSegment = command.includes("\\") || command.includes("/");
  const baseCandidates = expandWindowsCommandCandidates(
    hasPathSegment ? resolve(cwd, command) : command
  );

  if (hasPathSegment) {
    return baseCandidates.find((candidate) => existsSync(candidate));
  }

  for (const directory of windowsPathDirectories()) {
    for (const candidate of baseCandidates) {
      const fullPath = join(directory, candidate);
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  return undefined;
}

function expandWindowsCommandCandidates(command: string): string[] {
  if (extname(command)) {
    return [command];
  }

  const pathExt = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  const fromPathExt = pathExt
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => `${command}${extension.toLowerCase()}`);

  const candidates = [...fromPathExt, `${command}.ps1`];
  return Array.from(new Set(candidates));
}

function parsePorcelainEntries(stdout: string): string[] {
  const entries = stdout.split("\u0000").filter((entry) => entry.length > 0);
  const changedFiles: string[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry.length < 4) {
      continue;
    }

    const status = entry.slice(0, 2);
    const payload = entry.slice(3);
    if (!payload) {
      continue;
    }

    if (status.includes("R") || status.includes("C")) {
      const renamedPath = entries[index + 1];
      if (renamedPath && renamedPath.length > 0) {
        changedFiles.push(renamedPath);
        index += 1;
        continue;
      }
    }

    changedFiles.push(payload);
  }

  return changedFiles;
}

function windowsPathDirectories(): string[] {
  const rawPath = process.env.Path ?? process.env.PATH ?? "";
  return rawPath
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

export function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  const trimmed = command.trim();
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    const next = trimmed[index + 1];
    if (char === undefined) {
      continue;
    }

    if (char === "\\") {
      const canEscape = quote !== "'" && (next === quote || next === "\\");
      if (canEscape && next !== undefined) {
        current += next;
        index += 1;
        continue;
      }
    }

    if (char === '"' || char === "'") {
      if (!quote) {
        quote = char;
        continue;
      }

      if (quote === char) {
        quote = undefined;
        continue;
      }
    }

    if (!quote && /\s/u.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `...${text.slice(-(maxLength - 3))}`;
}
