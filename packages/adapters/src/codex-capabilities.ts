import { spawnSync } from "node:child_process";
import { extname } from "node:path";

import { createSpawnPlan, resolveNpmShimScript } from "./cli-bridge.js";
import {
  DEFAULT_AGENT_EXECUTION_INTENT,
  type AgentExecutionIntent
} from "@martin/contracts";

export type CodexFlagScope = "global" | "exec";
export type CodexPromptTransport = "stdin-dash" | "argv";
export type CodexWriteStrategy =
  | "sandbox+approval"
  | "automation";

export interface CodexCapabilityFlag {
  flag: string;
  scope: CodexFlagScope;
}

export interface CodexSandboxCapability extends CodexCapabilityFlag {
  values: string[];
}

export interface CodexApprovalCapability extends CodexCapabilityFlag {
  semantics: "approval-policy" | "automation-mode";
  values?: string[];
}

export interface CodexAutonomyResolution {
  binaryPath: string;
  intent: AgentExecutionIntent;
  strategy: "automation" | "sandbox+approval";
  sandboxValue?: "workspace-write";
  approvalValue?: string;
}

export interface CodexCapabilityProfile {
  binaryPath: string;
  supportsExec: boolean;
  probeSucceeded: boolean;
  probeError?: string;
  model?: CodexCapabilityFlag;
  cwd?: CodexCapabilityFlag;
  sandbox?: CodexSandboxCapability;
  /** Preferred compatibility alias. `automation` and `approvalPolicy` are authoritative. */
  approval?: CodexApprovalCapability;
  automation?: CodexApprovalCapability;
  approvalPolicy?: CodexApprovalCapability;
  json?: CodexCapabilityFlag;
  color?: CodexCapabilityFlag & { neverValue?: string };
  userConfigIsolation?: CodexCapabilityFlag;
  promptTransport: CodexPromptTransport;
  promptTransports?: CodexPromptTransport[];
}

export interface CodexExecArgsOptions {
  command?: string;
  workingDirectory: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  model?: string;
  extraArgs?: string[];
  mode?: "prompt" | "probe";
  prompt?: string;
  capabilityProfile?: CodexCapabilityProfile;
  promptTransport?: CodexPromptTransport;
  writeStrategy?: CodexWriteStrategy;
  autonomyResolution?: CodexAutonomyResolution;
}

type SpawnSyncLike = typeof spawnSync;
const capabilityCache = new Map<string, CodexCapabilityProfile>();

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function flagPattern(flag: string): RegExp {
  return new RegExp(`(?:^|\\s)${escapeRegex(flag)}(?=\\s|[=,<\\[]|$)`, "imu");
}

function locateFlag(
  globalHelp: string,
  execHelp: string,
  candidates: string[]
): CodexCapabilityFlag | undefined {
  for (const flag of candidates) {
    if (flagPattern(flag).test(execHelp)) return { flag, scope: "exec" };
  }
  for (const flag of candidates) {
    if (flagPattern(flag).test(globalHelp)) return { flag, scope: "global" };
  }
  return undefined;
}

function flagContext(help: string, flag: string): string {
  const lines = help.split(/\r?\n/u);
  const index = lines.findIndex((line) => line.includes(flag));
  if (index < 0) return "";
  return lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 3)).join("\n");
}

function parseAdvertisedValues(help: string, flag: string): string[] {
  const flagIndex = help.indexOf(flag);
  if (flagIndex < 0) return [];
  const tail = help.slice(flagIndex);
  const nextFlagOffset = tail.slice(flag.length).search(/\n\s*-/u);
  const scoped = nextFlagOffset < 0
    ? tail
    : tail.slice(0, flag.length + nextFlagOffset);
  const match = scoped.match(/possible values:\s*([^\]\n]+)/iu);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((value) => value.trim().replace(/[\].]$/u, ""))
    .filter(Boolean);
}

function buildInjectedSpawnPlan(
  binaryPath: string,
  args: string[],
  platform: NodeJS.Platform
): { command: string; args: string[] } {
  if (platform !== "win32") return { command: binaryPath, args };
  const extension = extname(binaryPath).toLowerCase();
  if (extension === ".cmd" || extension === ".bat" || extension === ".ps1") {
    const script = resolveNpmShimScript(binaryPath);
    if (script) return { command: process.execPath, args: [script, ...args] };
    if (extension === ".ps1") {
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", binaryPath, ...args]
      };
    }
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/c", binaryPath, ...args]
    };
  }
  return { command: binaryPath, args };
}

function runHelpProbe(input: {
  binaryPath: string;
  args: string[];
  platform: NodeJS.Platform;
  spawnSyncImpl: SpawnSyncLike;
  injected: boolean;
}): { text: string; status: number | null; error?: string } {
  const plan = input.injected
    ? buildInjectedSpawnPlan(input.binaryPath, input.args, input.platform)
    : createSpawnPlan(input.binaryPath, input.args, process.cwd(), false);
  const result = input.spawnSyncImpl(plan.command, plan.args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 8_000
  });
  return {
    text: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    status: result.status,
    ...(result.error ? { error: result.error.message } : {})
  };
}

function parsePromptTransports(execHelp: string): CodexPromptTransport[] {
  const transports: CodexPromptTransport[] = [];
  const stdinAdvertised = /\bstdin\b/iu.test(execHelp) || /(?:^|\s)-(?:\s|,|$).*prompt/imu.test(execHelp);
  const argvAdvertised = /(?:\[|<)PROMPT(?:\]|>)/iu.test(execHelp) || /\bPROMPT\b/iu.test(execHelp);
  if (stdinAdvertised) transports.push("stdin-dash");
  if (argvAdvertised || !stdinAdvertised) transports.push("argv");
  return [...new Set(transports)];
}

export function clearCodexCapabilityCacheForTests(): void {
  capabilityCache.clear();
}

export function cacheCodexCapabilityProfile(
  profile: CodexCapabilityProfile,
  platform: NodeJS.Platform = process.platform
): CodexCapabilityProfile {
  capabilityCache.set(`${platform}:${profile.binaryPath}`, profile);
  return profile;
}

export function probeCodexCapabilities(
  binaryPath: string,
  options: {
    platform?: NodeJS.Platform;
    spawnSyncImpl?: SpawnSyncLike;
    cache?: boolean;
  } = {}
): CodexCapabilityProfile {
  const platform = options.platform ?? process.platform;
  const key = `${platform}:${binaryPath}`;
  const useCache = options.cache ?? options.spawnSyncImpl === undefined;
  if (useCache) {
    const cached = capabilityCache.get(key);
    if (cached) return cached;
  }

  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const injected = options.spawnSyncImpl !== undefined;
  const globalProbe = runHelpProbe({
    binaryPath,
    args: ["--help"],
    platform,
    spawnSyncImpl,
    injected
  });
  const execProbe = runHelpProbe({
    binaryPath,
    args: ["exec", "--help"],
    platform,
    spawnSyncImpl,
    injected
  });
  const globalHelp = globalProbe.text;
  const execHelp = execProbe.text;
  const supportsExec =
    execProbe.status === 0 &&
    !/(unknown command|unrecognized subcommand|unexpected argument ['"]?exec)/iu.test(execHelp);

  const sandboxFlag = locateFlag(globalHelp, execHelp, ["--sandbox", "-s"]);
  const sandboxHelp = sandboxFlag
    ? `${flagContext(globalHelp, sandboxFlag.flag)}\n${flagContext(execHelp, sandboxFlag.flag)}`
    : "";
  const sandboxValues = ["read-only", "workspace-write", "danger-full-access"].filter((value) =>
    new RegExp(`\\b${escapeRegex(value)}\\b`, "iu").test(sandboxHelp)
  );

  const automationFlag = locateFlag(globalHelp, execHelp, ["--approve-for-me", "--full-auto"]);
  const automation = automationFlag
    ? { ...automationFlag, semantics: "automation-mode" as const }
    : undefined;

  const approvalFlag = locateFlag(globalHelp, execHelp, ["--ask-for-approval", "-a"]);
  const approvalHelp = approvalFlag
    ? `${flagContext(globalHelp, approvalFlag.flag)}\n${flagContext(execHelp, approvalFlag.flag)}`
    : "";
  const approvalValues = approvalFlag ? parseAdvertisedValues(approvalHelp, approvalFlag.flag) : [];
  const approvalPolicy = approvalFlag
    ? { ...approvalFlag, semantics: "approval-policy" as const, values: approvalValues }
    : undefined;

  const colorFlag = locateFlag(globalHelp, execHelp, ["--color"]);
  const colorHelp = colorFlag
    ? `${flagContext(globalHelp, colorFlag.flag)}\n${flagContext(execHelp, colorFlag.flag)}`
    : "";
  const promptTransports = parsePromptTransports(execHelp);
  const probeError = globalProbe.error ?? execProbe.error;

  const profile: CodexCapabilityProfile = {
    binaryPath,
    supportsExec,
    probeSucceeded: supportsExec && `${globalHelp}\n${execHelp}`.trim().length > 0,
    ...(probeError ? { probeError } : {}),
    ...(locateFlag(globalHelp, execHelp, ["--model", "-m"])
      ? { model: locateFlag(globalHelp, execHelp, ["--model", "-m"]) }
      : {}),
    ...(locateFlag(globalHelp, execHelp, ["--cd", "--cwd", "--working-dir", "-C"])
      ? { cwd: locateFlag(globalHelp, execHelp, ["--cd", "--cwd", "--working-dir", "-C"]) }
      : {}),
    ...(sandboxFlag ? { sandbox: { ...sandboxFlag, values: sandboxValues } } : {}),
    ...(automation ? { automation, approval: automation } : {}),
    ...(approvalPolicy
      ? {
          approvalPolicy,
          ...(!automation ? { approval: approvalPolicy } : {})
        }
      : {}),
    ...(locateFlag(globalHelp, execHelp, ["--json"])
      ? { json: locateFlag(globalHelp, execHelp, ["--json"]) }
      : {}),
    ...(colorFlag
      ? {
          color: {
            ...colorFlag,
            ...(/\bnever\b/iu.test(colorHelp) ? { neverValue: "never" } : {})
          }
        }
      : {}),
    ...(locateFlag(globalHelp, execHelp, ["--ignore-user-config", "--no-user-config"])
      ? { userConfigIsolation: locateFlag(globalHelp, execHelp, ["--ignore-user-config", "--no-user-config"]) }
      : {}),
    promptTransport: promptTransports[0] ?? "argv",
    promptTransports
  };

  if (useCache) cacheCodexCapabilityProfile(profile, platform);
  return profile;
}

function pushCapabilityArg(
  globalArgs: string[],
  execArgs: string[],
  capability: CodexCapabilityFlag,
  ...values: string[]
): void {
  (capability.scope === "global" ? globalArgs : execArgs).push(capability.flag, ...values);
}

export function codexWriteStrategies(profile: CodexCapabilityProfile): CodexWriteStrategy[] {
  return resolveCodexAutonomyCandidates(profile).map((candidate) => candidate.strategy);
}

export function resolveCodexAutonomyCandidates(
  profile: CodexCapabilityProfile,
  intent: AgentExecutionIntent = DEFAULT_AGENT_EXECUTION_INTENT
): CodexAutonomyResolution[] {
  const candidates: CodexAutonomyResolution[] = [];
  if (profile.automation) {
    candidates.push({
      binaryPath: profile.binaryPath,
      intent,
      strategy: "automation"
    });
  }
  return candidates;
}

export function buildCodexExecArgs(options: CodexExecArgsOptions): string[] {
  const profile = options.capabilityProfile ?? probeCodexCapabilities(options.command ?? "codex");
  if (!profile.supportsExec) {
    throw new Error(`Resolved Codex binary ${profile.binaryPath} does not advertise a usable exec subcommand.`);
  }

  const resolution = options.autonomyResolution;
  if (options.mode !== "probe" && !resolution) {
    throw new Error(`Resolved Codex binary ${profile.binaryPath} has no negotiated governed-autonomous execution resolution.`);
  }
  const permissionFlags = [profile.sandbox?.flag, profile.automation?.flag, profile.approvalPolicy?.flag]
    .filter((value): value is string => Boolean(value));
  if ((options.extraArgs ?? []).some((arg) =>
    arg === "danger-full-access" || permissionFlags.some((flag) => arg === flag || arg.startsWith(`${flag}=`))
  )) {
    throw new Error("Permission and sandbox controls cannot be supplied through extraArgs.");
  }

  const globalArgs: string[] = [];
  const execArgs: string[] = [];
  const requestedSandbox = options.sandbox ?? "workspace-write";
  const strategy = resolution?.strategy ?? options.writeStrategy;
  const promptTransport = options.promptTransport ?? profile.promptTransport;

  if (profile.userConfigIsolation) pushCapabilityArg(globalArgs, execArgs, profile.userConfigIsolation);
  if (profile.cwd) pushCapabilityArg(globalArgs, execArgs, profile.cwd, options.workingDirectory);

  if (requestedSandbox === "workspace-write") {
    if (strategy === "sandbox+approval" && profile.sandbox?.values.includes("workspace-write")) {
      pushCapabilityArg(globalArgs, execArgs, profile.sandbox, "workspace-write");
    }
    if (strategy === "automation" && profile.automation) {
      pushCapabilityArg(globalArgs, execArgs, profile.automation);
    }
    if (strategy === "sandbox+approval" && profile.approvalPolicy && resolution?.approvalValue) {
      pushCapabilityArg(globalArgs, execArgs, profile.approvalPolicy, resolution.approvalValue);
    }
  } else {
    if (!profile.sandbox?.values.includes(requestedSandbox)) {
      throw new Error(`Resolved Codex binary ${profile.binaryPath} does not advertise requested sandbox mode ${requestedSandbox}.`);
    }
    pushCapabilityArg(globalArgs, execArgs, profile.sandbox, requestedSandbox);
  }

  if (profile.json) pushCapabilityArg(globalArgs, execArgs, profile.json);
  if (profile.color?.neverValue) pushCapabilityArg(globalArgs, execArgs, profile.color, profile.color.neverValue);

  if (options.model) {
    if (!profile.model) {
      throw new Error(`Resolved Codex binary ${profile.binaryPath} does not advertise a model override flag.`);
    }
    pushCapabilityArg(globalArgs, execArgs, profile.model, options.model);
  }

  const prompt = options.prompt ?? "";
  const promptArgs = promptTransport === "stdin-dash" ? ["-"] : prompt ? [prompt] : [];
  return [...globalArgs, "exec", ...execArgs, ...(options.extraArgs ?? []), ...promptArgs];
}

export function buildCodexStdin(
  profile: CodexCapabilityProfile,
  prompt: string,
  transport: CodexPromptTransport = profile.promptTransport
): string | undefined {
  return transport === "stdin-dash" ? prompt : undefined;
}
