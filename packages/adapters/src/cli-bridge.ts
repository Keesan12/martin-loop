import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";

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
        timedOut: false
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
    const parts = splitCommand(step.command);
    const [bin, ...args] = parts;

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

interface SpawnPlan {
  command: string;
  args: string[];
}

function createSpawnPlan(
  command: string,
  args: string[],
  cwd: string,
  preserveRawForInjectedSpawn: boolean
): SpawnPlan {
  if (preserveRawForInjectedSpawn || process.platform !== "win32") {
    return { command, args };
  }

  const resolved = isAbsolute(command) ? command : resolveWindowsCommand(command, cwd);
  if (!resolved) {
    return { command, args };
  }

  const extension = extname(resolved).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    const nodeShim = resolveWindowsNodeShim(resolved);
    if (nodeShim) {
      return {
        command: nodeShim.nodeCommand,
        args: [nodeShim.scriptPath, ...args]
      };
    }

    return {
      command: resolveWindowsPowerShellHost(),
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        buildPowerShellBatchInvocation(resolved, args)
      ]
    };
  }

  return { command: resolved, args };
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
  return pathExt
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => `${command}${extension.toLowerCase()}`);
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
