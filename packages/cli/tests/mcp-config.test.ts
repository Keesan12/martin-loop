import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MARTIN_STARTER_TOOL_NAMES,
  MARTIN_TOOL_NAMES
} from "../../mcp/src/discovery-metadata.js";
import {
  buildMcpInstallPlan,
  installMcpConfig,
  MARTIN_FULL_TOOLS,
  MARTIN_STARTER_TOOLS
} from "../src/mcp-config.js";

describe("mcp config helpers", () => {
  it("keeps the CLI starter allow-list aligned with MCP discovery metadata", () => {
    expect([...MARTIN_STARTER_TOOLS]).toEqual([...MARTIN_STARTER_TOOL_NAMES]);
  });

  it("keeps the CLI full allow-list aligned with MCP discovery metadata", () => {
    expect([...MARTIN_FULL_TOOLS]).toEqual([...MARTIN_TOOL_NAMES]);
  });

  it("builds the canonical Codex starter snippet with the quoted martin-loop server id", () => {
    const plan = buildMcpInstallPlan({
      host: "codex",
      scope: "project",
      cwd: "C:\\repo",
      runsRoot: "C:\\runs"
    });

    expect(plan.content).toContain('[mcp_servers."martin-loop"]');
    expect(plan.content).toContain('enabled_tools = ["martin_doctor", "martin_preflight", "martin_run", "martin_triage_runs", "martin_run_dossier"]');
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
});
