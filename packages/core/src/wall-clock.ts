/** Schedule an absolute deadline without Node's signed 32-bit timer overflow. */
export function scheduleWallClock(deadlineMs: number, nowMs: () => number, onDeadline: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  function arm(): void {
    timer = setTimeout(() => {
      if (nowMs() < deadlineMs) arm();
      else onDeadline();
    }, Math.min(2_147_483_647, Math.max(0, deadlineMs - nowMs())));
    timer.unref?.();
  }
  arm();
  return () => clearTimeout(timer);
}
