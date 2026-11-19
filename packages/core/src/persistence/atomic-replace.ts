import { rename } from "node:fs/promises";

const TRANSIENT_WINDOWS_FILE_SYSTEM_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

export interface TransientWindowsFileSystemRetryOptions {
  platform?: NodeJS.Platform;
  deadlineMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
}

export interface AtomicRenameOptions extends TransientWindowsFileSystemRetryOptions {
  renameFile?: (source: string, destination: string) => Promise<void>;
}

/**
 * Retry only the small set of Windows errors produced when a sync or security
 * filter briefly denies an otherwise valid filesystem operation. Semantic
 * errors such as EEXIST are returned immediately to the caller so lock and CAS
 * ownership rules remain authoritative.
 */
export async function retryTransientWindowsFileSystemOperation<T>(
  operation: () => Promise<T>,
  options: TransientWindowsFileSystemRetryOptions = {}
): Promise<T> {
  const platform = options.platform ?? process.platform;
  const deadlineMs = options.deadlineMs ?? 2_000;
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  }));
  const now = options.now ?? Date.now;
  let deadline: number | undefined;
  let delayMs = 10;

  for (;;) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        platform !== "win32" ||
        !code ||
        !TRANSIENT_WINDOWS_FILE_SYSTEM_CODES.has(code)
      ) {
        throw error;
      }
      const observedAt = now();
      deadline ??= observedAt + deadlineMs;
      const remainingMs = deadline - observedAt;
      if (remainingMs <= 0) throw error;
      await sleep(Math.min(delayMs, remainingMs));
      delayMs = Math.min(delayMs * 2, 100);
    }
  }
}

/**
 * Preserve atomic replacement semantics when Windows briefly denies a rename
 * because a sync or security filter has the destination open. The destination
 * is never unlinked, copied, or rewritten in place; non-transient failures and
 * an exhausted bounded deadline fail closed with the native filesystem error.
 */
export async function renameAtomically(
  source: string,
  destination: string,
  options: AtomicRenameOptions = {}
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const deadlineMs = options.deadlineMs ?? 2_000;
  const renameFile = options.renameFile ?? rename;
  await retryTransientWindowsFileSystemOperation(
    () => renameFile(source, destination),
    { ...options, platform, deadlineMs }
  );
}
