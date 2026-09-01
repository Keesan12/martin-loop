import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  MARTIN_MINIMAL_TOOLS,
  MARTIN_PAID_REMOTE_TOOLS,
  MARTIN_STARTER_TOOLS
} from "../src/mcp-config.js";

describe("mcp config helpers", () => {
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
    expect(plan.content).toContain("claude.cmd mcp add --transport http --scope local");
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

  it("installs project-scope Codex governance into AGENTS.md when explicitly requested", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "martin-cli-codex-governance-"));

    try {
      const agentsPath = join(cwd, "AGENTS.md");
      await writeFile(
        agentsPath,
        [
          "# Project Instructions",
          "",
          "Preserve this unrelated guidance.",
          ""
        ].join("\n"),
        "utf8"
      );

      await installMcpConfig(
        {
          host: "codex",
          scope: "project",
          cwd,
          runsRoot: join(cwd, ".runs")
        },
        { installGovernance: true, stateRoot: join(cwd, ".state") }
      );

      const installed = await readFile(agentsPath, "utf8");
      expect(installed).toContain("Preserve this unrelated guidance.");
      expect(installed).toContain("BEGIN MARTINLOOP GOVERNANCE");
      expect(installed).toContain("MartinLoop is available");
      expect(installed).toContain("martin_doctor");
      expect(installed).toContain("martin_run");
      expect(installed).toContain("END MARTINLOOP GOVERNANCE");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps Codex governance installation idempotent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "martin-cli-codex-governance-idempotent-"));

    try {
      await installMcpConfig(
        {
          host: "codex",
          scope: "project",
          cwd,
          runsRoot: join(cwd, ".runs")
        },
        { installGovernance: true, stateRoot: join(cwd, ".state") }
      );
      await installMcpConfig(
        {
          host: "codex",
          scope: "project",
          cwd,
          runsRoot: join(cwd, ".runs")
        },
        { installGovernance: true, stateRoot: join(cwd, ".state") }
      );

      const installed = await readFile(join(cwd, "AGENTS.md"), "utf8");
      expect(installed.match(/BEGIN MARTINLOOP GOVERNANCE/gu)).toHaveLength(1);
      expect(installed.match(/END MARTINLOOP GOVERNANCE/gu)).toHaveLength(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("replaces an existing Martin-managed Codex governance section without duplicating user instructions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "martin-cli-codex-governance-replace-"));

    try {
      const agentsPath = join(cwd, "AGENTS.md");
      await writeFile(
        agentsPath,
        [
          "# Existing Instructions",
          "",
          "<!-- BEGIN MARTINLOOP GOVERNANCE -->",
          "old Martin section",
          "<!-- END MARTINLOOP GOVERNANCE -->",
          "",
          "Keep this project-specific rule.",
          ""
        ].join("\n"),
        "utf8"
      );

      await installMcpConfig(
        {
          host: "codex",
          scope: "project",
          cwd,
          runsRoot: join(cwd, ".runs")
        },
        { installGovernance: true, stateRoot: join(cwd, ".state") }
      );

      const installed = await readFile(agentsPath, "utf8");
      expect(installed).not.toContain("old Martin section");
      expect(installed).toContain("Keep this project-specific rule.");
      expect(installed.match(/BEGIN MARTINLOOP GOVERNANCE/gu)).toHaveLength(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("preserves non-Martin Codex instruction bytes exactly when replacing a managed section", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "martin-cli-codex-governance-preserve-"));

    try {
      const agentsPath = join(cwd, "AGENTS.md");
      const prefix = [
        "# Existing Instructions",
        "",
        "",
        "Keep   unusual   spacing.",
        "  - preserve leading indentation",
        ""
      ].join("\n");
      const suffix = [
        "",
        "",
        "Trailing project rule:",
        "",
        "",
        "  leave these blank lines alone",
        ""
      ].join("\n");
      await writeFile(
        agentsPath,
        `${prefix}<!-- BEGIN MARTINLOOP GOVERNANCE -->\nold Martin section\n<!-- END MARTINLOOP GOVERNANCE -->${suffix}`,
        "utf8"
      );

      await installMcpConfig(
        {
          host: "codex",
          scope: "project",
          cwd,
          runsRoot: join(cwd, ".runs")
        },
        { installGovernance: true, stateRoot: join(cwd, ".state") }
      );

      const installed = await readFile(agentsPath, "utf8");
      const beginIndex = installed.indexOf("<!-- BEGIN MARTINLOOP GOVERNANCE -->");
      const endIndex = installed.indexOf("<!-- END MARTINLOOP GOVERNANCE -->");
      expect(beginIndex).toBe(prefix.length);
      expect(installed.slice(0, beginIndex)).toBe(prefix);
      expect(installed.slice(endIndex + "<!-- END MARTINLOOP GOVERNANCE -->".length)).toBe(suffix);
      expect(installed).not.toContain("old Martin section");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("preserves an existing CRLF AGENTS.md convention around the managed Codex section", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "martin-cli-codex-governance-crlf-"));

    try {
      const agentsPath = join(cwd, "AGENTS.md");
      const prefix = "# Existing Instructions\r\n\r\nKeep CRLF.\r\n";
      const suffix = "\r\n\r\nAfter section stays CRLF.\r\n";
      await writeFile(
        agentsPath,
        `${prefix}<!-- BEGIN MARTINLOOP GOVERNANCE -->\r\nold Martin section\r\n<!-- END MARTINLOOP GOVERNANCE -->${suffix}`,
        "utf8"
      );

      await installMcpConfig(
        {
          host: "codex",
          scope: "project",
          cwd,
          runsRoot: join(cwd, ".runs")
        },
        { installGovernance: true, stateRoot: join(cwd, ".state") }
      );

      const installed = await readFile(agentsPath, "utf8");
      expect(installed.slice(0, prefix.length)).toBe(prefix);
      expect(installed.endsWith(suffix)).toBe(true);
      expect(installed).toContain("<!-- BEGIN MARTINLOOP GOVERNANCE -->\r\n## MartinLoop Governance\r\n");
      expect(installed).not.toMatch(/(?<!\r)\n/u);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("refuses to install Codex governance over a malformed managed section", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "martin-cli-codex-governance-malformed-"));

    try {
      const agentsPath = join(cwd, "AGENTS.md");
      await writeFile(
        agentsPath,
        [
          "# Existing Instructions",
          "",
          "<!-- BEGIN MARTINLOOP GOVERNANCE -->",
          "partial Martin section without an end sentinel",
          ""
        ].join("\n"),
        "utf8"
      );

      await expect(
        installMcpConfig(
          {
            host: "codex",
            scope: "project",
            cwd,
            runsRoot: join(cwd, ".runs")
          },
          { installGovernance: true, stateRoot: join(cwd, ".state") }
        )
      ).rejects.toThrow(/managed section is malformed/u);

      expect(await readFile(agentsPath, "utf8")).toContain("partial Martin section");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("refuses to install Codex governance when duplicate managed sections are present", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "martin-cli-codex-governance-duplicate-"));

    try {
      const agentsPath = join(cwd, "AGENTS.md");
      const existing = [
        "# Existing Instructions",
        "",
        "<!-- BEGIN MARTINLOOP GOVERNANCE -->",
        "first Martin section",
        "<!-- END MARTINLOOP GOVERNANCE -->",
        "",
        "<!-- BEGIN MARTINLOOP GOVERNANCE -->",
        "second Martin section",
        "<!-- END MARTINLOOP GOVERNANCE -->",
        ""
      ].join("\n");
      await writeFile(agentsPath, existing, "utf8");

      await expect(
        installMcpConfig(
          {
            host: "codex",
            scope: "project",
            cwd,
            runsRoot: join(cwd, ".runs")
          },
          { installGovernance: true, stateRoot: join(cwd, ".state") }
        )
      ).rejects.toThrow(/managed section is malformed/u);

      expect(await readFile(agentsPath, "utf8")).toBe(existing);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("installs user-scope Codex governance into CODEX_HOME AGENTS.md when explicitly requested", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "martin-cli-codex-user-governance-"));
    const codexHome = join(cwd, ".codex-home");
    const previousCodexHome = process.env.CODEX_HOME;

    try {
      process.env.CODEX_HOME = codexHome;

      await installMcpConfig(
        {
          host: "codex",
          scope: "user",
          cwd,
          runsRoot: join(cwd, ".runs")
        },
        { installGovernance: true, stateRoot: join(cwd, ".state") }
      );

      const installed = await readFile(join(codexHome, "AGENTS.md"), "utf8");
      expect(installed).toContain("BEGIN MARTINLOOP GOVERNANCE");
      expect(installed).toContain("Use MartinLoop proactively for non-trivial software implementation");
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
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

  it("merges into an existing native VS Code MCP config without destructive overwrite", async () => {
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

      await installMcpConfig(
        {
          host: "vscode",
          scope: "project",
          cwd,
          runsRoot: join(cwd, ".runs")
        },
        { stateRoot: join(cwd, ".state") }
      );

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

  it("treats existing native VS Code configs with martin-loop as idempotent", async () => {
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
        host: "vscode",
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

      await installMcpConfig(
        {
          host: "continue",
          scope: "project",
          cwd,
          runsRoot: join(cwd, ".runs")
        },
        { stateRoot: join(cwd, ".state") }
      );

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

      await installMcpConfig(
        {
          host: "continue",
          scope: "project",
          cwd,
          runsRoot: join(cwd, ".runs")
        },
        { stateRoot: join(cwd, ".state") }
      );

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

  it("keeps governance hook installation explicit", async () => {
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

      const src = readFileSync(
        fileURLToPath(new URL("../src/mcp-config.ts", import.meta.url)),
        "utf8"
      );
      expect(src).toContain("options.installGovernance");
      expect(src).toContain("await maybeInstallGovernance(plan, options)");
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
