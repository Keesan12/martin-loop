import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export type ProcessSpawnLike = (
  command: string,
  args?: readonly string[],
  options?: SpawnOptions
) => ChildProcess;

export type ProcessTreeCleanupFailureCode =
  | "invalid_owned_pid"
  | "missing_test_termination_seam"
  | "termination_failed"
  | "tree_close_timeout";

export type ProcessTreeCleanupResult =
  | { state: "not_required" }
  | { state: "closed" }
  | { state: "failed"; code: ProcessTreeCleanupFailureCode; message: string };

export interface SupervisedProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  completed: boolean;
  crashed: boolean;
  outputCapped: boolean;
  terminationReason?: string;
  launched: boolean;
  cleanup: ProcessTreeCleanupResult;
}

export interface SpawnSupervisedProcessOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: ProcessSpawnLike;
  stdinData?: string;
  maxOutputBytes?: number;
  onStdoutChunk?: (chunk: Buffer, terminate: (reason: string) => void) => void;
  signal?: AbortSignal;
  terminationGraceMs?: number;
  /** Require an owned process-tree sweep before natural completion is authoritative. */
  requireTreeClosureOnSuccess?: boolean;
}

type ProcessSupervisorTestSeams =
  | {
      platform: "win32";
      taskkillSpawnImpl: ProcessSpawnLike;
      wait: (durationMs: number) => Promise<void>;
      killProcessGroup?: never;
    }
  | {
      platform: Exclude<NodeJS.Platform, "win32">;
      killProcessGroup: (ownedGroupPid: number, signal: NodeJS.Signals | 0) => void;
      wait: (durationMs: number) => Promise<void>;
      taskkillSpawnImpl?: never;
    };

const ownedProcesses = new WeakMap<ChildProcess, number>();

export async function spawnSupervisedProcess(
  command: string,
  args: readonly string[],
  options: SpawnSupervisedProcessOptions
): Promise<SupervisedProcessResult> {
  return spawnSupervisedProcessInternal(command, args, options);
}

/**
 * Internal deterministic OS seam used only by this package's supervisor tests.
 * It is intentionally absent from the adapters package root so production
 * callers cannot exchange a caller-supplied PID for operating-system kill
 * authority.
 * @internal
 */
export async function spawnSupervisedProcessForTest(
  command: string,
  args: readonly string[],
  options: SpawnSupervisedProcessOptions & { spawnImpl: ProcessSpawnLike },
  seams: ProcessSupervisorTestSeams
): Promise<SupervisedProcessResult> {
  if (!hasCompleteTestTerminationSeams(seams)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Test supervisor refused incomplete injected termination seams.",
      timedOut: false,
      completed: false,
      crashed: false,
      outputCapped: false,
      launched: false,
      cleanup: {
        state: "failed",
        code: "missing_test_termination_seam",
        message: "Injected Windows requires taskkill+wait; injected POSIX requires group-kill+wait."
      }
    };
  }
  return spawnSupervisedProcessInternal(command, args, options, seams);
}

async function spawnSupervisedProcessInternal(
  command: string,
  args: readonly string[],
  options: SpawnSupervisedProcessOptions,
  testSeams?: ProcessSupervisorTestSeams
): Promise<SupervisedProcessResult> {
  if (options.signal?.aborted) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Subprocess launch aborted before spawn.",
      timedOut: false,
      completed: false,
      crashed: false,
      outputCapped: false,
      terminationReason: "aborted",
      launched: false,
      cleanup: { state: "not_required" }
    };
  }

  const platform = testSeams?.platform ?? process.platform;
  const spawnImpl = options.spawnImpl ?? spawn;
  const stdinMode = options.stdinData !== undefined ? "pipe" : "ignore";
  let proc: ChildProcess;

  try {
    proc = spawnImpl(command, args, {
      cwd: options.cwd,
      stdio: [stdinMode, "pipe", "pipe"],
      env: options.env ?? process.env,
      windowsHide: true,
      detached: platform !== "win32"
    });
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
      completed: false,
      crashed: true,
      outputCapped: false,
      launched: false,
      cleanup: { state: "not_required" }
    };
  }

  const ownedPid = proc.pid;
  if (isOwnedPid(ownedPid)) {
    ownedProcesses.set(proc, ownedPid);
  }

  return new Promise((resolve) => {
    let timedOut = false;
    let outputCapped = false;
    let terminationReason: string | undefined;
    let settled = false;
    let exited = false;
    let closed = false;
    let terminationRequested = false;
    let outputBytes = 0;
    let cleanup: ProcessTreeCleanupResult = { state: "not_required" };
    let closeCode: number | null | undefined;
    let naturalClosureProofPending = false;
    let terminationProofPending = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let resolveClosed!: () => void;
    const closedPromise = new Promise<void>((resolveClose) => { resolveClosed = resolveClose; });

    const resolveOnce = (result: Omit<SupervisedProcessResult, "timedOut" | "outputCapped" | "terminationReason" | "cleanup">) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      resolve({
        ...result,
        timedOut,
        outputCapped,
        ...(terminationReason ? { terminationReason } : {}),
        cleanup
      });
    };

    const resolveCleanupFailure = (failure: Extract<ProcessTreeCleanupResult, { state: "failed" }>) => {
      cleanup = failure;
      resolveOnce({
        exitCode: 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        launched: true,
        completed: false,
        crashed: false
      });
    };

    const requestTermination = (reason: string, exposeReason = false) => {
      if (terminationRequested || settled || closed) return;
      terminationRequested = true;
      terminationProofPending = true;
      if (exposeReason) terminationReason = reason;
      void terminateOwnedProcessTree(proc, closedPromise, {
        platform,
        graceMs: options.terminationGraceMs ?? 1_000,
        taskkillSpawnImpl: testSeams?.taskkillSpawnImpl ?? spawnProcess,
        killProcessGroup: testSeams?.killProcessGroup,
        wait: testSeams?.wait ?? wait,
        authority: testSeams !== undefined || options.spawnImpl === undefined
          ? "owned_os_process"
          : "injected_child_only"
      }).then((result) => {
        terminationProofPending = false;
        if (result.state === "failed") {
          resolveCleanupFailure(result);
        } else cleanup = { state: "closed" };
        finalizeClose();
      });
    };

    const trackOutput = (chunks: Buffer[], chunk: Buffer) => {
      if (outputCapped || timedOut || terminationRequested) return;
      chunks.push(chunk);
      outputBytes += chunk.byteLength;
      if (options.maxOutputBytes !== undefined && outputBytes > options.maxOutputBytes) {
        outputCapped = true;
        requestTermination("output_capped");
      }
    };

    const terminateEarly = (reason: string) => {
      if (terminationRequested || timedOut || outputCapped) return;
      requestTermination(reason, true);
    };

    const onAbort = () => requestTermination("aborted");

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (outputCapped || timedOut || terminationRequested) return;
      trackOutput(stdoutChunks, chunk);
      if (options.onStdoutChunk) {
        try {
          options.onStdoutChunk(chunk, terminateEarly);
        } catch (error) {
          terminateEarly(`stdout inspector error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      if (outputCapped || timedOut || terminationRequested) return;
      trackOutput(stderrChunks, chunk);
    });

    proc.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") stderrChunks.push(Buffer.from(`${error.message}\n`, "utf8"));
    });

    const timer = setTimeout(() => {
      if (settled || exited || closed || typeof proc.exitCode === "number") return;
      timedOut = true;
      requestTermination("timeout");
    }, options.timeoutMs);

    function cleanupListeners(): void {
      clearTimeout(timer);
      if (options.signal !== undefined) options.signal.removeEventListener("abort", onAbort);
      ownedProcesses.delete(proc);
    }

    const finalizeClose = () => {
      if (closeCode === undefined || naturalClosureProofPending || terminationProofPending || settled) return;
      const completed = closeCode !== null && !timedOut && !outputCapped && !terminationRequested;
      resolveOnce({
        exitCode: closeCode ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        launched: true,
        completed,
        crashed: !completed && !timedOut && !outputCapped && !terminationRequested
      });
    };

    proc.on("exit", () => {
      exited = true;
      if (options.requireTreeClosureOnSuccess && !terminationRequested && !naturalClosureProofPending) {
        naturalClosureProofPending = true;
        void terminateOwnedProcessTree(proc, closedPromise, {
          platform,
          graceMs: options.terminationGraceMs ?? 1_000,
          taskkillSpawnImpl: testSeams?.taskkillSpawnImpl ?? spawnProcess,
          killProcessGroup: testSeams?.killProcessGroup,
          wait: testSeams?.wait ?? wait,
          authority: testSeams !== undefined || options.spawnImpl === undefined
            ? "owned_os_process"
            : "injected_child_only",
          naturalExit: true
        }).then((result) => {
          cleanup = result;
          naturalClosureProofPending = false;
          finalizeClose();
        });
      }
    });
    proc.on("error", (error) => {
      resolveOnce({
        exitCode: 1,
        stdout: "",
        stderr: error.message,
        launched: false,
        completed: false,
        crashed: true
      });
    });
    proc.on("close", (code) => {
      closed = true;
      closeCode = code;
      resolveClosed();
      if (terminationRequested) cleanup = { state: "closed" };
      else if (!options.requireTreeClosureOnSuccess) cleanup = { state: "not_required" };
      finalizeClose();
    });

    if (options.stdinData !== undefined && proc.stdin) {
      try {
        proc.stdin.end(options.stdinData, "utf8");
      } catch (error) {
        const stdinError = error as NodeJS.ErrnoException;
        if (stdinError.code !== "EPIPE") {
          resolveOnce({
            exitCode: 1,
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: stdinError.message,
            launched: false,
            completed: false,
            crashed: true
          });
        }
      }
    }

    if (options.signal !== undefined) {
      options.signal.addEventListener("abort", onAbort, { once: true });
      // AbortSignal dispatch is synchronous, but an injected spawn can abort
      // between the pre-spawn check and listener registration. Rechecking
      // after every close/error/timer listener is installed closes that race.
      if (options.signal.aborted) onAbort();
    }
  });
}

async function terminateOwnedProcessTree(
  proc: ChildProcess,
  closedPromise: Promise<void>,
  options: {
    platform: NodeJS.Platform;
    graceMs: number;
    taskkillSpawnImpl: ProcessSpawnLike;
    killProcessGroup?: (ownedGroupPid: number, signal: NodeJS.Signals | 0) => void;
    wait: (durationMs: number) => Promise<void>;
    authority: "owned_os_process" | "injected_child_only";
    naturalExit?: boolean;
  }
): Promise<ProcessTreeCleanupResult> {
  if (options.authority === "injected_child_only") {
    if (options.naturalExit) {
      return {
        state: "failed",
        code: "missing_test_termination_seam",
        message: "Injected process completion cannot prove descendant-tree closure."
      };
    }
    return terminateInjectedChild(proc, closedPromise, options.graceMs, options.wait);
  }

  const pid = ownedProcesses.get(proc);
  if (!isOwnedPid(pid)) {
    return {
      state: "failed",
      code: "invalid_owned_pid",
      message: "Cannot terminate a process tree without one registered positive owned PID."
    };
  }

  if (options.platform === "win32") {
    if (options.naturalExit) {
      return terminateWindowsDescendantsAfterRootExit(pid, options.graceMs, options.wait);
    }
    const taskkillResult = await runTaskkill(
      pid,
      options.taskkillSpawnImpl,
      Math.max(options.graceMs, 1_000),
      options.wait
    );
    if (taskkillResult !== undefined) return taskkillResult;
    return waitForOwnedClose(closedPromise, options.graceMs, options.wait);
  }

  const killGroup = options.killProcessGroup ?? ((ownedGroupPid, signal) => process.kill(ownedGroupPid, signal));
  if (options.naturalExit) {
    return terminatePosixGroupAfterRootExit(pid, killGroup, options.graceMs, options.wait);
  }
  try {
    killGroup(-pid, "SIGTERM");
  } catch (error) {
    return cleanupFailure("termination_failed", error);
  }

  if (await closesWithin(closedPromise, options.graceMs, options.wait)) return { state: "closed" };

  try {
    killGroup(-pid, "SIGKILL");
  } catch (error) {
    return cleanupFailure("termination_failed", error);
  }
  return waitForOwnedClose(closedPromise, options.graceMs, options.wait);
}

async function terminatePosixGroupAfterRootExit(
  pid: number,
  killGroup: (ownedGroupPid: number, signal: NodeJS.Signals | 0) => void,
  graceMs: number,
  waitImpl: (durationMs: number) => Promise<void>
): Promise<ProcessTreeCleanupResult> {
  const target = -pid;
  const initial = probePosixProcessGroup(target, killGroup);
  if (initial === "closed") return { state: "closed" };
  if (initial instanceof Error) return cleanupFailure("termination_failed", initial);
  try {
    killGroup(target, "SIGTERM");
  } catch (error) {
    if (isErrno(error, "ESRCH")) return { state: "closed" };
    return cleanupFailure("termination_failed", error);
  }
  if (await waitForPosixGroupExit(target, killGroup, graceMs, waitImpl)) return { state: "closed" };
  try {
    killGroup(target, "SIGKILL");
  } catch (error) {
    if (isErrno(error, "ESRCH")) return { state: "closed" };
    return cleanupFailure("termination_failed", error);
  }
  if (await waitForPosixGroupExit(target, killGroup, graceMs, waitImpl)) return { state: "closed" };
  return {
    state: "failed",
    code: "tree_close_timeout",
    message: "Owned POSIX process group remained live after SIGTERM and SIGKILL."
  };
}

async function waitForPosixGroupExit(
  target: number,
  killGroup: (ownedGroupPid: number, signal: NodeJS.Signals | 0) => void,
  durationMs: number,
  waitImpl: (durationMs: number) => Promise<void>
): Promise<boolean> {
  const deadline = Date.now() + Math.max(1, durationMs);
  while (Date.now() < deadline) {
    const probe = probePosixProcessGroup(target, killGroup);
    if (probe === "closed") return true;
    if (probe instanceof Error) return false;
    await waitImpl(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  return probePosixProcessGroup(target, killGroup) === "closed";
}

function probePosixProcessGroup(
  target: number,
  killGroup: (ownedGroupPid: number, signal: NodeJS.Signals | 0) => void
): "alive" | "closed" | Error {
  try {
    killGroup(target, 0);
    return "alive";
  } catch (error) {
    if (isErrno(error, "ESRCH")) return "closed";
    return error instanceof Error ? error : new Error(String(error));
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && String((error as { code?: unknown }).code) === code;
}

async function terminateWindowsDescendantsAfterRootExit(
  rootPid: number,
  graceMs: number,
  waitImpl: (durationMs: number) => Promise<void>
): Promise<ProcessTreeCleanupResult> {
  let rows: Array<{ ProcessId: number; ParentProcessId: number }>;
  try {
    rows = await readWindowsProcessTree();
  } catch (error) {
    return cleanupFailure("termination_failed", error);
  }
  const childrenByParent = new Map<number, number[]>();
  for (const row of rows) {
    const children = childrenByParent.get(row.ParentProcessId) ?? [];
    children.push(row.ProcessId);
    childrenByParent.set(row.ParentProcessId, children);
  }
  const directChildren = childrenByParent.get(rootPid) ?? [];
  for (const childPid of directChildren) {
    const failure = await runTaskkill(childPid, spawnProcess, graceMs, waitImpl);
    if (failure) return failure;
  }
  return { state: "closed" };
}

function readWindowsProcessTree(): Promise<Array<{ ProcessId: number; ParentProcessId: number }>> {
  const script = [
    "Get-CimInstance Win32_Process",
    "Select-Object ProcessId,ParentProcessId",
    "ConvertTo-Json -Compress"
  ].join(" | ");
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        try {
          const parsed = JSON.parse(stdout || "[]") as unknown;
          const values = Array.isArray(parsed) ? parsed : [parsed];
          resolvePromise(values.flatMap((value) => {
            if (!value || typeof value !== "object") return [];
            const processId = Number((value as { ProcessId?: unknown }).ProcessId);
            const parentProcessId = Number((value as { ParentProcessId?: unknown }).ParentProcessId);
            return isOwnedPid(processId) && Number.isSafeInteger(parentProcessId)
              ? [{ ProcessId: processId, ParentProcessId: parentProcessId }]
              : [];
          }));
        } catch (parseError) {
          rejectPromise(parseError);
        }
      }
    );
  });
}

async function runTaskkill(
  pid: number,
  spawnImpl: ProcessSpawnLike,
  graceMs: number,
  waitImpl: (durationMs: number) => Promise<void>
): Promise<Extract<ProcessTreeCleanupResult, { state: "failed" }> | undefined> {
  let taskkill: ChildProcess;
  try {
    taskkill = spawnImpl("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
  } catch (error) {
    return cleanupFailure("termination_failed", error);
  }

  const taskkillClose = new Promise<Extract<ProcessTreeCleanupResult, { state: "failed" }> | undefined>((resolve) => {
    let settled = false;
    const finish = (result?: Extract<ProcessTreeCleanupResult, { state: "failed" }>) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    taskkill.once("error", (error) => finish(cleanupFailure("termination_failed", error)));
    taskkill.once("close", (code) => {
      if (code === 0) finish();
      else finish({
        state: "failed",
        code: "termination_failed",
        message: `taskkill.exe exited with code ${String(code)}`
      });
    });
  });

  const result = await Promise.race([
    taskkillClose.then((value) => ({ state: "closed" as const, value })),
    waitImpl(graceMs).then(() => ({ state: "timeout" as const }))
  ]);
  if (result.state === "closed") return result.value;

  try {
    taskkill.kill("SIGKILL");
  } catch {
    // The bounded failure below remains authoritative if the taskkill helper
    // itself cannot be interrupted.
  }
  return {
    state: "failed",
    code: "termination_failed",
    message: "taskkill.exe did not exit before the bounded cleanup deadline."
  };
}

async function terminateInjectedChild(
  proc: ChildProcess,
  closedPromise: Promise<void>,
  graceMs: number,
  waitImpl: (durationMs: number) => Promise<void>
): Promise<ProcessTreeCleanupResult> {
  try {
    if (!proc.kill("SIGTERM")) {
      return {
        state: "failed",
        code: "termination_failed",
        message: "Injected child rejected its own termination request."
      };
    }
  } catch (error) {
    return cleanupFailure("termination_failed", error);
  }
  return waitForOwnedClose(closedPromise, graceMs, waitImpl);
}

async function waitForOwnedClose(
  closedPromise: Promise<void>,
  graceMs: number,
  waitImpl: (durationMs: number) => Promise<void>
): Promise<ProcessTreeCleanupResult> {
  if (await closesWithin(closedPromise, graceMs, waitImpl)) return { state: "closed" };
  return {
    state: "failed",
    code: "tree_close_timeout",
    message: "Owned process tree did not report close before the bounded cleanup deadline."
  };
}

async function closesWithin(
  closedPromise: Promise<void>,
  durationMs: number,
  waitImpl: (durationMs: number) => Promise<void>
): Promise<boolean> {
  return Promise.race([
    closedPromise.then(() => true),
    waitImpl(durationMs).then(() => false)
  ]);
}

function cleanupFailure(
  code: ProcessTreeCleanupFailureCode,
  error: unknown
): Extract<ProcessTreeCleanupResult, { state: "failed" }> {
  return {
    state: "failed",
    code,
    message: error instanceof Error ? error.message : String(error)
  };
}

function isOwnedPid(pid: number | undefined): pid is number {
  return Number.isSafeInteger(pid) && (pid ?? 0) > 0;
}

function hasCompleteTestTerminationSeams(value: unknown): value is ProcessSupervisorTestSeams {
  if (typeof value !== "object" || value === null) return false;
  const seams = value as Record<string, unknown>;
  if (typeof seams.wait !== "function") return false;
  if (seams.platform === "win32") return typeof seams.taskkillSpawnImpl === "function";
  return typeof seams.platform === "string" && typeof seams.killProcessGroup === "function";
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

const spawnProcess: ProcessSpawnLike = (command, args, options) =>
  spawn(command, [...(args ?? [])], options ?? {});
