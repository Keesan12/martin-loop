import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { CliCommandError } from "./ux.js";

export const MARTIN_STARTER_TOOLS = [
  "martin_doctor",
  "martin_plan",
  "martin_preflight",
  "martin_estimate",
  "martin_run",
  "martin_triage_runs",
  "martin_dossier"
] as const;

export const MARTIN_MINIMAL_TOOLS = [
  "martin_doctor",
  "martin_plan",
  "martin_preflight",
  "martin_estimate",
  "martin_list_runs",
  "martin_triage_runs",
  "martin_dossier"
] as const;

export const MARTIN_DIAGNOSTIC_TOOLS = [
  "martin_doctor",
  "martin_plan",
  "martin_preflight",
  "martin_estimate",
  "martin_logs",
  "martin_list_runs",
  "martin_triage_runs",
  "martin_get_run",
  "martin_get_attempt",
  "martin_get_verification_results",
  "martin_dossier",
  "martin_eval"
] as const;

export const MARTIN_GITHUB_REVIEW_TOOLS = [
  "martin_doctor",
  "martin_plan",
  "martin_preflight",
  "martin_dossier",
  "martin_eval",
  "martin_pr_summary",
  "martin_create_pr",
  "martin_review_pr"
] as const;

export const MARTIN_FULL_TOOLS = [
  "martin_run",
  "martin_inspect",
  "martin_status",
  "martin_doctor",
  "martin_plan",
  "martin_preflight",
  "martin_estimate",
  "martin_logs",
  "martin_pause",
  "martin_cancel",
  "martin_continue",
  "martin_list_runs",
  "martin_triage_runs",
  "martin_get_run",
  "martin_get_attempt",
  "martin_get_verification_results",
  "martin_run_dossier",
  "martin_dossier",
  "martin_eval",
  "martin_pr_summary",
  "martin_create_pr",
  "martin_review_pr"
] as const;

export const MARTIN_PAID_REMOTE_TOOLS = [
  "martin_doctor",
  "martin_plan",
  "martin_preflight",
  "martin_estimate",
  "martin_run",
  "martin_list_runs",
  "martin_triage_runs",
  "martin_get_run",
  "martin_get_verification_results",
  "martin_dossier",
  "martin_eval"
] as const;

export type MartinMcpHost = "codex" | "claude" | "gemini" | "generic" | "cursor" | "copilot" | "continue";
export type MartinMcpScope = "user" | "project" | "local";
export type MartinMcpTransport = "stdio" | "remote";
export type MartinMcpProfile = "minimal" | "diagnostic" | "github-review" | "full-local" | "paid-remote" | "starter" | "full";
export type MartinMcpPlatform = "windows" | "macos" | "linux";

export interface MartinMcpConfigInput {
  host: MartinMcpHost;
  scope: MartinMcpScope;
  cwd: string;
  runsRoot: string;
  transport?: MartinMcpTransport;
  profile?: MartinMcpProfile;
  remoteUrl?: string;
  remoteTokenEnv?: string;
  experimentalRemoteHosts?: boolean;
  platform?: MartinMcpPlatform;
}

export interface MartinMcpInstallPlan extends Required<Omit<MartinMcpConfigInput, "remoteUrl">> {
  remoteUrl?: string;
  targetPath: string;
  content: string;
  serverId: string;
  enabledTools: string[];
  installMethod: "file" | "command";
  governanceHooks: GovernanceHooksOutput;
}

export interface GovernanceHooksOutput {
  host: MartinMcpHost;
  supported: boolean;
  mechanism: string;
  targetPath: string | null;
  content: string;
  instructions: string;
}

const DEFAULT_REMOTE_URL = "https://remote.martinloop.local/mcp";
const DEFAULT_REMOTE_TOKEN_ENV = "MARTIN_REMOTE_TOKEN";
const REMOTE_EXPERIMENTAL_HOSTS = new Set<MartinMcpHost>(["cursor", "copilot", "continue"]);

export function buildMcpInstallPlan(input: MartinMcpConfigInput): MartinMcpInstallPlan {
  const normalized = normalizeInput(input);
  const targetPath = resolveTargetPath(normalized);
  const content = buildHostConfig(normalized);
  const serverId =
    normalized.transport === "remote" ? "martin-loop-remote" : "martin-loop";

  return {
    ...normalized,
    targetPath,
    content,
    serverId,
    enabledTools: [...selectTools(normalized.profile)],
    installMethod: normalized.host === "claude" && normalized.scope === "local" ? "command" : "file",
    governanceHooks: buildGovernanceHooks(normalized.host, normalized.scope)
  };
}

export async function installMcpConfig(
  input: MartinMcpConfigInput
): Promise<MartinMcpInstallPlan> {
  const plan = buildMcpInstallPlan(input);
  if (plan.installMethod === "command") {
    await installClaudeLocalScope(plan);
    return plan;
  }

  const targetExists = await access(plan.targetPath).then(() => true).catch(() => false);

  if (targetExists) {
    const existing = await readFile(plan.targetPath, "utf8");
    if (existingConfigAlreadyContainsMartin(plan.host, plan.serverId, existing)) {
      return plan;
    }

    const merged = mergeHostConfig(plan.host, plan.serverId, existing, plan.content);
    if (merged) {
      await writeFile(plan.targetPath, merged, "utf8");
      return plan;
    }

    throw new CliCommandError(
      "environment",
      `Refusing to overwrite existing MCP config: ${plan.targetPath}`,
      {
        suggestion:
          "Use `martin-loop mcp print-config` and merge the Martin Loop block into the existing host config."
      }
    );
  }

  await mkdir(path.dirname(plan.targetPath), { recursive: true });
  await writeFile(plan.targetPath, plan.content, "utf8");
  return plan;
}

function normalizeInput(input: MartinMcpConfigInput): Required<Omit<MartinMcpConfigInput, "remoteUrl">> & {
  remoteUrl?: string;
} {
  return {
    host: input.host,
    scope: input.scope,
    cwd: input.cwd,
    runsRoot: input.runsRoot,
    transport: input.transport ?? "stdio",
    profile: input.profile ?? "minimal",
    remoteUrl: input.remoteUrl ?? DEFAULT_REMOTE_URL,
    remoteTokenEnv: input.remoteTokenEnv ?? DEFAULT_REMOTE_TOKEN_ENV,
    experimentalRemoteHosts: input.experimentalRemoteHosts ?? false,
    platform: input.platform ?? detectPlatform()
  };
}

function buildHostConfig(
  input: Required<Omit<MartinMcpConfigInput, "remoteUrl">> & { remoteUrl?: string }
): string {
  switch (input.host) {
    case "codex":
      return buildCodexConfigSnippet(input);
    case "claude":
      return buildClaudeConfigSnippet(input);
    case "gemini":
      return buildGeminiConfigSnippet(input);
    case "cursor":
      return buildCursorConfigSnippet(input);
    case "copilot":
      return buildCopilotConfigSnippet(input);
    case "continue":
      return buildContinueConfigSnippet(input);
    case "generic":
      return buildGenericConfigSnippet(input);
  }
}

function buildCodexConfigSnippet(
  input: Required<Omit<MartinMcpConfigInput, "remoteUrl">> & { remoteUrl?: string }
): string {
  const tools = selectTools(input.profile).map((tool) => `"${tool}"`).join(", ");
  const serverId = input.transport === "remote" ? "martin-loop-remote" : "martin-loop";

  if (input.transport === "remote") {
    return [
      "# Martin Loop MCP",
      `# Codex ${input.profile} profile over remote Streamable HTTP.`,
      `[mcp_servers."${serverId}"]`,
      `url = "${escapeTomlString(input.remoteUrl ?? DEFAULT_REMOTE_URL)}"`,
      `bearer_token_env_var = "${escapeTomlString(input.remoteTokenEnv)}"`,
      "required = true",
      "startup_timeout_sec = 20",
      "tool_timeout_sec = 180",
      `enabled_tools = [${tools}]`,
      ""
    ].join("\n");
  }

  const launcher = buildStdioLauncher(input.platform);
  return [
    "# Martin Loop MCP",
    `# Codex ${input.profile} profile over local stdio.`,
    `[mcp_servers."${serverId}"]`,
    `command = "${escapeTomlString(launcher.command)}"`,
    `args = [${launcher.args.map((value) => `"${escapeTomlString(value)}"`).join(", ")}]`,
    `cwd = "${escapeTomlString(input.cwd)}"`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 180",
    `enabled_tools = [${tools}]`,
    `env = { MARTIN_RUNS_DIR = "${escapeTomlString(input.runsRoot)}" }`,
    ""
  ].join("\n");
}

function buildClaudeConfigSnippet(
  input: Required<Omit<MartinMcpConfigInput, "remoteUrl">> & { remoteUrl?: string }
): string {
  const serverId = input.transport === "remote" ? "martin-loop-remote" : "martin-loop";

  if (input.scope === "local") {
    return renderClaudeLocalInstallCommand(input);
  }

  if (input.transport === "remote") {
    return (
      JSON.stringify(
        {
          mcpServers: {
            [serverId]: {
              type: "http",
              url: input.remoteUrl ?? DEFAULT_REMOTE_URL,
              headers: {
                Authorization: `Bearer \${${input.remoteTokenEnv}}`
              }
            }
          }
        },
        null,
        2
      ) + "\n"
    );
  }

  const launcher = buildStdioLauncher(input.platform);
  return (
    JSON.stringify(
      {
        mcpServers: {
          [serverId]: {
            command: launcher.command,
            args: launcher.args,
            cwd: input.cwd,
            env: {
              MARTIN_RUNS_DIR: input.runsRoot
            }
          }
        }
      },
      null,
      2
    ) + "\n"
  );
}

function buildGeminiConfigSnippet(
  input: Required<Omit<MartinMcpConfigInput, "remoteUrl">> & { remoteUrl?: string }
): string {
  const serverId = input.transport === "remote" ? "martin-loop-remote" : "martin-loop";
  const tools = selectTools(input.profile);

  if (input.transport === "remote") {
    return (
      JSON.stringify(
        {
          mcp: {
            allowed: [serverId]
          },
          mcpServers: {
            [serverId]: {
              httpUrl: input.remoteUrl ?? DEFAULT_REMOTE_URL,
              headers: {
                Authorization: `Bearer $${input.remoteTokenEnv}`
              },
              trust: true,
              includeTools: tools
            }
          }
        },
        null,
        2
      ) + "\n"
    );
  }

  const launcher = buildStdioLauncher(input.platform);
  return (
    JSON.stringify(
      {
        mcp: {
          allowed: [serverId]
        },
        mcpServers: {
          [serverId]: {
            command: launcher.command,
            args: launcher.args,
            cwd: input.cwd,
            env: {
              MARTIN_RUNS_DIR: input.runsRoot
            },
            includeTools: tools
          }
        }
      },
      null,
      2
    ) + "\n"
  );
}

function buildGenericConfigSnippet(
  input: Required<Omit<MartinMcpConfigInput, "remoteUrl">> & { remoteUrl?: string }
): string {
  const serverId = input.transport === "remote" ? "martin-loop-remote" : "martin-loop";
  const launcher = buildStdioLauncher(input.platform);
  const tools = selectTools(input.profile);

  return (
    JSON.stringify(
      {
        version: 1,
        generatedBy: "martin-loop mcp print-config",
        host: "generic",
        transport: input.transport,
        profile: input.profile,
        platform: input.platform,
        serverId,
        mcpServers: {
          [serverId]:
            input.transport === "remote"
              ? {
                  url: input.remoteUrl ?? DEFAULT_REMOTE_URL,
                  auth: {
                    bearerTokenEnvVar: input.remoteTokenEnv
                  },
                  includeTools: tools
                }
              : {
                  command: launcher.command,
                  args: launcher.args,
                  cwd: input.cwd,
                  env: {
                    MARTIN_RUNS_DIR: input.runsRoot
                  },
                  includeTools: tools
                }
        }
      },
      null,
      2
    ) + "\n"
  );
}

function resolveTargetPath(
  input: Required<Omit<MartinMcpConfigInput, "remoteUrl">> & { remoteUrl?: string }
): string {
  if (input.host === "codex") {
    return input.scope === "user"
      ? joinTargetPath(resolveCodexHome(), "config.toml")
      : joinTargetPath(input.cwd, ".codex", "config.toml");
  }

  if (input.host === "claude") {
    if (input.scope === "local") {
      return "Claude Code local scope (managed by `claude mcp add --scope local`)";
    }

    return input.scope === "user"
      ? path.join(homedir(), ".claude.json")
      : joinTargetPath(input.cwd, ".mcp.json");
  }

  if (input.host === "gemini") {
    return input.scope === "user"
      ? path.join(homedir(), ".gemini", "settings.json")
      : joinTargetPath(input.cwd, ".gemini", "settings.json");
  }

  if (input.host === "cursor") {
    return input.scope === "user"
      ? path.join(homedir(), ".cursor", "mcp.json")
      : joinTargetPath(input.cwd, ".cursor", "mcp.json");
  }

  if (input.host === "copilot") {
    // GitHub Copilot agent mode reads MCP config from VS Code settings.json
    return input.scope === "user"
      ? path.join(homedir(), ".vscode", "settings.json")
      : joinTargetPath(input.cwd, ".vscode", "settings.json");
  }

  if (input.host === "continue") {
    return input.scope === "user"
      ? path.join(homedir(), ".continue", "config.json")
      : joinTargetPath(input.cwd, ".continue", "config.json");
  }

  return input.scope === "user"
    ? path.join(homedir(), ".martin-loop", "mcp.generic.json")
    : joinTargetPath(input.cwd, ".martin-loop", "mcp.generic.json");
}

function detectPlatform(): MartinMcpPlatform {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    default:
      return "linux";
  }
}

function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const codexHome = env["CODEX_HOME"]?.trim();
  return codexHome && codexHome.length > 0 ? codexHome : path.join(homedir(), ".codex");
}

function joinTargetPath(basePath: string, ...segments: string[]): string {
  return usesWindowsSeparators(basePath)
    ? path.win32.join(basePath, ...segments)
    : path.join(basePath, ...segments);
}

// ---------------------------------------------------------------------------
// Cursor IDE config builder
// Writes to .cursor/mcp.json (project) or ~/.cursor/mcp.json (user)
// https://cursor.com/docs — Settings > Tools & MCP
// ---------------------------------------------------------------------------

function buildCursorConfigSnippet(
  input: Required<Omit<MartinMcpConfigInput, "remoteUrl">> & { remoteUrl?: string }
): string {
  const launcher = buildStdioLauncher(input.platform);
  const serverId = input.transport === "remote" ? "martin-loop-remote" : "martin-loop";
  return (
    JSON.stringify(
      {
        mcpServers: {
          [serverId]: {
            ...(input.transport === "remote"
              ? {
                  url: input.remoteUrl ?? DEFAULT_REMOTE_URL,
                  headers: {
                    Authorization: `Bearer $${input.remoteTokenEnv}`
                  }
                }
              : {
                  command: launcher.command,
                  args: launcher.args,
                  env: {
                    MARTIN_RUNS_DIR: input.runsRoot
                  }
                })
          }
        }
      },
      null,
      2
    ) + "\n"
  );
}

// ---------------------------------------------------------------------------
// GitHub Copilot config builder
// Writes to .vscode/settings.json under "github.copilot.chat.mcpServers"
// Compatible with VS Code Copilot agent mode (GA May 2025)
// ---------------------------------------------------------------------------

function buildCopilotConfigSnippet(
  input: Required<Omit<MartinMcpConfigInput, "remoteUrl">> & { remoteUrl?: string }
): string {
  const launcher = buildStdioLauncher(input.platform);
  const serverId = input.transport === "remote" ? "martin-loop-remote" : "martin-loop";
  return (
    JSON.stringify(
      {
        "github.copilot.chat.mcpServers": {
          [serverId]: {
            ...(input.transport === "remote"
              ? {
                  type: "http",
                  url: input.remoteUrl ?? DEFAULT_REMOTE_URL,
                  headers: {
                    Authorization: `Bearer $${input.remoteTokenEnv}`
                  }
                }
              : {
                  command: launcher.command,
                  args: launcher.args,
                  env: {
                    MARTIN_RUNS_DIR: input.runsRoot
                  }
                })
          }
        }
      },
      null,
      2
    ) + "\n"
  );
}

// ---------------------------------------------------------------------------
// Continue.dev config builder
// Appends MCP context provider to .continue/config.json
// https://docs.continue.dev/customize/model-providers/overview
// ---------------------------------------------------------------------------

function buildContinueConfigSnippet(
  input: Required<Omit<MartinMcpConfigInput, "remoteUrl">> & { remoteUrl?: string }
): string {
  const launcher = buildStdioLauncher(input.platform);
  const tools = selectTools(input.profile);
  const serverId = input.transport === "remote" ? "martin-loop-remote" : "martin-loop";
  return (
    JSON.stringify(
      {
        mcpServers: [
          {
            name: serverId,
            ...(input.transport === "remote"
              ? {
                  type: "http",
                  url: input.remoteUrl ?? DEFAULT_REMOTE_URL,
                  headers: {
                    Authorization: `Bearer $${input.remoteTokenEnv}`
                  }
                }
              : {
                  command: launcher.command,
                  args: launcher.args,
                  env: {
                    MARTIN_RUNS_DIR: input.runsRoot
                  }
                }),
            includeTools: tools
          }
        ]
      },
      null,
      2
    ) + "\n"
  );
}

function usesWindowsSeparators(pathValue: string): boolean {
  return /^[A-Za-z]:([\\/]|$)/u.test(pathValue) || pathValue.includes("\\");
}

function buildStdioLauncher(platform: MartinMcpPlatform): {
  command: string;
  args: string[];
} {
  if (platform === "windows") {
    return {
      command: "cmd",
      args: ["/c", "npx", "-y", "@martinloop/mcp"]
    };
  }

  return {
    command: "npx",
    args: ["-y", "@martinloop/mcp"]
  };
}

function selectTools(profile: MartinMcpProfile): readonly string[] {
  switch (profile) {
    case "minimal":
      return MARTIN_MINIMAL_TOOLS;
    case "diagnostic":
      return MARTIN_DIAGNOSTIC_TOOLS;
    case "github-review":
      return MARTIN_GITHUB_REVIEW_TOOLS;
    case "full-local":
    case "full":
      return MARTIN_FULL_TOOLS;
    case "paid-remote":
      return MARTIN_PAID_REMOTE_TOOLS;
    case "starter":
      return MARTIN_STARTER_TOOLS;
  }
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

function existingConfigAlreadyContainsMartin(
  host: MartinMcpHost,
  serverId: string,
  existing: string
): boolean {
  if (host === "codex") {
    const quotedServerId = serverId.replace(/[\/\\^$*+?.()|[\]{}]/gu, "\\$&");
    const legacyServerId = serverId.replace(/-/gu, "_");
    return (
      new RegExp(String.raw`(^|\r?\n)\[mcp_servers\."${quotedServerId}"\]\s*$`, "mu").test(existing) ||
      new RegExp(String.raw`(^|\r?\n)\[mcp_servers\.${legacyServerId}\]\s*$`, "mu").test(existing)
    );
  }

  try {
    const parsed = JSON.parse(existing) as Record<string, unknown>;
    return hasMartinServerInParsedConfig(host, serverId, parsed);
  } catch {
    return false;
  }
}

function hasMartinServerInParsedConfig(
  host: MartinMcpHost,
  serverId: string,
  parsed: Record<string, unknown>
): boolean {
  if (host === "copilot") {
    const servers = parsed["github.copilot.chat.mcpServers"];
    return isRecord(servers) && serverId in servers;
  }

  if (host === "continue") {
    const servers = parsed.mcpServers;
    if (Array.isArray(servers)) {
      return servers.some((entry) => isRecord(entry) && entry.name === serverId);
    }
    return isRecord(servers) && serverId in servers;
  }

  const servers = parsed.mcpServers;
  return isRecord(servers) && serverId in servers;
}

function mergeHostConfig(
  host: MartinMcpHost,
  serverId: string,
  existing: string,
  generated: string
): string | undefined {
  if (host === "codex" || host === "claude" && generated.startsWith("claude mcp add")) {
    return undefined;
  }

  try {
    const existingParsed = JSON.parse(existing) as Record<string, unknown>;
    const generatedParsed = JSON.parse(generated) as Record<string, unknown>;
    const merged = mergeHostParsedConfig(host, serverId, existingParsed, generatedParsed);
    if (!merged) {
      return undefined;
    }
    return `${JSON.stringify(merged, null, 2)}\n`;
  } catch {
    return undefined;
  }
}

function mergeHostParsedConfig(
  host: MartinMcpHost,
  serverId: string,
  existing: Record<string, unknown>,
  generated: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (host === "copilot") {
    const existingServers = isRecord(existing["github.copilot.chat.mcpServers"])
      ? { ...existing["github.copilot.chat.mcpServers"] }
      : {};
    const generatedServers = isRecord(generated["github.copilot.chat.mcpServers"])
      ? generated["github.copilot.chat.mcpServers"]
      : undefined;
    if (!generatedServers) {
      return undefined;
    }
    return {
      ...existing,
      "github.copilot.chat.mcpServers": {
        ...existingServers,
        ...generatedServers
      }
    };
  }

  if (host === "continue") {
    const generatedServers = generated.mcpServers;
    if (!Array.isArray(generatedServers)) {
      return undefined;
    }
    const generatedServer = generatedServers.find((entry) => isRecord(entry) && entry.name === serverId);
    if (!generatedServer) {
      return undefined;
    }

    const existingServers = existing.mcpServers;
    if (Array.isArray(existingServers)) {
      const withoutMartin = existingServers.filter(
        (entry) => !(isRecord(entry) && entry.name === serverId)
      );
      return {
        ...existing,
        mcpServers: [...withoutMartin, generatedServer]
      };
    }

    if (isRecord(existingServers)) {
      return {
        ...existing,
        mcpServers: {
          ...existingServers,
          [serverId]: generatedServer
        }
      };
    }

    return {
      ...existing,
      mcpServers: [generatedServer]
    };
  }

  const generatedServers = generated.mcpServers;
  if (!isRecord(generatedServers)) {
    return undefined;
  }

  const existingServers = isRecord(existing.mcpServers) ? existing.mcpServers : {};
  return {
    ...existing,
    mcpServers: {
      ...existingServers,
      ...generatedServers
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildGovernanceHooks(host: MartinMcpHost, scope: MartinMcpScope): GovernanceHooksOutput {
  switch (host) {
    case "claude":
      return {
        host,
        supported: true,
        mechanism: "Claude Code hooks in ~/.claude/settings.json",
        targetPath: path.join(homedir(), ".claude", "settings.json"),
        content: JSON.stringify({
          hooks: {
            PreToolUse: [{
              matcher: "Bash|Edit|Write",
              command: "npx martin-loop doctor --json --quiet",
              description: "MartinLoop governance check before work"
            }],
            Stop: [{
              command: "npx martin-loop dossier --latest --quiet",
              description: "MartinLoop session receipt on exit"
            }]
          }
        }, null, 2),
        instructions: "Merge the hooks block into your existing ~/.claude/settings.json to enable automatic governance checks."
      };

    case "codex":
      return {
        host,
        supported: true,
        mechanism: "Codex AGENTS.md governance instructions",
        targetPath: scope === "user" ? null : "AGENTS.md",
        content: [
          "## MartinLoop Governance",
          "",
          "Before executing any coding task:",
          "1. Call `martin_doctor` to confirm environment readiness",
          "2. Call `martin_estimate` to preview cost and route",
          "3. Call `martin_plan` to scope the bounded approach",
          "4. Call `martin_preflight` to validate the run contract",
          "5. Only then call `martin_run`",
          "6. After completion, call `martin_dossier` to generate the receipt",
          "",
          "Never claim success without verifier-backed completion evidence from MartinLoop.",
          ""
        ].join("\n"),
        instructions: "Add the governance section to your project's AGENTS.md or ~/.codex/instructions.md."
      };

    case "gemini":
      return {
        host,
        supported: true,
        mechanism: "Gemini CLI GEMINI.md governance rules",
        targetPath: scope === "project" ? "GEMINI.md" : path.join(homedir(), ".gemini", "GEMINI.md"),
        content: [
          "## MartinLoop Governance",
          "",
          "Before any coding work, follow the MartinLoop governed sequence:",
          "1. `martin_doctor` — confirm environment",
          "2. `martin_estimate` — preview cost and recommended route",
          "3. `martin_plan` — scope the approach",
          "4. `martin_preflight` — validate the run contract",
          "5. `martin_run` — execute only after contract is safe",
          "6. `martin_dossier` — inspect what happened",
          "",
          "Do not execute real coding work until doctor and preflight are complete.",
          "Do not claim success without MartinLoop verifier-backed completion.",
          ""
        ].join("\n"),
        instructions: "Add to your GEMINI.md (project) or ~/.gemini/GEMINI.md (user) for automatic governance."
      };

    case "cursor":
      return {
        host,
        supported: true,
        mechanism: "Cursor rules file for governance",
        targetPath: scope === "project" ? ".cursor/rules/martin-governance.mdc" : null,
        content: [
          "---",
          "description: MartinLoop governance rules for Cursor AI",
          "globs: \"**/*\"",
          "---",
          "",
          "## MartinLoop Governance",
          "",
          "Before any coding task, follow the governed sequence:",
          "1. Call `martin_doctor` to confirm environment",
          "2. Call `martin_estimate` to preview cost",
          "3. Call `martin_plan` to scope the approach",
          "4. Call `martin_preflight` to validate the contract",
          "5. Call `martin_run` to execute",
          "6. Call `martin_dossier` for the receipt",
          "",
          "Never skip preflight. Never claim success without verifier evidence.",
          ""
        ].join("\n"),
        instructions: "Save to .cursor/rules/martin-governance.mdc in your project."
      };

    case "copilot":
      return {
        host,
        supported: true,
        mechanism: "GitHub Copilot instructions file",
        targetPath: scope === "project" ? ".github/copilot-instructions.md" : null,
        content: [
          "## MartinLoop Governance",
          "",
          "When MartinLoop MCP server is available, follow the governed coding sequence:",
          "1. `martin_doctor` — confirm environment readiness",
          "2. `martin_estimate` — preview cost and recommended route",
          "3. `martin_plan` — scope the bounded approach",
          "4. `martin_preflight` — validate the run contract before spend",
          "5. `martin_run` — execute only after the contract is validated",
          "6. `martin_dossier` — generate completion receipt",
          "",
          "Do not skip any step. Do not claim success without verifier-backed evidence.",
          ""
        ].join("\n"),
        instructions: "Save to .github/copilot-instructions.md in your repository."
      };

    case "continue":
      return {
        host,
        supported: true,
        mechanism: "Continue.dev rules for governance",
        targetPath: scope === "project" ? ".continue/rules/martin-governance.md" : path.join(homedir(), ".continue", "rules", "martin-governance.md"),
        content: [
          "## MartinLoop Governance",
          "",
          "Before making code changes, follow the MartinLoop governed workflow:",
          "1. Call `martin_doctor` to confirm environment",
          "2. Call `martin_estimate` to preview cost and route",
          "3. Call `martin_plan` to scope the approach",
          "4. Call `martin_preflight` to validate the contract",
          "5. Call `martin_run` to execute governed work",
          "6. Call `martin_dossier` to produce the receipt",
          "",
          "Never bypass governance. Never claim success without verifier evidence.",
          ""
        ].join("\n"),
        instructions: "Save to .continue/rules/martin-governance.md for automatic governance."
      };

    case "generic":
      return {
        host,
        supported: false,
        mechanism: "Manual governance — no native hook support",
        targetPath: null,
        content: [
          "## MartinLoop Governance (Manual)",
          "",
          "Follow this sequence before any agent coding work:",
          "1. martin_doctor → martin_estimate → martin_plan → martin_preflight → martin_run → martin_dossier",
          "",
          "Add this instruction to your agent's system prompt or rules file.",
          ""
        ].join("\n"),
        instructions: "Copy the governance sequence into your agent's system prompt or configuration."
      };
  }
}

export function hostRequiresExperimentalRemoteOptIn(host: MartinMcpHost): boolean {
  return REMOTE_EXPERIMENTAL_HOSTS.has(host);
}

function renderClaudeLocalInstallCommand(
  input: Required<Omit<MartinMcpConfigInput, "remoteUrl">> & { remoteUrl?: string }
): string {
  const args = buildClaudeLocalInstallArgs(input);
  return [args.command, ...args.args].join(" ");
}

function buildClaudeLocalInstallArgs(
  input: Required<Omit<MartinMcpConfigInput, "remoteUrl">> & { remoteUrl?: string }
): {
  command: string;
  args: string[];
} {
  const serverId = input.transport === "remote" ? "martin-loop-remote" : "martin-loop";

  if (input.transport === "remote") {
    return {
      command: "claude",
      args: [
        "mcp",
        "add",
        "--transport",
        "http",
        "--scope",
        "local",
        serverId,
        input.remoteUrl ?? DEFAULT_REMOTE_URL,
        "--header",
        `Authorization: Bearer \${${input.remoteTokenEnv}}`
      ]
    };
  }

  const launcher = buildStdioLauncher(input.platform);
  return {
    command: "claude",
    args: [
      "mcp",
      "add",
      "--transport",
      "stdio",
      "--scope",
      "local",
      "-e",
      `MARTIN_RUNS_DIR=${input.runsRoot}`,
      serverId,
      "--",
      launcher.command,
      ...launcher.args
    ]
  };
}

async function installClaudeLocalScope(plan: MartinMcpInstallPlan): Promise<void> {
  const { command, args } = buildClaudeLocalInstallArgs(plan);
  const outcome = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolvePromise, rejectPromise) => {
      const child = spawn(command, args, {
        cwd: plan.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", rejectPromise);
      child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    }
  );

  const combinedOutput = `${outcome.stdout}\n${outcome.stderr}`;
  if (outcome.code === 0 || /already exists|already configured/iu.test(combinedOutput)) {
    return;
  }

  throw new CliCommandError(
    "environment",
    "Claude Code local-scope MCP installation failed.",
    {
      suggestion: combinedOutput.trim() || renderClaudeLocalInstallCommand(plan)
    }
  );
}
