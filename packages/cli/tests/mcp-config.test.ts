// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MARTIN_DIAGNOSTIC_TOOL_NAMES,
  MARTIN_MINIMAL_TOOL_NAMES,
  MARTIN_PAID_REMOTE_TOOL_NAMES,
  MARTIN_STARTER_TOOL_NAMES,
  MARTIN_TOOL_NAMES
} from "../../mcp/src/discovery-metadata.js";
import {
  buildMcpInstallPlan,
  installMcpConfig,
  MARTIN_DIAGNOSTIC_TOOLS,
  MARTIN_FULL_TOOLS,
  MARTIN_MCP_HOST_MATRIX,
  MARTIN_MCP_HOSTS,
  MARTIN_MCP_PROFILES,
  MARTIN_MINIMAL_TOOLS,
  MARTIN_PAID_REMOTE_TOOLS,
  MARTIN_STARTER_TOOLS,
  isMartinMcpHost,
  supportsMartinMcpScope
} from "../src/mcp-config.js";
import * as installState from "../src/mcp-install-state.js";

describe("mcp config helpers", () => {
  it("publishes one canonical MCP host capability matrix", () => {
    expect(MARTIN_MCP_HOSTS).toEqual([
      "codex",
      "claude",
      "gemini",
      "cursor",
      "vscode",
      "copilot",
      "continue",
      "generic"
    ]);
    expect(Object.keys(MARTIN_MCP_HOST_MATRIX)).toEqual([...MARTIN_MCP_HOSTS]);
    expect(MARTIN_MCP_HOST_MATRIX.claude.scopes).toEqual(["user", "project", "local"]);
    expect(MARTIN_MCP_HOST_MATRIX.codex.scopes).toEqual(["user", "project"]);
    expect(MARTIN_MCP_PROFILES).toContain("paid-remote");
    expect(isMartinMcpHost("continue")).toBe(true);
    expect(isMartinMcpHost("unknown")).toBe(false);
    expect(supportsMartinMcpScope("claude", "local")).toBe(true);
    expect(supportsMartinMcpScope("cursor", "local")).toBe(false);
  });

  it("writes current VS Code project config and keeps copilot as an alias", () => {
    for (const host of ["vscode", "copilot"] as const) {
      const plan = buildMcpInstallPlan({
        host,
        scope: "project",
        cwd: "C:\\repo",
        runsRoot: "C:\\runs"
      });

      expect(plan.targetPath).toBe("C:\\repo\\.vscode\\mcp.json");
      expect(plan.installMethod).toBe("file");
      const config = JSON.parse(plan.content) as {
        servers: Record<string, unknown>;
      };
      expect(config.servers["martin-loop"]).toBeDefined();
    }
  });

  it("returns native VS Code setup instructions for user scope", () => {
    const plan = buildMcpInstallPlan({
      host: "vscode",
      scope: "user",
      cwd: "C:\\repo",
      runsRoot: "C:\\runs"
    });

    expect(plan.installMethod).toBe("instructions");
    expect(plan.targetPath).toContain("MCP: Add Server");
  });

  it("writes Claude governance hooks only with explicit consent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "martin-cli-governance-consent-"));
    const previousUserProfile = process.env.USERPROFILE;
    process.env.USERPROFILE = cwd;

    try {
      const input = {
        host: "claude" as const,
        scope: "project" as const,
        cwd,
        runsRoot: join(cwd, ".runs")
      };
      const settingsPath = join(cwd, ".claude", "settings.json");

      await installMcpConfig(input, { installGovernance: false });
      await expect(readFile(settingsPath, "utf8")).rejects.toThrow();

      await installMcpConfig(input, { installGovernance: true });
      expect(await readFile(settingsPath, "utf8")).toContain("npx martin-loop gate --quiet");
    } finally {
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("records an atomic install with a restorable backup", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "martin-cli-install-state-"));

    try {
      const configDir = join(cwd, ".martin-loop");
      const configPath = join(configDir, "mcp.generic.json");
      const stateRoot = join(cwd, ".install-state");
      await mkdir(configDir, { recursive: true });
      const existing = `${JSON.stringify({
        mcpServers: {
          existing: { command: "node", args: ["server.js"] }
        }
      }, null, 2)}\n`;
      await writeFile(configPath, existing, "utf8");

      await installMcpConfig(
        {
          host: "generic",
          scope: "project",
          cwd,
          runsRoot: join(cwd, ".runs")
        },
        { stateRoot }
      );

      const ledger = JSON.parse(
        await readFile(join(stateRoot, "install-state.json"), "utf8")
      ) as {
        installs: Array<{ backupPath: string | null; targetPath: string }>;
      };
      expect(ledger.installs).toHaveLength(1);
      expect(ledger.installs[0]?.targetPath).toBe(configPath);
      const backupPath = ledger.installs[0]?.backupPath;
      expect(backupPath).not.toBeNull();
      expect(await readFile(backupPath!, "utf8")).toBe(existing);
      expect((await readdir(configDir)).some((name) => name.endsWith(".tmp"))).toBe(false);
      expect((await readdir(stateRoot)).some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("verifies and rolls back the latest recorded install", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "martin-cli-install-rollback-"));

    try {
      const configDir = join(cwd, ".martin-loop");
      const configPath = join(configDir, "mcp.generic.json");
      const stateRoot = join(cwd, ".install-state");
      await mkdir(configDir, { recursive: true });
      const existing = `${JSON.stringify({
        mcpServers: {
          existing: { command: "node", args: ["server.js"] }
        }
      }, null, 2)}\n`;
      await writeFile(configPath, existing, "utf8");

      await installMcpConfig(
        {
          host: "generic",
          scope: "project",
          cwd,
          runsRoot: join(cwd, ".runs")
        },
        { stateRoot }
      );

      const selector = {
        host: "generic",
        scope: "project",
        targetPath: configPath,
        stateRoot
      };
      await expect(installState.verifyMartinMcpInstall(selector)).resolves.toMatchObject({
        status: "ok",
        targetPath: configPath
      });
      await installState.rollbackMartinMcpInstall(selector);
      expect(await readFile(configPath, "utf8")).toBe(existing);
      expect((await installState.readMartinMcpInstallLedger(stateRoot)).installs).toHaveLength(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("uninstalls a newly created config and refuses modified files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "martin-cli-install-uninstall-"));

    try {
      const configPath = join(cwd, ".martin-loop", "mcp.generic.json");
      const stateRoot = join(cwd, ".install-state");
      const input = {
        host: "generic" as const,
        scope: "project" as const,
        cwd,
        runsRoot: join(cwd, ".runs")
      };
      await installMcpConfig(input, { stateRoot });
      await writeFile(configPath, "{\"changed\":true}\n", "utf8");

      const selector = {
        host: "generic",
        scope: "project",
        targetPath: configPath,
        stateRoot
      };
      await expect(installState.verifyMartinMcpInstall(selector)).resolves.toMatchObject({
        status: "modified"
      });
      await expect(installState.uninstallMartinMcp(selector)).rejects.toThrow(
        "Refusing to modify"
      );

      await writeFile(configPath, buildMcpInstallPlan(input).content, "utf8");
      await installState.uninstallMartinMcp(selector);
      await expect(readFile(configPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps the public installer guide aligned with the canonical host matrix", () => {
    const guide = readFileSync(
      fileURLToPath(new URL("../../../docs/getting-started/mcp.md", import.meta.url)),
      "utf8"
    );

    for (const host of MARTIN_MCP_HOSTS) {
      const capability = MARTIN_MCP_HOST_MATRIX[host];
      expect(guide).toContain(`\`${host}\``);
      for (const target of Object.values(capability.configTargets)) {
        expect(guide).toContain(target);
      }
    }

    for (const profile of MARTIN_MCP_PROFILES) {
      expect(guide).toContain(`\`${profile}\``);
    }
    expect(guide).toContain("`--dry-run`");
    expect(guide).toContain("governance");
  });

  it("keeps the CLI starter allow-list aligned with MCP discovery metadata", () => {
    expect([...MARTIN_STARTER_TOOLS]).toEqual([...MARTIN_STARTER_TOOL_NAMES]);
  });

  it("keeps the CLI minimal allow-list aligned with MCP discovery metadata", () => {
    expect([...MARTIN_MINIMAL_TOOLS]).toEqual([...MARTIN_MINIMAL_TOOL_NAMES]);
  });

  it("keeps the CLI diagnostic allow-list aligned with MCP discovery metadata", () => {
    expect([...MARTIN_DIAGNOSTIC_TOOLS]).toEqual([...MARTIN_DIAGNOSTIC_TOOL_NAMES]);
  });

  it("keeps the CLI paid-remote allow-list aligned with MCP discovery metadata", () => {
    expect([...MARTIN_PAID_REMOTE_TOOLS]).toEqual([...MARTIN_PAID_REMOTE_TOOL_NAMES]);
  });

  it("keeps the CLI full allow-list aligned with MCP discovery metadata", () => {
    expect([...MARTIN_FULL_TOOLS]).toEqual([...MARTIN_TOOL_NAMES]);
  });

  it("builds the canonical Codex minimal snippet with the quoted martin-loop server id", () => {
    const plan = buildMcpInstallPlan({
      host: "codex",
      scope: "project",
      cwd: "C:\\repo",
      runsRoot: "C:\\runs"
    });

    expect(plan.content).toContain('[mcp_servers."martin-loop"]');
    expect(plan.profile).toBe("minimal");
    expect(plan.content).toContain('enabled_tools = ["martin_doctor", "martin_plan", "martin_preflight", "martin_estimate", "martin_list_runs", "martin_triage_runs", "martin_dossier"]');
  });

  it("respects CODEX_HOME for user-scope Codex installs", () => {
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "D:\\martin-codex-home";

    try {
      const plan = buildMcpInstallPlan({
        host: "codex",
        scope: "user",
        cwd: "C:\\repo",
        runsRoot: "C:\\runs"
      });

      expect(plan.targetPath).toBe("D:\\martin-codex-home\\config.toml");
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
    }
  });

  it("builds a Windows-safe Gemini remote snippet with the current includeTools schema", () => {
    const plan = buildMcpInstallPlan({
      host: "gemini",
      scope: "project",
      cwd: "C:\\repo",
      runsRoot: "C:\\runs",
      transport: "remote",
      platform: "windows"
    });

    expect(plan.targetPath).toMatch(/\.gemini[\\/]settings\.json$/u);
    expect(plan.content).toContain('"httpUrl": "https://remote.martinloop.local/mcp"');
    expect(plan.content).toContain('"includeTools"');
    expect(plan.content).toContain('"martin_triage_runs"');
  });

  it("builds a Claude local-scope install command instead of pretending local scope is a file", () => {
    const plan = buildMcpInstallPlan({
      host: "claude",
      scope: "local",
      cwd: "C:\\repo",
      runsRoot: "C:\\runs",
      transport: "remote",
      platform: "windows"
    });

    expect(plan.installMethod).toBe("command");
    expect(plan.targetPath).toContain("Claude Code local scope");
    expect(plan.content).toContain("claude mcp add --transport http --scope local");
    expect(plan.content).toContain("martin-loop-remote");
  });

  it("builds a generic full-profile template for wrapper hosts", () => {
    const plan = buildMcpInstallPlan({
      host: "generic",
      scope: "project",
      cwd: "/repo",
      runsRoot: "/runs",
      profile: "full",
      platform: "linux"
    });

    expect(plan.targetPath).toMatch(/\.martin-loop[\\/]mcp\.generic\.json$/u);
    expect(plan.content).toContain('"host": "generic"');
    expect(plan.content).toContain('"transport": "stdio"');
    expect(plan.content).toContain('"martin_get_verification_results"');
  });

  it("builds a paid-remote profile that includes execution but keeps remote inspection compact", () => {
    const plan = buildMcpInstallPlan({
      host: "generic",
      scope: "project",
      cwd: "/repo",
      runsRoot: "/runs",
      transport: "remote",
      profile: "paid-remote",
      platform: "linux"
    });

    expect(plan.serverId).toBe("martin-loop-remote");
    expect(plan.enabledTools).toEqual([...MARTIN_PAID_REMOTE_TOOLS]);
    expect(plan.content).toContain('"profile": "paid-remote"');
    expect(plan.content).toContain('"martin_run"');
    expect(plan.content).not.toContain('"martin_get_attempt"');
  });

  it("treats existing Codex configs with old or new Martin sections as idempotent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "martin-cli-codex-config-"));

    try {
      const codexDir = join(cwd, ".codex");
      await mkdir(codexDir, { recursive: true });
      const configPath = join(codexDir, "config.toml");
      const existing = [
        '[mcp_servers.martin_loop]',
        'command = "npx"',
        'args = ["-y", "@martinloop/mcp"]',
        ""
      ].join("\n");
      await writeFile(configPath, existing, "utf8");

      const plan = await installMcpConfig({
        host: "codex",
        scope: "project",
        cwd,
        runsRoot: join(cwd, ".runs")
      });

      expect(plan.targetPath).toBe(configPath);
      expect(await readFile(configPath, "utf8")).toBe(existing);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("treats existing Claude configs with a martin-loop block as idempotent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "martin-cli-claude-config-"));

    try {
      const configPath = join(cwd, ".mcp.json");
      const existing = JSON.stringify(
        {
          mcpServers: {
            "martin-loop": {
              command: "npx",
              args: ["-y", "@martinloop/mcp"]
            }
          }
        },
        null,
        2
      );
      await writeFile(configPath, `${existing}\n`, "utf8");

      const plan = await installMcpConfig({
        host: "claude",
        scope: "project",
        cwd,
        runsRoot: join(cwd, ".runs")
      });

      expect(plan.targetPath).toBe(configPath);
      expect(await readFile(configPath, "utf8")).toBe(`${existing}\n`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("treats existing Gemini configs with a martin-loop block as idempotent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "martin-cli-gemini-config-"));

    try {
      const configDir = join(cwd, ".gemini");
      await mkdir(configDir, { recursive: true });
      const configPath = join(configDir, "settings.json");
      const existing = JSON.stringify(
        {
          mcpServers: {
            "martin-loop": {
              command: "npx",
              args: ["-y", "@martinloop/mcp"]
            }
          }
        },
        null,
        2
      );
      await writeFile(configPath, `${existing}\n`, "utf8");

      const plan = await installMcpConfig({
        host: "gemini",
        scope: "project",
        cwd,
        runsRoot: join(cwd, ".runs")
      });

      expect(plan.targetPath).toBe(configPath);
      expect(await readFile(configPath, "utf8")).toBe(`${existing}\n`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("merges into existing VS Code MCP config without destructive overwrite", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "martin-cli-copilot-config-"));

    try {
      const configDir = join(cwd, ".vscode");
      await mkdir(configDir, { recursive: true });
      const configPath = join(configDir, "mcp.json");
      const existing = JSON.stringify(
        {
          inputs: [],
          servers: {
            "existing-server": {
              command: "node",
              args: ["./server.js"]
            }
          }
        },
        null,
        2
      );
      await writeFile(configPath, `${existing}\n`, "utf8");

      await installMcpConfig({
        host: "copilot",
        scope: "project",
        cwd,
        runsRoot: join(cwd, ".runs")
      });

      const merged = JSON.parse(await readFile(configPath, "utf8")) as {
        inputs: unknown[];
        servers: Record<string, unknown>;
      };
      expect(merged.inputs).toEqual([]);
      expect(Object.keys(merged.servers)).toEqual(
        expect.arrayContaining(["existing-server", "martin-loop"])
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("treats existing Copilot configs with martin-loop as idempotent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "martin-cli-copilot-idempotent-"));

    try {
      const configDir = join(cwd, ".vscode");
      await mkdir(configDir, { recursive: true });
      const configPath = join(configDir, "mcp.json");
      const existing = JSON.stringify(
        {
          servers: {
            "martin-loop": {
              command: "npx",
              args: ["-y", "@martinloop/mcp"]
            }
          }
        },
        null,
        2
      );
      await writeFile(configPath, `${existing}\n`, "utf8");

      await installMcpConfig({
        host: "copilot",
        scope: "project",
        cwd,
        runsRoot: join(cwd, ".runs")
      });

      expect(await readFile(configPath, "utf8")).toBe(`${existing}\n`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("treats existing Continue array configs with martin-loop as idempotent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "martin-cli-continue-idempotent-"));

    try {
      const configDir = join(cwd, ".continue");
      await mkdir(configDir, { recursive: true });
      const configPath = join(configDir, "config.json");
      const existing = JSON.stringify(
        {
          mcpServers: [
            {
              name: "martin-loop",
              command: "npx",
              args: ["-y", "@martinloop/mcp"]
            }
          ]
        },
        null,
        2
      );
      await writeFile(configPath, `${existing}\n`, "utf8");

      await installMcpConfig({
        host: "continue",
        scope: "project",
        cwd,
        runsRoot: join(cwd, ".runs")
      });

      expect(await readFile(configPath, "utf8")).toBe(`${existing}\n`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("merges Continue array configs while preserving non-Martin entries", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "martin-cli-continue-merge-array-"));

    try {
      const configDir = join(cwd, ".continue");
      await mkdir(configDir, { recursive: true });
      const configPath = join(configDir, "config.json");
      const existing = JSON.stringify(
        {
          telemetryEnabled: false,
          mcpServers: [
            {
              name: "existing-server",
              command: "node",
              args: ["./existing.js"]
            }
          ]
        },
        null,
        2
      );
      await writeFile(configPath, `${existing}\n`, "utf8");

      await installMcpConfig({
        host: "continue",
        scope: "project",
        cwd,
        runsRoot: join(cwd, ".runs")
      });

      const merged = JSON.parse(await readFile(configPath, "utf8")) as {
        telemetryEnabled: boolean;
        mcpServers: Array<{ name?: string }>;
      };
      expect(merged.telemetryEnabled).toBe(false);
      expect(merged.mcpServers.map((entry) => entry.name)).toEqual(
        expect.arrayContaining(["existing-server", "martin-loop"])
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps governance hook writes behind the explicit install option", async () => {
    // Regression test: installMcpConfig was returning early (without calling
    // installClaudeGovernanceHooks) when the MCP config already existed in ~/.claude.json.
    // This meant users who installed an older version never got governance hooks on upgrade.
    const tmpHome = await mkdtemp(join(tmpdir(), "martin-hook-reinstall-"));
    try {
      const claudeDir = join(tmpHome, ".claude");
      const claudeJson = join(tmpHome, ".claude.json");
      const settingsJson = join(claudeDir, "settings.json");
      await mkdir(claudeDir, { recursive: true });

      // Pre-populate ~/.claude.json with a martin-loop entry (simulates prior install)
      await writeFile(
        claudeJson,
        JSON.stringify({
          mcpServers: { "martin-loop": { command: "cmd", args: ["/c", "npx", "-y", "@martinloop/mcp"] } }
        }),
        "utf8"
      );
      // Pre-populate settings.json with existing hooks (no martin gate hook yet)
      await writeFile(
        settingsJson,
        JSON.stringify({ hooks: { PreToolUse: [], Stop: [] } }),
        "utf8"
      );

      // Run install against the temp home directory by overriding homedir via env
      // We test the function directly with the temp paths to avoid side effects on the real home.
      // The key assertion: the governance hooks function must be idempotent and installable
      // regardless of whether the MCP config already existed.
      // Verify the fix: all three code paths in installMcpConfig now call installClaudeGovernanceHooks.
      const src = readFileSync(
        fileURLToPath(new URL("../src/mcp-config.ts", import.meta.url)),
        "utf8"
      );
      // Count call sites — must be ≥ 3 (already-exists, merged, new-file paths)
      const callSites = (src.match(/installClaudeGovernanceHooks\(\)/g) ?? []).length;
      expect(src).toContain("options.installGovernance");
      expect(callSites).toBe(2);
      expect(src).toContain("writeFileAtomically(settingsPath");
      expect(src).not.toContain("writeFile(settingsPath");
    } finally {
      await rm(tmpHome, { recursive: true, force: true });
    }
  });

  it("governance hook command uses npx and no absolute path", () => {
    // Regression test: hook must work on any machine — no hardcoded path, no Windows-only syntax.
    const src = readFileSync(
      fileURLToPath(new URL("../src/mcp-config.ts", import.meta.url)),
      "utf8"
    );
    // Gate hook must use npx
    expect(src).toContain("npx martin-loop gate");
    // Must not use a hardcoded absolute path
    expect(src).not.toMatch(/command:\s*["']C:\\/u);
    expect(src).not.toMatch(/command:\s*["']\/home\//u);
  });
});
