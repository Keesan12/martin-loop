// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

export interface RunFiveSummary {
  /** Total successful governed runs. Do not pass if unavailable — omit rather than guess. */
  completedRuns: number;
}

async function readSingleKeypress(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) { resolve(""); return; }
    const prev = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");
    const timeout = setTimeout(() => { cleanup(); resolve(""); }, 15_000);
    const onData = (key: string) => {
      if (key === "\u0003") { cleanup(); process.exit(0); }
      cleanup();
      resolve(key);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      stdin.removeListener("data", onData);
      try { stdin.setRawMode(prev ?? false); } catch { /* ignore */ }
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}

export async function renderRunFiveFeedback(summary: RunFiveSummary): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return;

  process.stdout.write("\n");
  process.stdout.write(`MartinLoop has completed ${summary.completedRuns} successful governed runs.\n\n`);
  process.stdout.write(`Has MartinLoop been useful?\n`);
  process.stdout.write(`  1  2  3  4  5\n\n`);
  process.stdout.write(`What should we improve?\n`);
  process.stdout.write(`  [s] Speed   [r] Reliability   [u] UX   [i] Integrations   [x] Skip\n`);
  process.stdout.write(`  > `);

  const key = await readSingleKeypress();
  process.stdout.write(`${key}\n\n`);
}
