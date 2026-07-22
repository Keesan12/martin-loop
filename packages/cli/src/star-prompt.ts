import { readRunStats, writeRunStats } from "./run-stats.js";

const STAR_URL = "https://github.com/Keesan12/martin-loop";

export function shouldShowStarPrompt(runCount: number, lastShownAt: number): boolean {
  if (runCount === 2) return true;
  if (runCount > 2 && (runCount - lastShownAt) >= 25) return true;
  return false;
}

export async function maybeShowStarPrompt(runCount: number): Promise<void> {
  const stats = readRunStats();
  if (stats.starPromptOptOut) return;
  if (!shouldShowStarPrompt(runCount, stats.lastStarPromptAtRun)) return;

  const isFirstTime = runCount === 2;

  console.log("");
  if (isFirstTime) {
    console.log("✨  Two runs down. MartinLoop is doing its job.");
    console.log("");
    console.log("    It's open source and stays free because of the team");
    console.log("    behind it. If it's earning a place in your workflow, a ⭐");
    console.log("    on GitHub helps other developers find it:");
  } else {
    console.log(`✨  Run #${runCount} with MartinLoop — genuinely appreciate it.`);
    console.log("    A quick ⭐ on GitHub helps other devs find this project:");
  }

  console.log(`\n    ${STAR_URL}\n`);
  console.log("    [Enter] open in browser   [s] skip   [n] never ask again");
  process.stdout.write("    > ");

  const key = await readSingleKeypress();
  console.log("");

  if (key === "n" || key === "N") {
    stats.starPromptOptOut = true;
    console.log("    Got it — won't ask again. To re-enable: martin config set star-prompt on\n");
  } else if (key === "\r" || key === "\n") {
    try {
      const { exec } = await import("node:child_process");
      const cmd = process.platform === "win32" ? `start "" "${STAR_URL}"`
        : process.platform === "darwin" ? `open "${STAR_URL}"`
        : `xdg-open "${STAR_URL}"`;
      exec(cmd);
      console.log("    Opening GitHub... ⭐\n");
    } catch {
      console.log(`    Open this in your browser: ${STAR_URL}\n`);
    }
  }

  stats.lastStarPromptAtRun = runCount;
  writeRunStats(stats);
}

export async function showInlineStarCta(): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return;
  console.log("");
  console.log("─────────────────────────────────────────────");
  console.log("⭐ MartinLoop saved you from a runaway bill.");
  console.log(`   ${STAR_URL}`);
  console.log("");
  console.log("   [Enter] open in browser   [s] skip");
  process.stdout.write("   > ");
  const key = await readSingleKeypress();
  console.log("");
  if (key === "\r" || key === "\n") {
    try {
      const { exec } = await import("node:child_process");
      const cmd = process.platform === "win32" ? `start "" "${STAR_URL}"`
        : process.platform === "darwin" ? `open "${STAR_URL}"`
        : `xdg-open "${STAR_URL}"`;
      exec(cmd);
      console.log("   Opening GitHub... ⭐");
    } catch {
      console.log(`   Open this in your browser: ${STAR_URL}`);
    }
  }
  console.log("─────────────────────────────────────────────");
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
      stdin.setRawMode(prev ?? false);
      stdin.pause();
    };

    stdin.on("data", onData);
  });
}
