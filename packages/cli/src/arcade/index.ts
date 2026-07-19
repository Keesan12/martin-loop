export { playWhileWaiting } from "./space-invaders.js";
export type { ArcadeOptions } from "./space-invaders.js";

export interface ArcadePromptOptions {
  /** ms to wait before prompting. Default: 30_000 */
  promptAfterMs?: number;
  /** Skip the wait and start/offer the game immediately. */
  force?: boolean;
  /** Never prompt — pass-through mode. */
  disabled?: boolean;
}

/**
 * Waits `promptAfterMs` for the task to finish. If it is still running,
 * prompts once in an interactive terminal. If the user accepts, plays
 * Space Invaders while the task continues. Always returns the task result.
 *
 * Never prompts in CI, non-TTY, or when disabled.
 */
export async function maybePlayArcadeWhileWaiting<T>(
  task: Promise<T>,
  opts: ArcadePromptOptions = {}
): Promise<T> {
  const { promptAfterMs = 30_000, force = false, disabled = false } = opts;

  const isInteractive =
    process.stdout.isTTY === true &&
    process.stdin.isTTY === true &&
    !process.env["CI"];

  if (disabled || !isInteractive) {
    return task;
  }

  if (force) {
    const { playWhileWaiting } = await import("./space-invaders.js");
    return playWhileWaiting(task);
  }

  // Race the task against the prompt delay.
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const delayPromise = new Promise<void>(resolve => {
    timerId = setTimeout(resolve, promptAfterMs);
  });

  type Raced<V> = { done: true; value: V } | { done: false };
  const outcome = await Promise.race<Raced<T>>([
    task.then((v): Raced<T> => ({ done: true, value: v })),
    delayPromise.then((): Raced<T> => ({ done: false }))
  ]);

  if (outcome.done) {
    clearTimeout(timerId);
    return outcome.value;
  }

  // Task is still running — prompt once.
  const accepted = await promptOnce();
  if (accepted) {
    const { playWhileWaiting } = await import("./space-invaders.js");
    return playWhileWaiting(task);
  }
  return task;
}

/**
 * Prompt the user once for the arcade. Returns true if they pressed y/Y.
 * Times out after 15 s and returns false. Restores terminal state on exit.
 */
async function promptOnce(): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const stdin = process.stdin;
    if (!stdin.isTTY) { resolve(false); return; }

    const prevRaw = stdin.isRaw;

    const cleanup = (answer: boolean) => {
      clearTimeout(autoNo);
      stdin.removeListener("data", onKey);
      try { stdin.setRawMode(prevRaw ?? false); } catch { /* ignore */ }
      stdin.pause();
      resolve(answer);
    };

    // Auto-decline after 15 s so unattended runs are never blocked.
    const autoNo = setTimeout(() => {
      process.stdout.write("n\n");
      cleanup(false);
    }, 15_000);

    try {
      stdin.setRawMode(true);
    } catch {
      // setRawMode can fail in certain environments — fall back to no prompt.
      clearTimeout(autoNo);
      resolve(false);
      return;
    }
    stdin.resume();
    stdin.setEncoding("utf-8");

    process.stdout.write(
      "\n\x1b[36mStill working.\x1b[0m " +
      "Play \x1b[1mMartinLoop Arcade\x1b[0m while you wait? " +
      "[\x1b[32my\x1b[0m/\x1b[2mN\x1b[0m] "
    );

    const onKey = (key: string) => {
      // Ctrl+C — honour it even mid-prompt.
      if (key === "\u0003") { process.stdout.write("\n"); cleanup(false); process.exit(130); }
      const accepted = key === "y" || key === "Y";
      process.stdout.write(accepted ? "y\n" : "n\n");
      cleanup(accepted);
    };

    stdin.on("data", onKey);
  });
}
