// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

// ─── Version check ────────────────────────────────────────────────────────────

function semverGt(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);
  if (aMaj !== bMaj) return (aMaj ?? 0) > (bMaj ?? 0);
  if (aMin !== bMin) return (aMin ?? 0) > (bMin ?? 0);
  return (aPat ?? 0) > (bPat ?? 0);
}

export async function fetchLatestNpmVersion(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3000
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      "https://registry.npmjs.org/martin-loop/latest",
      {
        headers: { accept: "application/json" },
        signal: controller.signal,
      }
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { version?: unknown };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Installation channel detection ──────────────────────────────────────────

export type InstallChannel = "global-npm" | "npx" | "native" | "source" | "unknown";

export function detectInstallChannel(env: NodeJS.ProcessEnv = process.env): InstallChannel {
  // Native installer sets a build-time constant
  if (typeof (globalThis as Record<string, unknown>)["__MARTIN_NATIVE_PACKAGE_VERSION__"] === "string") {
    return "native";
  }
  // Running via npx: npm_lifecycle_script contains npx or _
  if (env["npm_execpath"]?.includes("npx") || env["npm_command"] === "exec") {
    return "npx";
  }
  // Global npm install: npm_config_global is "true"
  if (env["npm_config_global"] === "true") {
    return "global-npm";
  }
  // npm_lifecycle_event present without npm_config_global suggests local/source
  if (env["npm_lifecycle_event"]) {
    return "source";
  }
  return "unknown";
}

// ─── Suppression guard ────────────────────────────────────────────────────────

export interface UpdatePromptInput {
  currentVersion: string;
  interactiveTty: boolean;
  outputMode: string;
  ci: boolean;
  command: string;
  channel: InstallChannel;
}

export function shouldShowUpdatePrompt(input: UpdatePromptInput): boolean {
  if (input.channel !== "global-npm") return false;
  if (!input.interactiveTty) return false;
  if (input.ci) return false;
  if (input.outputMode !== "human") return false;
  // Suppress for meta-commands that don't run governed code
  const suppress = new Set(["help", "version", "telemetry", "update"]);
  if (suppress.has(input.command)) return false;
  return true;
}

// ─── Raw keypress ─────────────────────────────────────────────────────────────

async function readUpdateKey(): Promise<"y" | "l"> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) { resolve("l"); return; }
    const prev = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");
    const timeout = setTimeout(() => { cleanup(); resolve("l"); }, 30_000);
    const onData = (key: string) => {
      if (key === "\u0003") { cleanup(); process.exit(0); }
      cleanup();
      resolve(key.toLowerCase() === "y" ? "y" : "l");
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

// ─── Update execution ─────────────────────────────────────────────────────────

export function runNpmUpdate(): { success: boolean; error?: string } {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCmd, ["install", "--global", "martin-loop@latest"], {
    stdio: "inherit",
    shell: false,
  });
  if (result.status === 0) return { success: true };
  return { success: false, error: result.error?.message ?? `exit ${result.status ?? "unknown"}` };
}

// ─── Prompt display ───────────────────────────────────────────────────────────

/**
 * Shows the startup update prompt.
 * Returns:
 *   false     — prompt not shown (not a newer version, wrong channel, suppressed)
 *   "deferred" — prompt shown, user pressed L/Enter/timeout (original command continues)
 *   "updated"  — prompt shown, user pressed Y (update was attempted; do not continue original command)
 */
export async function maybeShowUpdatePrompt(
  currentVersion: string,
  fetchImpl?: typeof fetch
): Promise<false | "deferred" | "updated"> {
  const channel = detectInstallChannel();
  if (channel !== "global-npm") return false;

  const latest = await fetchLatestNpmVersion(fetchImpl);
  if (!latest || !semverGt(latest, currentVersion)) return false;

  process.stdout.write("\n");
  process.stdout.write(`MartinLoop ${latest} is available. You are running ${currentVersion}.\n\n`);
  process.stdout.write("  [Y] Update now   [L] Later\n\n");
  process.stdout.write("  > ");

  const key = await readUpdateKey();
  process.stdout.write(`${key.toUpperCase()}\n\n`);

  if (key === "y") {
    process.stdout.write("Running: npm install --global martin-loop@latest\n\n");
    const result = runNpmUpdate();
    if (result.success) {
      process.stdout.write(
        `Updated to ${latest}. Please rerun your command in a new terminal.\n\n`
      );
    } else {
      process.stdout.write(
        `Update failed: ${result.error ?? "unknown error"}. Run manually:\n` +
        `  npm install --global martin-loop@latest\n\n`
      );
    }
    return "updated";
  }

  // L/Enter/timeout: prompt shown but user deferred.
  return "deferred";
}
