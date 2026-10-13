import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { executeCli } from "../src/index.js";
import { readMartinMcpInstallLedger } from "../src/mcp-install-state.js";

const MANAGED_ENVIRONMENT_KEYS = ["HOME", "USERPROFILE", "CODEX_HOME", "MARTIN_RUNS_DIR"] as const;

interface CliJsonResult {
  exitCode: number;
  stderr: string;
  payload: Record<string, unknown>;
}

interface PortabilityCase {
  label: string;
  platform: "windows" | "linux";
  customRunsRoot: (root: string) => string;
}

const portabilityCases: PortabilityCase[] = [
  {
    label: "Home A with a Windows-shaped explicit root",
    platform: "windows",
    customRunsRoot: () => "X:\\portable-martin\\runs"
  },
  {
    label: "Home B with a POSIX-shaped explicit root",
    platform: "linux",
    customRunsRoot: () => "/opt/portable-martin/runs"
  }
];

async function executeJson(args: string[]): Promise<CliJsonResult> {
  const result = await executeCli(["--json", ...args]);
  return {
    exitCode: result.exitCode,
    stderr: result.stderr,
    payload: result.stdout.length > 0 ? JSON.parse(result.stdout) as Record<string, unknown> : {}
  };
}

async function withIsolatedHome<T>(
  root: string,
  callback: (input: { home: string; project: string; stateRoot: string }) => Promise<T>
): Promise<T> {
  const originals = new Map(MANAGED_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
  const home = join(root, "home");
  const project = join(root, "project");
  const stateRoot = join(home, ".martin", "mcp-installs");

  await mkdir(join(project, ".codex"), { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CODEX_HOME = join(home, ".codex-agent");
  delete process.env.MARTIN_RUNS_DIR;

  try {
    return await callback({ home, project, stateRoot });
  } finally {
    for (const [key, value] of originals) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe.sequential("project Codex MCP portability lifecycle", () => {
  it.each(portabilityCases)(
    "keeps default and explicit installs portable across two home shapes: $label",
    async ({ platform, customRunsRoot }) => {
      const root = await mkdtemp(join(tmpdir(), "martin-mcp-portability-"));

      try {
        await withIsolatedHome(root, async ({ home, project, stateRoot }) => {
          const configPath = join(project, ".codex", "config.toml");
          const unrelatedLedgerRecord = {
            id: `unrelated-${platform}`,
            host: "claude",
            scope: "project",
            targetPath: join(root, "unrelated", "config.json"),
            installedSha256: "0".repeat(64),
            backupPath: null,
            installedAt: "2026-01-01T00:00:00.000Z"
          };
          const originalConfig = [
            "# operator prefix",
            "model = \"gpt-5\"",
            "",
            "[projects.\"external\"]",
            "trust_level = \"trusted\"",
            "# operator suffix",
            ""
          ].join("\n");
          await writeFile(configPath, originalConfig, "utf8");
          await mkdir(stateRoot, { recursive: true });
          await writeFile(
            join(stateRoot, "install-state.json"),
            `${JSON.stringify({ schemaVersion: 1, installs: [unrelatedLedgerRecord] }, null, 2)}\n`,
            "utf8"
          );

          const defaultInstall = await executeJson([
            "mcp", "install", "--host", "codex", "--scope", "project",
            "--cwd", project, "--platform", platform
          ]);
          expect(defaultInstall.exitCode).toBe(0);
          expect(defaultInstall.payload).toMatchObject({
            command: "mcp_install",
            targetPath: configPath
          });

          const defaultConfig = await readFile(configPath, "utf8");
          expect(defaultConfig).toContain("# operator prefix");
          expect(defaultConfig).toContain("# operator suffix");
          expect(defaultConfig).not.toContain("MARTIN_RUNS_DIR");
          expect(defaultConfig).not.toContain(home);

          const defaultVerify = await executeJson([
            "mcp", "verify-install", "--host", "codex", "--scope", "project", "--cwd", project
          ]);
          expect(defaultVerify.exitCode).toBe(0);
          expect(defaultVerify.payload).toMatchObject({ command: "mcp_verify_install", status: "ok" });

          const defaultRollback = await executeJson([
            "mcp", "rollback", "--host", "codex", "--scope", "project", "--cwd", project
          ]);
          expect(defaultRollback.exitCode).toBe(0);
          expect(await readFile(configPath, "utf8")).toBe(originalConfig);
          expect((await readMartinMcpInstallLedger(stateRoot)).installs).toEqual([unrelatedLedgerRecord]);

          const chosenRunsRoot = customRunsRoot(root);
          const explicitInstall = await executeJson([
            "mcp", "install", "--host", "codex", "--scope", "project",
            "--cwd", project, "--runs-dir", chosenRunsRoot, "--platform", platform
          ]);
          expect(explicitInstall.exitCode).toBe(0);

          const explicitConfig = await readFile(configPath, "utf8");
          expect(explicitConfig).toContain("# operator prefix");
          expect(explicitConfig).toContain("# operator suffix");
          expect(explicitConfig).toContain("MARTIN_RUNS_DIR");
          expect(explicitConfig).toContain(chosenRunsRoot.replaceAll("\\", "\\\\"));
          expect(explicitConfig).not.toContain(home);

          const explicitVerify = await executeJson([
            "mcp", "verify-install", "--host", "codex", "--scope", "project",
            "--cwd", project, "--runs-dir", chosenRunsRoot
          ]);
          expect(explicitVerify.exitCode).toBe(0);
          expect(explicitVerify.payload).toMatchObject({ command: "mcp_verify_install", status: "ok" });

          const ledger = await readMartinMcpInstallLedger(stateRoot);
          expect(ledger.installs).toHaveLength(2);
          expect(ledger.installs[0]).toEqual(unrelatedLedgerRecord);
          expect(ledger.installs[1]).toMatchObject({
            host: "codex",
            scope: "project",
            targetPath: configPath
          });

          await writeFile(configPath, `${explicitConfig}# operator tamper\n`, "utf8");
          const tamperedVerify = await executeJson([
            "mcp", "verify-install", "--host", "codex", "--scope", "project",
            "--cwd", project, "--runs-dir", chosenRunsRoot
          ]);
          expect(tamperedVerify.exitCode).not.toBe(0);
          expect(tamperedVerify.payload).toMatchObject({ ok: false, category: "environment" });
          expect(tamperedVerify.payload.message).toContain("modified");

          for (const destructiveCommand of ["rollback", "uninstall"]) {
            const refused = await executeJson([
              "mcp", destructiveCommand, "--host", "codex", "--scope", "project",
              "--cwd", project, "--runs-dir", chosenRunsRoot
            ]);
            expect(refused.exitCode).not.toBe(0);
            expect(refused.payload).toMatchObject({ ok: false });
            expect(refused.payload.message).toContain("verification is modified");
            expect(await readFile(configPath, "utf8")).toContain("# operator tamper");
            expect((await readMartinMcpInstallLedger(stateRoot)).installs).toHaveLength(2);
          }

          await writeFile(configPath, explicitConfig, "utf8");
          const restoredRollback = await executeJson([
            "mcp", "rollback", "--host", "codex", "--scope", "project",
            "--cwd", project, "--runs-dir", chosenRunsRoot
          ]);
          expect(restoredRollback.exitCode).toBe(0);
          expect(await readFile(configPath, "utf8")).toBe(originalConfig);
          expect((await readMartinMcpInstallLedger(stateRoot)).installs).toEqual([unrelatedLedgerRecord]);

          for (let attempt = 0; attempt < 2; attempt += 1) {
            const reinstall = await executeJson([
              "mcp", "install", "--host", "codex", "--scope", "project",
              "--cwd", project, "--runs-dir", chosenRunsRoot, "--platform", platform
            ]);
            expect(reinstall.exitCode).toBe(0);
          }

          const reinstalledVerify = await executeJson([
            "mcp", "verify-install", "--host", "codex", "--scope", "project",
            "--cwd", project, "--runs-dir", chosenRunsRoot
          ]);
          expect(reinstalledVerify.exitCode).toBe(0);

          const beforeUninstall = await readMartinMcpInstallLedger(stateRoot);
          expect(beforeUninstall.installs.filter((record) => record.host === "codex")).toHaveLength(2);

          const uninstall = await executeJson([
            "mcp", "uninstall", "--host", "codex", "--scope", "project",
            "--cwd", project, "--runs-dir", chosenRunsRoot
          ]);
          expect(uninstall.exitCode).toBe(0);
          expect(uninstall.payload.command).toBe("mcp_uninstall");
          expect(uninstall.payload.records).toHaveLength(2);
          expect(await readFile(configPath, "utf8")).toBe(originalConfig);
          expect((await readMartinMcpInstallLedger(stateRoot)).installs).toEqual([unrelatedLedgerRecord]);
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000
  );
});
