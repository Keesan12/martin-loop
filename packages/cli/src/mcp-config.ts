import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { CliCommandError } from "./ux.js";

export const MARTIN_STARTER_TOOLS = [
  "martin_doctor",
  "martin_preflight",
  "martin_run",
  "martin_triage_runs",
  "martin_run_dossier"
] as const;

export const MARTIN_MINIMAL_TOOLS = [
  "martin_doctor",
  "martin_preflight",
  "martin_list_runs",
  "martin_triage_runs",
  "martin_run_dossier"
] as const;

export const MARTIN_DIAGNOSTIC_TOOLS = [
  "martin_doctor",
  "martin_preflight",
  "martin_list_runs",
  "martin_triage_runs",
  "martin_get_run",
  "martin_get_attempt",
  "martin_get_verification_results",
  "martin_run_dossier"
] as const;

export const MARTIN_FULL_TOOLS = [
  "martin_run",
  "martin_inspect",
  "martin_status",
  "martin_doctor",
  "martin_preflight",
  "martin_list_runs",
  "martin_triage_runs",
  "martin_get_run",
  "martin_get_attempt",
  "martin_get_verification_results",
  "martin_run_dossier"
] as const;

export const MARTIN_PAID_REMOTE_TOOLS = [
  "martin_doctor",
  "martin_preflight",
  "martin_run",
  "martin_list_runs",
  "martin_triage_runs",
  "martin_get_run",
  "martin_get_verification_results",
  "martin_run_dossier"
] as const;

export type MartinMcpHost = "codex" | "claude" | "gemini" | "generic";
export type MartinMcpScope = "user" | "project" | "local";
export type MartinMcpTransport = "stdio" | "remote";
export type MartinMcpProfile = "minimal" | "diagnostic" | "full-local" | "paid-remote" | "starter" | "full";
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
  platform?: MartinMcpPlatform;
}

export interface MartinMcpInstallPlan extends Required<Omit<MartinMcpConfigInput, "remoteUrl">> {
  remoteUrl?: string;
  targetPath: string;
  content: string;
  serverId: string;
  enabledTools: string[];
  installMethod: "file" | "command";
}

const DEFAULT_REMOTE_URL = "https://remote.martinloop.local/mcp";
const DEFAULT_REMOTE_TOKEN_ENV = "MARTIN_REMOTE_TOKEN";

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
    installMethod: normalized.host === "claude" && normalized.scope === "local" ? "command" : "file"
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

    throw new CliCommandError(
      "environment",
      `Refusing to overwrite existing MCP config: ${plan.targetPath}`,
      {
        suggestion:
          "Use `martin mcp print-config` and merge the Martin Loop block into the existing host config."
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
        generatedBy: "martin mcp print-config",
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
    const parsed = JSON.parse(existing) as {
      mcpServers?: Record<string, unknown>;
    };

    return typeof parsed.mcpServers === "object" && parsed.mcpServers !== null && serverId in parsed.mcpServers;
  } catch {
    return false;
  }
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
