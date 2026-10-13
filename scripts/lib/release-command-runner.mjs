import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

export const DEFAULT_RELEASE_STAGE_TIMEOUT_MS = 30 * 60 * 1_000;
export const RELEASE_STAGE_TIMEOUT_ENV = "MARTIN_RELEASE_STAGE_TIMEOUT_MS";

export function resolveReleaseStageTimeoutMs(options = {}) {
  const configured = options.timeoutMs ?? options.env?.[RELEASE_STAGE_TIMEOUT_ENV] ?? DEFAULT_RELEASE_STAGE_TIMEOUT_MS;
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${RELEASE_STAGE_TIMEOUT_ENV} must be a positive integer`);
  }
  return value;
}

export function resolveReleaseCommandExecution(
  command,
  platform = process.platform,
  comSpec = process.env.ComSpec ?? "cmd.exe",
) {
  if (platform === "win32") {
    const executable = resolveWindowsExecutable(command[0]);
    if (requiresWindowsCommandShim(executable)) {
      return {
        command: comSpec,
        args: ["/d", "/c", executable, ...command.slice(1)],
        shell: false,
      };
    }

    return { command: executable, args: command.slice(1), shell: false };
  }

  return { command: command[0], args: command.slice(1), shell: false };
}

export async function runReleaseCommand(step, options) {
  validateStep(step);
  const cwd = path.resolve(options.cwd);
  const logDir = path.resolve(options.logDir);
  await mkdir(logDir, { recursive: true });
  const logPath = path.join(
    logDir,
    `${String(options.index).padStart(2, "0")}-${slugify(step.label)}.log`,
  );
  const timeoutMs = resolveReleaseStageTimeoutMs({ timeoutMs: options.timeoutMs, env: options.env });
  const terminationGraceMs = positiveInteger(options.terminationGraceMs ?? 5_000, "terminationGraceMs");
  const platform = options.platform ?? process.platform;
  const execution = (options.resolveExecution ?? resolveReleaseCommandExecution)(
    step.command,
    platform,
    options.comSpec,
  );
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const log = createWriteStream(logPath, { flags: "w" });
  log.write(`> ${step.label}\n`);

  let child;
  let spawnError = null;
  let timedOut = false;
  let closeResult = { exitCode: null, signal: null };
  let timer;
  let terminationPromise = null;
  let resolveTimeoutLifecycle;
  const timeoutLifecycle = new Promise((resolveTimeout) => {
    resolveTimeoutLifecycle = resolveTimeout;
  });
  const termination = {
    requested: false,
    attempted: false,
    observed: false,
    escalated: false,
    helperExitCode: null,
    helperTimedOut: false,
  };

  const closePromise = new Promise((resolveClose) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      closeResult = result;
      resolveClose(result);
    };

    try {
      child = (options.spawnProcess ?? spawn)(execution.command, execution.args, {
        cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      spawnError = error;
      settle({ exitCode: null, signal: null });
      return;
    }

    const write = (stream, chunk) => {
      const text = String(chunk);
      stream.write(text);
      log.write(text);
    };
    child.stdout?.on("data", (chunk) => write(process.stdout, chunk));
    child.stderr?.on("data", (chunk) => write(process.stderr, chunk));
    child.once("error", (error) => {
      spawnError = error;
      settle({ exitCode: null, signal: null });
    });
    child.once("close", (exitCode, signal) => {
      if (termination.requested) termination.observed = true;
      settle({ exitCode, signal });
    });
  });

  if (child && !spawnError) {
    timer = setTimeout(() => {
      timedOut = true;
      termination.requested = true;
      terminationPromise = (options.terminateTree ?? terminateOwnedProcessTree)(child, {
        platform,
        helperTimeoutMs: terminationGraceMs,
      }).then((result) => {
        Object.assign(termination, result);
      }).catch((error) => {
        termination.attempted = true;
        termination.escalated = true;
        log.write(`\n[termination-error] ${error instanceof Error ? error.message : String(error)}\n`);
      }).finally(() => {
        resolveTimeoutLifecycle();
      });
    }, timeoutMs);
  }

  await Promise.race([closePromise, timeoutLifecycle]);
  clearTimeout(timer);
  if (terminationPromise) await terminationPromise;
  if (timedOut && !termination.observed) {
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    closeResult = {
      exitCode: child?.exitCode ?? null,
      signal: child?.signalCode ?? null,
    };
  }
  if (spawnError) {
    log.write(`\n[spawn-error] ${spawnError instanceof Error ? spawnError.message : String(spawnError)}\n`);
  }
  await new Promise((resolveEnd) => log.end(resolveEnd));

  const completedAt = new Date().toISOString();
  const failureKind = timedOut
    ? "repository_stage_timeout"
    : spawnError
      ? "spawn_error"
      : closeResult.exitCode === 0 && closeResult.signal === null
        ? null
        : "nonzero_exit";

  return {
    label: step.label,
    command: [...step.command],
    status: failureKind === null ? "passed" : "failed",
    failureKind,
    startedAt,
    completedAt,
    elapsedMs: Math.max(0, Math.round(performance.now() - started)),
    exitCode: closeResult.exitCode,
    signal: closeResult.signal,
    timedOut,
    timeoutMs,
    spawnError: spawnError instanceof Error ? spawnError.message : spawnError ? String(spawnError) : null,
    termination,
    logPath,
  };
}

export async function terminateOwnedProcessTree(child, options = {}) {
  if (!child || !Number.isSafeInteger(child.pid)) {
    return { attempted: false, observed: false, escalated: false, helperExitCode: null, helperTimedOut: false };
  }
  const platform = options.platform ?? process.platform;
  const helperTimeoutMs = positiveInteger(options.helperTimeoutMs ?? 5_000, "helperTimeoutMs");

  if (platform === "win32") {
    const helper = await runTerminationHelper(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      helperTimeoutMs,
    );
    let escalated = helper.exitCode !== 0;
    if (escalated) {
      try { child.kill("SIGKILL"); } catch {}
    }
    const observed = await waitForProcessClose(child, helperTimeoutMs);
    if (!observed) {
      escalated = true;
      try { child.kill("SIGKILL"); } catch {}
    }
    return {
      attempted: true,
      observed: observed || child.exitCode !== null || child.signalCode !== null,
      escalated,
      helperExitCode: helper.exitCode,
      helperTimedOut: helper.timedOut,
    };
  }

  let escalated = false;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
  let observed = await waitForProcessClose(child, Math.min(1_000, helperTimeoutMs));
  if (!observed) {
    escalated = true;
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
    observed = await waitForProcessClose(child, helperTimeoutMs);
  }
  return { attempted: true, observed, escalated, helperExitCode: null, helperTimedOut: false };
}

function waitForProcessClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveClose) => {
    const timer = setTimeout(() => resolveClose(false), timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolveClose(true);
    });
  });
}

function runTerminationHelper(executable, args, timeoutMs) {
  return new Promise((resolveHelper) => {
    let helper;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveHelper(result);
    };
    const timer = setTimeout(() => {
      try { helper?.kill("SIGKILL"); } catch {}
      finish({ exitCode: null, timedOut: true });
    }, timeoutMs);
    try {
      helper = spawn(executable, args, { detached: false, windowsHide: true, stdio: "ignore", shell: false });
      helper.once("error", () => finish({ exitCode: null, timedOut: false }));
      helper.once("close", (exitCode) => finish({ exitCode, timedOut: false }));
    } catch {
      finish({ exitCode: null, timedOut: false });
    }
  });
}

function resolveWindowsExecutable(command) {
  if (path.extname(command).length > 0) return command;
  if (command === "npm" || command === "pnpm" || command === "npx") return `${command}.cmd`;
  return command;
}

function requiresWindowsCommandShim(command) {
  const extension = path.extname(command).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

function validateStep(step) {
  if (!step || typeof step.label !== "string" || step.label.length === 0) throw new Error("step.label is required");
  if (!Array.isArray(step.command) || step.command.length === 0 || step.command.some((part) => typeof part !== "string")) {
    throw new Error("step.command must be a non-empty string array");
  }
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80);
}
