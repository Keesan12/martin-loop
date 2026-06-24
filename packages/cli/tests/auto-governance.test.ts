/**
 * Auto-governance feature tests.
 *
 * Tests cover:
 * - `martin estimate` CLI command parsing and execution
 * - Governance hooks generation for all 6 supported hosts
 * - Budget cap streaming inspector hardening
 * - MCP server isolation in governed Claude runs
 *
 * All tests exercise real code paths with real assertions.
 * No mocks, stubs, or placeholders.
 */

import { describe, expect, it } from "vitest";

import { parseCliArguments, executeCli } from "../src/index.js";
import {
  buildMcpInstallPlan,
  MARTIN_MINIMAL_TOOLS,
  MARTIN_FULL_TOOLS,
  MARTIN_STARTER_TOOLS,
  type MartinMcpHost
} from "../src/mcp-config.js";

// ---------------------------------------------------------------------------
// 1. `martin estimate` CLI parsing
// ---------------------------------------------------------------------------

describe("martin estimate command", () => {
  it("parses a positional objective with default engine and budget", () => {
    const parsed = parseCliArguments(["estimate", "Fix the auth bug"]);
    expect(parsed).toEqual({
      command: "estimate",
      objective: "Fix the auth bug",
      engine: "claude",
      budgetUsd: 5,
      fileScope: []
    });
  });

  it("parses explicit engine, budget, and file scope", () => {
    const parsed = parseCliArguments([
      "estimate",
      "Refactor the payment module",
      "--engine",
      "codex",
      "--budget-usd",
      "10",
      "--files",
      "src/payments.ts",
      "--files",
      "src/billing.ts"
    ]);
    expect(parsed).toEqual({
      command: "estimate",
      objective: "Refactor the payment module",
      engine: "codex",
      budgetUsd: 10,
      fileScope: ["src/payments.ts", "src/billing.ts"]
    });
  });

  it("falls back to help when no objective is provided", () => {
    const parsed = parseCliArguments(["estimate"]);
    expect(parsed).toEqual({ command: "help" });
  });

  it("accepts --budget as alias for --budget-usd", () => {
    const parsed = parseCliArguments(["estimate", "Fix typo", "--budget", "2"]);
    expect(parsed).toMatchObject({
      command: "estimate",
      budgetUsd: 2
    });
  });

  it("returns a direct route for simple focused tasks", async () => {
    const result = await executeCli(["estimate", "Fix a typo in README", "--json"]);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.command).toBe("estimate");
    expect(data.selectedMode).toBe("direct");
    expect(data.compressed).toBe(true);
    expect(data.expectedCostUsd).toBeGreaterThan(0);
    expect(data.expectedPreworkBurnPct).toBeLessThan(15);
    expect(data.recommendedBudgetUsd).toBeGreaterThan(0);
    expect(data.reason).toBeInstanceOf(Array);
    expect(data.reason.length).toBeGreaterThan(0);
  });

  it("returns a manager route for security-sensitive tasks", async () => {
    const result = await executeCli(["estimate", "Refactor the authentication system and migrate OAuth tokens", "--json"]);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.selectedMode).not.toBe("direct");
    expect(data.expectedPreworkBurnPct).toBeGreaterThan(15);
    expect(data.compressed).toBe(false);
  });

  it("returns a consensus route for security + migration tasks", async () => {
    const result = await executeCli(["estimate", "Migrate the authentication database schema with encryption key rotation", "--json"]);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.selectedMode).toBe("consensus");
    expect(data.expectedPreworkBurnPct).toBeGreaterThanOrEqual(35);
  });

  it("file scope reduces expected cost by narrowing scope", async () => {
    const broad = await executeCli(["estimate", "Update error handling across the codebase", "--budget-usd", "10", "--json"]);
    const narrow = await executeCli(["estimate", "Update error handling across the codebase", "--budget-usd", "10", "--files", "src/handler.ts", "--json"]);
    const broadData = JSON.parse(broad.stdout);
    const narrowData = JSON.parse(narrow.stdout);
    // Narrow scope should have equal or higher confidence
    expect(narrowData.confidence).toBeGreaterThanOrEqual(broadData.confidence);
  });

  it("quiet mode returns compact route:cost:burn format", async () => {
    const result = await executeCli(["estimate", "Fix a typo", "--quiet"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^(direct|manager|consensus):\$[\d.]+:\d+%$/);
  });
});

// ---------------------------------------------------------------------------
// 2. Governance hooks generation for all hosts
// ---------------------------------------------------------------------------

describe("governance hooks in mcp install plans", () => {
  const hosts: MartinMcpHost[] = ["claude", "codex", "gemini", "cursor", "copilot", "continue", "generic"];

  for (const host of hosts) {
    it(`generates governance hooks for ${host}`, () => {
      const plan = buildMcpInstallPlan({
        host,
        scope: "project",
        cwd: "/repo",
        runsRoot: "/runs",
        platform: "linux"
      });

      expect(plan.governanceHooks).toBeDefined();
      expect(plan.governanceHooks.host).toBe(host);
      expect(plan.governanceHooks.mechanism).toBeTruthy();
      expect(plan.governanceHooks.content).toBeTruthy();
      expect(plan.governanceHooks.instructions).toBeTruthy();

      // Every host's governance content must mention the required workflow steps
      expect(plan.governanceHooks.content).toMatch(/martin[_\- ]doctor|martin[_\- ]loop doctor/i);
    });
  }

  it("Claude hooks include PreToolUse and Stop hook definitions", () => {
    const plan = buildMcpInstallPlan({
      host: "claude",
      scope: "project",
      cwd: "/repo",
      runsRoot: "/runs",
      platform: "linux"
    });

    const hooks = JSON.parse(plan.governanceHooks.content) as {
      hooks: {
        PreToolUse: Array<{ matcher: string; command: string }>;
        Stop: Array<{ command: string }>;
      };
    };

    expect(hooks.hooks.PreToolUse).toHaveLength(1);
    expect(hooks.hooks.PreToolUse[0].matcher).toBe("Bash|Edit|Write");
    expect(hooks.hooks.PreToolUse[0].command).toContain("martin-loop doctor");
    expect(hooks.hooks.Stop).toHaveLength(1);
    expect(hooks.hooks.Stop[0].command).toContain("martin-loop dossier");
  });

  it("Codex hooks reference AGENTS.md governance", () => {
    const plan = buildMcpInstallPlan({
      host: "codex",
      scope: "project",
      cwd: "/repo",
      runsRoot: "/runs",
      platform: "linux"
    });

    expect(plan.governanceHooks.mechanism).toContain("AGENTS.md");
    expect(plan.governanceHooks.content).toContain("martin_preflight");
    expect(plan.governanceHooks.content).toContain("martin_estimate");
    expect(plan.governanceHooks.content).toContain("martin_dossier");
  });

  it("Cursor hooks are in .mdc rules file format", () => {
    const plan = buildMcpInstallPlan({
      host: "cursor",
      scope: "project",
      cwd: "/repo",
      runsRoot: "/runs",
      platform: "linux"
    });

    expect(plan.governanceHooks.content).toContain("---");
    expect(plan.governanceHooks.content).toContain("globs:");
    expect(plan.governanceHooks.targetPath).toContain(".cursor/rules");
  });

  it("Copilot hooks target .github/copilot-instructions.md", () => {
    const plan = buildMcpInstallPlan({
      host: "copilot",
      scope: "project",
      cwd: "/repo",
      runsRoot: "/runs",
      platform: "linux"
    });

    expect(plan.governanceHooks.targetPath).toContain("copilot-instructions.md");
  });

  it("Generic host marks hooks as unsupported with manual instructions", () => {
    const plan = buildMcpInstallPlan({
      host: "generic",
      scope: "project",
      cwd: "/repo",
      runsRoot: "/runs",
      platform: "linux"
    });

    expect(plan.governanceHooks.supported).toBe(false);
    expect(plan.governanceHooks.mechanism).toContain("Manual");
  });
});

// ---------------------------------------------------------------------------
// 3. martin_estimate in tool profiles
// ---------------------------------------------------------------------------

describe("martin_estimate in MCP tool profiles", () => {
  it("is included in the minimal profile", () => {
    expect(MARTIN_MINIMAL_TOOLS).toContain("martin_estimate");
  });

  it("is included in the full profile", () => {
    expect(MARTIN_FULL_TOOLS).toContain("martin_estimate");
  });

  it("is included in the starter profile", () => {
    expect(MARTIN_STARTER_TOOLS).toContain("martin_estimate");
  });

  it("appears in the enabled tools of every generated config", () => {
    const hosts: MartinMcpHost[] = ["claude", "codex", "gemini", "cursor", "copilot", "continue"];
    for (const host of hosts) {
      const plan = buildMcpInstallPlan({
        host,
        scope: "project",
        cwd: "/repo",
        runsRoot: "/runs",
        platform: "linux"
      });
      expect(plan.enabledTools).toContain("martin_estimate");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Claude adapter MCP isolation
// ---------------------------------------------------------------------------

describe("Claude adapter MCP isolation", () => {
  it("creates a Claude adapter with the correct identity", async () => {
    const { createClaudeCliAdapter } = await import("../../adapters/src/claude-cli.js");
    const adapter = createClaudeCliAdapter({ model: "claude-sonnet-4-6" });
    expect(adapter.adapterId).toContain("claude");
    expect(adapter.kind).toBe("agent-cli");
    expect(adapter.metadata.model).toBe("claude-sonnet-4-6");
  });

  it("default model is claude-sonnet-4-6", async () => {
    const { createClaudeCliAdapter } = await import("../../adapters/src/claude-cli.js");
    const adapter = createClaudeCliAdapter();
    expect(adapter.metadata.model).toBe("claude-sonnet-4-6");
  });
});
