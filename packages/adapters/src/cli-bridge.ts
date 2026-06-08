import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";

import type {
  VerifierExitReason,
  VerifierSnapshot,
  VerifierStepSnapshot,
  VerifierStepType
} from "@martin/contracts";

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
  spawnError?: boolean;
}

export interface VerificationOutcome {
  passed: boolean;
  summary: string;
  snapshot: VerifierSnapshot;
}

export interface CliCommandProbe extends SubprocessResult {
  ready: boolean;
  detail: string;
}

export async function runSubprocess(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; spawnImpl?: SpawnLike; stdinData?: string }
): Promise<SubprocessResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const stdinMode = options.stdinData !== undefined ? "pipe" : "ignore";

    const resolveOnce = (result: SubprocessResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
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
      resolveOnce({
        exitCode: 1,
        stdout: "",
        stderr: message,
        timedOut: false,
        spawnError: true
      });
      return;
    }

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
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
      resolveOnce({
        exitCode: 1,
        stdout: "",
        stderr: error.message,
        timedOut: false,
        spawnError: true
      });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolveOnce({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut
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
            timedOut: false
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
  verificationStack?: Array<{ command: string; type: VerifierStepType; fastFail?: boolean }>,
  spawnImpl?: SpawnLike
): Promise<VerificationOutcome> {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const steps = verificationStack && verificationStack.length > 0
    ? verificationStack.map((step) => ({
        command: step.command,
        type: step.type,
        fastFail: step.fastFail !== false
      }))
    : commands.map((command) => ({ command, type: "custom" as const, fastFail: true }));

  if (steps.length === 0) {
    return finalizeVerificationOutcome(
      [],
      true,
      "No verification commands specified.",
      startedAt,
      startedAtMs
    );
  }

  const failedSteps: string[] = [];
  const snapshots: VerifierStepSnapshot[] = [];

  for (const step of steps) {
    const stepStartedAt = new Date().toISOString();
    const stepStartedAtMs = Date.now();
    const parts = splitCommand(step.command);
    const [bin, ...args] = parts;

    if (!bin) {
      const invalidSnapshot = createVerifierStepSnapshot({
        command: step.command,
        type: step.type,
        fastFail: step.fastFail,
        passed: false,
        exitCode: 1,
        exitReason: "invalid_command",
        startedAt: stepStartedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - stepStartedAtMs,
        stdout: "",
        stderr: "Verification command was empty or invalid."
      });
      snapshots.push(invalidSnapshot);

      if (step.fastFail) {
        return finalizeVerificationOutcome(
          snapshots,
          false,
          `Verification failed: ${step.command}\nVerification command was empty or invalid.`,
          startedAt,
          startedAtMs
        );
      }

      failedSteps.push(step.command);
      continue;
    }

    const result = await runSubprocess(bin, args, { cwd, timeoutMs, spawnImpl });
    const stepCompletedAt = new Date().toISOString();
    const exitReason = inferVerifierExitReason(result);
    snapshots.push(
      createVerifierStepSnapshot({
        command: step.command,
        type: step.type,
        fastFail: step.fastFail,
        passed: result.exitCode === 0 && !result.timedOut && !result.spawnError,
        exitCode: result.exitCode,
        exitReason,
        startedAt: stepStartedAt,
        completedAt: stepCompletedAt,
        durationMs: Date.now() - stepStartedAtMs,
        stdout: result.stdout,
        stderr: result.stderr
      })
    );

    if (result.timedOut) {
      return finalizeVerificationOutcome(
        snapshots,
        false,
        `Verification timed out: ${step.command}`,
        startedAt,
        startedAtMs
      );
    }

    if (result.exitCode !== 0) {
      const detail = truncate(result.stderr.trim() || result.stdout.trim(), 500);
      const summary = `Verification failed: ${step.command}\n${detail}`;
      if (step.fastFail) {
        return finalizeVerificationOutcome(
          snapshots,
          false,
          summary,
          startedAt,
          startedAtMs
        );
      }
      failedSteps.push(step.command);
    }
  }

  if (failedSteps.length > 0) {
    return finalizeVerificationOutcome(
      snapshots,
      false,
      `Failed steps: ${failedSteps.join(", ")}`,
      startedAt,
      startedAtMs
    );
  }

  return finalizeVerificationOutcome(
    snapshots,
    true,
    `All ${String(steps.length)} verification step(s) passed.`,
    startedAt,
    startedAtMs
  );
}

export async function probeCliCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number }
): Promise<CliCommandProbe> {
  const result = await runSubprocess(command, args, options);

  if (result.timedOut) {
    return {
      ...result,
      ready: false,
      detail: `${command} launch check timed out after ${String(options.timeoutMs)}ms.`
    };
  }

  if (result.exitCode !== 0) {
    const detail = truncate(result.stderr.trim() || result.stdout.trim() || `Exit code ${String(result.exitCode)}`, 500);
    return {
      ...result,
      ready: false,
      detail: `${command} launch check failed: ${detail}`
    };
  }

  return {
    ...result,
    ready: true,
    detail: `${command} launch check passed.`
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
  const [changedFilesResult, untrackedFilesResult, numstatResult] = await Promise.all([
    runSubprocess("git", ["diff", "--name-only", "HEAD"], { cwd: repoRoot, timeoutMs, spawnImpl }),
    runSubprocess("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: repoRoot,
      timeoutMs,
      spawnImpl
    }),
    runSubprocess("git", ["diff", "--numstat", "HEAD"], { cwd: repoRoot, timeoutMs, spawnImpl })
  ]);

  const changedFiles = [
    ...(changedFilesResult.exitCode === 0 ? parseGitFileList(changedFilesResult.stdout) : []),
    ...(untrackedFilesResult.exitCode === 0 ? parseGitFileList(untrackedFilesResult.stdout) : [])
  ];
  const diffStats =
    numstatResult.exitCode === 0 ? diffStatsFromNumstat(numstatResult.stdout) : undefined;

  return {
    ...(changedFiles.length > 0 ? { changedFiles: uniqueSortedFiles(changedFiles) } : {}),
    ...(diffStats ? { diffStats } : {})
  };
}

export async function readGitChangedFiles(
  repoRoot: string,
  timeoutMs: number,
  spawnImpl?: SpawnLike
): Promise<string[]> {
  const statusResult = await runSubprocess(
    "git",
    ["status", "-z", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all"],
    { cwd: repoRoot, timeoutMs, spawnImpl }
  );

  if (statusResult.exitCode !== 0) {
    return [];
  }

  return parsePorcelainEntries(statusResult.stdout).filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0
  );
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
    const cmdStr = [quoteWindowsCmdArg(command), ...args.map(quoteWindowsCmdArg)].join(" ");
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/c", cmdStr]
    };
  }

  const extension = extname(resolvedOrUndefined).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    const cmdStr = [quoteWindowsCmdArg(resolvedOrUndefined), ...args.map(quoteWindowsCmdArg)].join(" ");
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", cmdStr]
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

function resolveWindowsNodeShim(
  shimPath: string
): { nodeCommand: string; scriptPath: string } | undefined {
  try {
    const contents = readFileSync(shimPath, "utf8");
    const scriptMatch = contents.match(/"%_prog%"\s+"%dp0%\\([^"]+)"\s+%\*/iu);
    const relativeScriptPath = scriptMatch?.[1];
    if (!relativeScriptPath) {
      return undefined;
    }

    const scriptPath = resolve(dirname(shimPath), relativeScriptPath.replace(/\\/gu, "/"));
    if (!existsSync(scriptPath)) {
      return undefined;
    }

    const bundledNode = join(dirname(shimPath), "node.exe");
    return {
      nodeCommand: existsSync(bundledNode) ? bundledNode : "node",
      scriptPath
    };
  } catch {
    return undefined;
  }
}

function resolveWindowsPowerShellHost(): string {
  const systemRoot = process.env.SystemRoot?.trim();
  if (systemRoot) {
    const bundled = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (existsSync(bundled)) {
      return bundled;
    }
  }

  return "powershell.exe";
}

function buildPowerShellBatchInvocation(commandPath: string, args: string[]): string {
  const quotedCommand = quotePowerShellArg(commandPath);
  const quotedArgs = args.map(quotePowerShellArg).join(" ");
  return quotedArgs.length > 0 ? `& ${quotedCommand} ${quotedArgs}` : `& ${quotedCommand}`;
}

function quotePowerShellArg(value: string): string {
  const normalized = value.replace(/\r?\n/gu, " ");
  return `'${normalized.replace(/'/gu, "''")}'`;
}

function quoteWindowsCmdArg(value: string): string {
  const normalized = value.replace(/(\\*)"/gu, '$1$1\\"');
  const escaped = normalized.replace(/(\\+)$/gu, "$1$1");
  return /[\s"]/u.test(escaped) ? `"${escaped}"` : escaped;
}

function parseGitFileList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function uniqueSortedFiles(files: string[]): string[] {
  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
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

function inferVerifierExitReason(result: SubprocessResult): VerifierExitReason {
  if (result.spawnError) {
    return "spawn_error";
  }

  if (result.timedOut) {
    return "timed_out";
  }

  return result.exitCode === 0 ? "passed" : "non_zero_exit";
}

function createVerifierStepSnapshot(input: {
  command: string;
  type: VerifierStepType;
  fastFail: boolean;
  passed: boolean;
  exitCode: number;
  exitReason: VerifierExitReason;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  stdout: string;
  stderr: string;
}): VerifierStepSnapshot {
  return {
    command: input.command,
    type: input.type,
    fastFail: input.fastFail,
    passed: input.passed,
    exitCode: input.exitCode,
    exitReason: input.exitReason,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: input.durationMs,
    ...(input.stdout.trim() ? { stdout: truncate(input.stdout.trim(), 2_000) } : {}),
    ...(input.stderr.trim() ? { stderr: truncate(input.stderr.trim(), 2_000) } : {})
  };
}

function finalizeVerificationOutcome(
  steps: VerifierStepSnapshot[],
  passed: boolean,
  summary: string,
  startedAt: string,
  startedAtMs: number
): VerificationOutcome {
  const combinedOutput = steps
    .flatMap((step) => [step.stdout, step.stderr])
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n\n")
    .trim();

  return {
    passed,
    summary,
    snapshot: {
      passed,
      summary,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      stepCount: steps.length,
      failedStepCount: steps.filter((step) => !step.passed).length,
      commands: steps.map((step) => step.command),
      steps,
      ...(combinedOutput ? { combinedOutput: truncate(combinedOutput, 8_000) } : {})
    }
  };
}
