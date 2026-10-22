/**
 * Regression tests for preflight allowed-path traversal rejection.
 *
 * Addresses Atlas FL-011 (allow_path_traversal_rejected), FL-012 (allow_path_absolute_rejected),
 * and FL-013 (deny_path_escape). Preflight must return ready:false with a blocking issue
 * for any path that escapes the working directory — before any provider spend occurs.
 *
 * Valid relative paths within the repo must still reach ready:true (or fail only on
 * unrelated blocking issues such as missing engine, not path rejection).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { executeCli } from "../src/index.js";

const NOOP_VERIFIER = process.platform === "win32" ? "cmd /c exit 0" : "true";
const ESCAPING_PATH_FRAGMENT = "allowed-path escapes the working directory";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "martin-preflight-path-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

async function runPreflight(workspace: string, extraArgs: string[]): Promise<{ exitCode: number; payload: Record<string, unknown> }> {
  const result = await executeCli([
    "--json",
    "preflight",
    "--engine",
    "claude",
    "--cwd",
    workspace,
    "--objective",
    "Test path validation",
    "--verify",
    NOOP_VERIFIER,
    "--proof",
    ...extraArgs,
  ]);
  const payload = JSON.parse(result.stdout) as Record<string, unknown>;
  return { exitCode: result.exitCode, payload };
}

describe("preflight path traversal rejection (FL-011/FL-012/FL-013)", () => {
  it("blocks a POSIX relative traversal allowed-path (../outside)", async () => {
    await withTempDir(async (workspace) => {
      const { exitCode, payload } = await runPreflight(workspace, ["--allow-path", "../outside"]);
      expect(exitCode).toBe(0); // preflight always exits 0; ready flag carries the verdict
      expect(payload.ready).toBe(false);
      const issues = payload.blockingIssues as string[];
      expect(issues.some((i) => i.includes(ESCAPING_PATH_FRAGMENT))).toBe(true);
    });
  });

  it("blocks a Windows-style relative traversal allowed-path (..\\outside)", async () => {
    await withTempDir(async (workspace) => {
      const { exitCode, payload } = await runPreflight(workspace, ["--allow-path", "..\\outside"]);
      expect(exitCode).toBe(0);
      expect(payload.ready).toBe(false);
      const issues = payload.blockingIssues as string[];
      expect(issues.some((i) => i.includes(ESCAPING_PATH_FRAGMENT))).toBe(true);
    });
  });

  it("blocks a bare .. allowed-path", async () => {
    await withTempDir(async (workspace) => {
      const { exitCode, payload } = await runPreflight(workspace, ["--allow-path", ".."]);
      expect(exitCode).toBe(0);
      expect(payload.ready).toBe(false);
      const issues = payload.blockingIssues as string[];
      expect(issues.some((i) => i.includes(ESCAPING_PATH_FRAGMENT))).toBe(true);
    });
  });

  it("blocks an absolute POSIX allowed-path (/etc/passwd)", async () => {
    await withTempDir(async (workspace) => {
      const { exitCode, payload } = await runPreflight(workspace, ["--allow-path", "/etc/passwd"]);
      expect(exitCode).toBe(0);
      expect(payload.ready).toBe(false);
      const issues = payload.blockingIssues as string[];
      expect(issues.some((i) => i.includes(ESCAPING_PATH_FRAGMENT))).toBe(true);
    });
  });

  it("blocks a Windows drive-letter absolute allowed-path (C:/Windows)", async () => {
    await withTempDir(async (workspace) => {
      const { exitCode, payload } = await runPreflight(workspace, ["--allow-path", "C:/Windows"]);
      expect(exitCode).toBe(0);
      expect(payload.ready).toBe(false);
      const issues = payload.blockingIssues as string[];
      expect(issues.some((i) => i.includes(ESCAPING_PATH_FRAGMENT))).toBe(true);
    });
  });

  it("blocks a UNC allowed-path (//server/share)", async () => {
    await withTempDir(async (workspace) => {
      const { exitCode, payload } = await runPreflight(workspace, ["--allow-path", "//server/share"]);
      expect(exitCode).toBe(0);
      expect(payload.ready).toBe(false);
      const issues = payload.blockingIssues as string[];
      expect(issues.some((i) => i.includes(ESCAPING_PATH_FRAGMENT))).toBe(true);
    });
  });

  it("blocks a traversal segment mid-path (folder/../../outside)", async () => {
    await withTempDir(async (workspace) => {
      const { exitCode, payload } = await runPreflight(workspace, ["--allow-path", "folder/../../outside"]);
      expect(exitCode).toBe(0);
      expect(payload.ready).toBe(false);
      const issues = payload.blockingIssues as string[];
      expect(issues.some((i) => i.includes(ESCAPING_PATH_FRAGMENT))).toBe(true);
    });
  });

  it("does NOT block a valid relative allowed-path (src/**)", async () => {
    await withTempDir(async (workspace) => {
      const { exitCode, payload } = await runPreflight(workspace, ["--allow-path", "src/**"]);
      expect(exitCode).toBe(0);
      // Valid path — blocking issues must not mention escaping paths
      const issues = (payload.blockingIssues as string[] | undefined) ?? [];
      expect(issues.some((i) => i.includes(ESCAPING_PATH_FRAGMENT))).toBe(false);
    });
  });

  it("does NOT block a valid nested relative allowed-path (packages/cli/src/**)", async () => {
    await withTempDir(async (workspace) => {
      const { exitCode, payload } = await runPreflight(workspace, ["--allow-path", "packages/cli/src/**"]);
      expect(exitCode).toBe(0);
      const issues = (payload.blockingIssues as string[] | undefined) ?? [];
      expect(issues.some((i) => i.includes(ESCAPING_PATH_FRAGMENT))).toBe(false);
    });
  });

  it("also blocks escaping denied-paths", async () => {
    await withTempDir(async (workspace) => {
      const { exitCode, payload } = await runPreflight(workspace, [
        "--allow-path", "src/**",
        "--deny-path", "../secret",
      ]);
      expect(exitCode).toBe(0);
      expect(payload.ready).toBe(false);
      const issues = payload.blockingIssues as string[];
      // denied-path escape message is distinct from allowed-path escape message
      expect(issues.some((i) => i.includes("denied-path escapes the working directory"))).toBe(true);
    });
  });
});

// ── martin run blocks invalid scope before provider launch ───────────────────
// Proves that the path confinement policy is enforced at the run level, not only
// at the preflight level.  When `martin run` is invoked, it calls
// executePreflightCommand internally; if ready:false, it throws CliCommandError
// (invalid_input, exit 2) before any provider child is spawned, any budget is
// consumed, or any loop record is written to the runs root.
describe("martin run path scope enforcement before provider launch", () => {
  it("exits non-zero and creates no loop when --allow-path escapes working directory", async () => {
    const { readdir, mkdir } = await import("node:fs/promises");
    await withTempDir(async (workspace) => {
      const runsDir = join(workspace, ".martin-runs");
      await mkdir(runsDir, { recursive: true });

      const prevRunsDir = process.env.MARTIN_RUNS_DIR;
      process.env.MARTIN_RUNS_DIR = runsDir;
      try {
        const result = await executeCli([
          "run",
          "Fix the config",
          "--engine", "claude",
          "--cwd", workspace,
          "--verify", NOOP_VERIFIER,
          "--proof",
          "--allow-path", "../outside",
        ]);

        // Preflight must have rejected the request before provider launch
        expect(result.exitCode).not.toBe(0);

        // The blocking message must mention the escaping path
        const combined = result.stdout + result.stderr;
        expect(combined).toMatch(/escapes the working directory|Governed run preflight blocked/i);

        // No loop record must have been written — the runs root remains empty
        const runsEntries = await readdir(runsDir).catch(() => [] as string[]);
        const loopDirs = runsEntries.filter((e) => e.startsWith("loop_"));
        expect(loopDirs).toHaveLength(0);
      } finally {
        if (prevRunsDir === undefined) delete process.env.MARTIN_RUNS_DIR;
        else process.env.MARTIN_RUNS_DIR = prevRunsDir;
      }
    });
  });
});
