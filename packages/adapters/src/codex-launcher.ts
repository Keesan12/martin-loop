import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

import { resolveNpmShimScript } from "./cli-bridge.js";

export interface CliCommandAvailability {
  command: string;
  available: boolean;
  locator: string;
  detail: string;
  resolvedPath?: string;
  candidatePaths?: string[];
}

export type CodexHostPlatform = "windows" | "linux" | "wsl" | "macos";
export type CodexInstallKind = "missing" | "native" | "windows_shim" | "windows_mounted_path";
export type CodexInvocationMode = "direct" | "cmd_shell" | "powershell";
export type CodexFlagScope = "global" | "exec";
export type CodexPromptTransport = "stdin-dash" | "argv";

export interface CodexCapabilityFlag {
  flag: string;
  scope: CodexFlagScope;
}

export interface CodexSandboxCapability extends CodexCapabilityFlag {
  values: string[];
}

export interface CodexApprovalCapability extends CodexCapabilityFlag {
  semantics: "approval-policy" | "automation-mode";
  value?: string;
}

export interface CodexCapabilityProfile {
  binaryPath: string;
  supportsExec: boolean;
  probeSucceeded: boolean;
  probeError?: string;
  model?: CodexCapabilityFlag;
  cwd?: CodexCapabilityFlag;
  sandbox?: CodexSandboxCapability;
  approval?: CodexApprovalCapability;
  json?: CodexCapabilityFlag;
  color?: CodexCapabilityFlag & { neverValue?: string };
  userConfigIsolation?: CodexCapabilityFlag;
  promptTransport: CodexPromptTransport;
}

export interface CodexHostDiagnosis {
  hostPlatform: CodexHostPlatform;
  nativeInstallValid: boolean;
  installKind: CodexInstallKind;
  invocationMode: CodexInvocationMode;
  sandboxMode: "workspace-write";
  sandboxCompatible: boolean;
  resolvedPath?: string;
  nativeDependencyStatus?: "unknown" | "missing";
  nativeDependencyPackage?: string;
  warnings: string[];
  remediation?: string;
}

export interface CodexProbeCandidateResult {
  path: string;
  installKind: CodexInstallKind;
  invocationMode: CodexInvocationMode;
  nativeInstallValid: boolean;
  sandboxCompatible: boolean;
  launchReady: boolean;
  summary: string;
  remediation?: string;
  nativeDependencyStatus?: "unknown" | "missing";
  nativeDependencyPackage?: string;
  capabilityProfile?: CodexCapabilityProfile;
}

export interface CodexLaunchProbeResult {
  ok: boolean;
  summary: string;
  availability: CliCommandAvailability;
  diagnosis: CodexHostDiagnosis;
  command: string;
  args: string[];
  capabilityProfile?: CodexCapabilityProfile;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  candidateProbeResults?: CodexProbeCandidateResult[];
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
}

type SpawnSyncLike = typeof spawnSync;

const codexLaunchProbeCache = new Map<string, CodexLaunchProbeResult>();
const codexCapabilityCache = new Map<string, CodexCapabilityProfile>();

export interface CodexSandboxPreflightOk {
  ok: true;
  effectiveSandbox: "read-only" | "workspace-write";
  capabilitySource: "probe";
  writableRoot: string;
}

export interface CodexSandboxPreflightReadOnly {
  ok: false;
  code: "provider_sandbox_read_only";
  requestedCapability: "workspace-write";
  detectedCapability: "read-only";
  effectiveSandbox: "read-only";
  affectedPath: string;
  writableRoot: string;
  capabilitySource: "probe";
  remediation: string;
}

export type CodexSandboxPreflightOutcome = CodexSandboxPreflightOk | CodexSandboxPreflightReadOnly;

export function probeFilesystemWriteCapability(
  directory: string
): { writable: true } | { writable: false; reason: string } {
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    return {
      writable: false,
      reason: `Could not create directory ${directory}: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  let tempDir: string | undefined;
  try {
    tempDir = mkdtempSync(join(directory, ".ml-write-probe-"));
    const tempFile = join(tempDir, "capability.tmp");
    writeFileSync(tempFile, "\x01", { encoding: "binary", flag: "wx" });
    unlinkSync(tempFile);
    return { writable: true };
  } catch (error) {
    return {
      writable: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
    }
  }
}

export function checkCodexSandboxPreflight(input: {
  requestedSandbox: "read-only" | "workspace-write";
  workingDirectory: string;
}): CodexSandboxPreflightOutcome {
  const directory = resolve(input.workingDirectory);
  if (input.requestedSandbox === "read-only") {
    return {
      ok: true,
      effectiveSandbox: "read-only",
      capabilitySource: "probe",
      writableRoot: directory
    };
  }

  const result = probeFilesystemWriteCapability(directory);
  if (result.writable) {
    return {
      ok: true,
      effectiveSandbox: "workspace-write",
      capabilitySource: "probe",
      writableRoot: directory
    };
  }

  return {
    ok: false,
    code: "provider_sandbox_read_only",
    requestedCapability: "workspace-write",
    detectedCapability: "read-only",
    effectiveSandbox: "read-only",
    affectedPath: directory,
    writableRoot: directory,
    capabilitySource: "probe",
    remediation:
      `The working directory ${directory} is not writable by the current process. ` +
      "Launch MartinLoop in a session with write access to that directory, or use `--sandbox read-only` for inspection-only work."
  };
}

interface OrderedProbeCandidate {
  path: string;
  diagnosis: CodexHostDiagnosis;
  preference: number;
  discoveryIndex: number;
}

function normalizeCandidates(lines: string[]): string[] {
  return [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
}

function readLocatorCandidates(
  command: string,
  platform: NodeJS.Platform,
  spawnSyncImpl: SpawnSyncLike
): { locator: string; candidates: string[] } {
  const locator = platform === "win32" ? "where.exe" : "which";
  const result = spawnSyncImpl(locator, [command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    locator,
    candidates: result.status === 0 ? normalizeCandidates((result.stdout ?? "").split(/\r?\n/u)) : []
  };
}

function discoverWindowsDesktopCodexCandidates(env: NodeJS.ProcessEnv): string[] {
  const localAppData = env["LOCALAPPDATA"];
  if (!localAppData) return [];

  const baseDirectory = join(localAppData, "OpenAI", "Codex", "bin");
  if (!existsSync(baseDirectory)) return [];

  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  const directCandidate = join(baseDirectory, "codex.exe");
  if (existsSync(directCandidate)) {
    candidates.push({ path: directCandidate, mtimeMs: statSync(directCandidate).mtimeMs });
  }

  for (const entry of readdirSync(baseDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(baseDirectory, entry.name, "codex.exe");
    if (existsSync(candidate)) {
      candidates.push({ path: candidate, mtimeMs: statSync(candidate).mtimeMs });
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return normalizeCandidates(candidates.map((candidate) => candidate.path));
}

function buildProbeCommand(
  command: string,
  args: string[],
  platform: NodeJS.Platform
): { command: string; args: string[]; invocationMode: CodexInvocationMode } {
  if (platform !== "win32") {
    return { command, args, invocationMode: "direct" };
  }

  const extension = extname(command).toLowerCase();
  if (extension === ".cmd" || extension === ".bat" || extension === ".ps1") {
    const directScript = resolveNpmShimScript(command);
    if (directScript !== undefined) {
      return { command: process.execPath, args: [directScript, ...args], invocationMode: "direct" };
    }

    if (extension === ".ps1") {
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", command, ...args],
        invocationMode: "powershell"
      };
    }

    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/c", command, ...args],
      invocationMode: "cmd_shell"
    };
  }

  return { command, args, invocationMode: "direct" };
}

function detectInstallKind(
  resolvedPath: string | undefined,
  hostPlatform: CodexHostPlatform
): CodexInstallKind {
  if (!resolvedPath) return "missing";

  const normalizedPath = resolvedPath.replace(/\\/gu, "/").toLowerCase();
  const looksWindowsShim =
    normalizedPath.endsWith(".cmd") ||
    normalizedPath.endsWith(".bat") ||
    normalizedPath.endsWith(".ps1") ||
    normalizedPath.includes("/appdata/roaming/npm/");
  const looksMountedWindowsPath = normalizedPath.startsWith("/mnt/c/");

  if ((hostPlatform === "linux" || hostPlatform === "wsl") && looksMountedWindowsPath) {
    return "windows_mounted_path";
  }
  return looksWindowsShim ? "windows_shim" : "native";
}

function detectInvocationMode(resolvedPath: string | undefined, platform: NodeJS.Platform): CodexInvocationMode {
  if (platform !== "win32" || !resolvedPath) return "direct";
  const extension = extname(resolvedPath).toLowerCase();
  if (extension === ".ps1") return "powershell";
  if (extension === ".cmd" || extension === ".bat") return "cmd_shell";
  return "direct";
}

function codexProbePreference(diagnosis: CodexHostDiagnosis): number {
  if (diagnosis.installKind === "native" && diagnosis.invocationMode === "direct") return 0;
  if (diagnosis.installKind === "native") return 1;
  if (diagnosis.installKind === "windows_shim") return 2;
  return 3;
}

function codexProbeCandidatePreference(
  path: string,
  diagnosis: CodexHostDiagnosis,
  platform: NodeJS.Platform
): number {
  const hostPreference = codexProbePreference(diagnosis) * 10;
  if (platform !== "win32" || diagnosis.installKind !== "windows_shim") return hostPreference;
  const extension = extname(path).toLowerCase();
  return hostPreference + (extension === ".cmd" || extension === ".bat" || extension === ".ps1" ? 0 : 1);
}

function buildProbeCandidates(input: {
  availability: CliCommandAvailability;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  includeDesktopCandidates: boolean;
}): OrderedProbeCandidate[] {
  const pathCandidates = normalizeCandidates(
    input.availability.candidatePaths ?? [input.availability.resolvedPath ?? input.availability.command]
  );
  const desktopCandidates =
    input.platform === "win32" && input.includeDesktopCandidates
      ? discoverWindowsDesktopCodexCandidates(input.env).filter((candidate) => !pathCandidates.includes(candidate))
      : [];

  return [...pathCandidates, ...desktopCandidates]
    .map((path, discoveryIndex) => {
      const diagnosis = diagnoseCodexHost(
        { ...input.availability, resolvedPath: path },
        { env: input.env, platform: input.platform }
      );
      return {
        path,
        diagnosis,
        preference: input.platform === "win32" ? codexProbeCandidatePreference(path, diagnosis, input.platform) : 0,
        discoveryIndex
      };
    })
    .sort((left, right) =>
      left.preference === right.preference
        ? left.discoveryIndex - right.discoveryIndex
        : left.preference - right.preference
    );
}

function flagPattern(flag: string): RegExp {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}(?=\\s|[=,<\\[]|$)`, "imu");
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

function runHelpProbe(input: {
  binaryPath: string;
  args: string[];
  platform: NodeJS.Platform;
  spawnSyncImpl: SpawnSyncLike;
}): { text: string; status: number | null; error?: string } {
  const plan = buildProbeCommand(input.binaryPath, input.args, input.platform);
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

export function clearCodexCapabilityCacheForTests(): void {
  codexCapabilityCache.clear();
  codexLaunchProbeCache.clear();
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
  const cacheKey = `${platform}:${binaryPath}`;
  const useCache = options.cache ?? options.spawnSyncImpl === undefined;
  if (useCache) {
    const cached = codexCapabilityCache.get(cacheKey);
    if (cached) return cached;
  }

  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const globalProbe = runHelpProbe({ binaryPath, args: ["--help"], platform, spawnSyncImpl });
  const execProbe = runHelpProbe({ binaryPath, args: ["exec", "--help"], platform, spawnSyncImpl });
  const globalHelp = globalProbe.text;
  const execHelp = execProbe.text;
  const combined = `${globalHelp}\n${execHelp}`;
  const supportsExec =
    execProbe.status === 0 &&
    !/(unknown command|unrecognized subcommand|unexpected argument ['\"]?exec)/iu.test(execHelp);

  const sandboxFlag = locateFlag(globalHelp, execHelp, ["--sandbox"]);
  const sandboxValues = ["read-only", "workspace-write", "danger-full-access"].filter((value) =>
    new RegExp(`\\b${value.replace(/-/gu, "\\-")}\\b`, "iu").test(combined)
  );

  const automationFlag = locateFlag(globalHelp, execHelp, ["--approve-for-me", "--full-auto"]);
  const approvalPolicyFlag = locateFlag(globalHelp, execHelp, ["--ask-for-approval"]);
  const approval = automationFlag
    ? { ...automationFlag, semantics: "automation-mode" as const }
    : approvalPolicyFlag && /\bnever\b/iu.test(combined)
      ? { ...approvalPolicyFlag, semantics: "approval-policy" as const, value: "never" }
      : undefined;

  const colorFlag = locateFlag(globalHelp, execHelp, ["--color"]);
  const promptTransport: CodexPromptTransport = /\bstdin\b/iu.test(execHelp) ? "stdin-dash" : "argv";
  const probeError = globalProbe.error ?? execProbe.error;

  const profile: CodexCapabilityProfile = {
    binaryPath,
    supportsExec,
    probeSucceeded: supportsExec && combined.trim().length > 0,
    ...(probeError ? { probeError } : {}),
    ...(locateFlag(globalHelp, execHelp, ["--model"]) ? { model: locateFlag(globalHelp, execHelp, ["--model"]) } : {}),
    ...(locateFlag(globalHelp, execHelp, ["--cd", "--cwd", "--working-dir"])
      ? { cwd: locateFlag(globalHelp, execHelp, ["--cd", "--cwd", "--working-dir"]) }
      : {}),
    ...(sandboxFlag ? { sandbox: { ...sandboxFlag, values: sandboxValues } } : {}),
    ...(approval ? { approval } : {}),
    ...(locateFlag(globalHelp, execHelp, ["--json"]) ? { json: locateFlag(globalHelp, execHelp, ["--json"]) } : {}),
    ...(colorFlag
      ? { color: { ...colorFlag, ...(/\bnever\b/iu.test(combined) ? { neverValue: "never" } : {}) } }
      : {}),
    ...(locateFlag(globalHelp, execHelp, ["--ignore-user-config", "--no-user-config"])
      ? { userConfigIsolation: locateFlag(globalHelp, execHelp, ["--ignore-user-config", "--no-user-config"]) }
      : {}),
    promptTransport
  };

  if (useCache) codexCapabilityCache.set(cacheKey, profile);
  return profile;
}

function pushCapabilityArg(
  globalArgs: string[],
  execArgs: string[],
  capability: CodexCapabilityFlag,
  ...values: string[]
): void {
  const target = capability.scope === "global" ? globalArgs : execArgs;
  target.push(capability.flag, ...values);
}

export function buildCodexExecArgs(options: CodexExecArgsOptions): string[] {
  const profile =
    options.capabilityProfile ??
    probeCodexCapabilities(options.command ?? "codex");
  const globalArgs: string[] = [];
  const execArgs: string[] = [];
  const requestedSandbox = options.sandbox ?? "workspace-write";

  if (!profile.supportsExec) {
    throw new Error(`Resolved Codex binary ${profile.binaryPath} does not advertise a usable exec subcommand.`);
  }

  if (profile.userConfigIsolation) {
    pushCapabilityArg(globalArgs, execArgs, profile.userConfigIsolation);
  }

  if (profile.cwd) {
    pushCapabilityArg(globalArgs, execArgs, profile.cwd, options.workingDirectory);
  }

  if (profile.sandbox?.values.includes(requestedSandbox)) {
    pushCapabilityArg(globalArgs, execArgs, profile.sandbox, requestedSandbox);
  } else if (requestedSandbox === "workspace-write" && profile.approval?.semantics === "automation-mode") {
    pushCapabilityArg(globalArgs, execArgs, profile.approval);
  } else if (requestedSandbox !== "workspace-write") {
    throw new Error(
      `Resolved Codex binary ${profile.binaryPath} does not advertise requested sandbox mode ${requestedSandbox}.`
    );
  }

  if (requestedSandbox === "workspace-write" && profile.approval?.semantics === "approval-policy" && profile.approval.value) {
    pushCapabilityArg(globalArgs, execArgs, profile.approval, profile.approval.value);
  }

  if (profile.json) {
    pushCapabilityArg(globalArgs, execArgs, profile.json);
  }

  if (profile.color?.neverValue) {
    pushCapabilityArg(globalArgs, execArgs, profile.color, profile.color.neverValue);
  }

  if (options.model) {
    if (!profile.model) {
      throw new Error(`Resolved Codex binary ${profile.binaryPath} does not advertise a model override flag.`);
    }
    pushCapabilityArg(globalArgs, execArgs, profile.model, options.model);
  }

  const prompt = options.prompt ?? "";
  const promptArgs = profile.promptTransport === "stdin-dash" ? ["-"] : prompt ? [prompt] : [];

  return [
    ...globalArgs,
    "exec",
    ...execArgs,
    ...(options.extraArgs ?? []),
    ...promptArgs
  ];
}

export function buildCodexStdin(
  profile: CodexCapabilityProfile,
  prompt: string
): string | undefined {
  return profile.promptTransport === "stdin-dash" ? prompt : undefined;
}

export function resolveCliCommandAvailability(
  command: string,
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    spawnSyncImpl?: SpawnSyncLike;
  } = {}
): CliCommandAvailability {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const discovery = readLocatorCandidates(command, platform, spawnSyncImpl);

  if (discovery.candidates.length > 0) {
    const resolvedPath = discovery.candidates[0];
    return {
      command,
      available: true,
      locator: discovery.locator,
      detail: `${command} is available on PATH.`,
      ...(resolvedPath ? { resolvedPath } : {}),
      candidatePaths: discovery.candidates
    };
  }

  const offPathCandidate = discoverCommandOffPath(command, platform, env);
  if (offPathCandidate) {
    return {
      command,
      available: true,
      locator: "off-path-discovery",
      detail: `${command} found at ${offPathCandidate} (not on PATH, auto-discovered).`,
      resolvedPath: offPathCandidate,
      candidatePaths: [offPathCandidate]
    };
  }

  return {
    command,
    available: false,
    locator: discovery.locator,
    detail: `${command} is not installed. ${suggestInstall(command)}`
  };
}

function discoverCommandOffPath(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string | undefined {
  const home = env.HOME ?? env.USERPROFILE ?? "";
  const directories: string[] = [];

  if (platform === "win32") {
    if (env.APPDATA) directories.push(join(env.APPDATA, "npm"));
    if (env.LOCALAPPDATA) directories.push(join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin"));
    if (home) directories.push(join(home, "scoop", "shims"));
  } else {
    directories.push("/usr/local/bin", "/opt/homebrew/bin");
    if (home) {
      directories.push(
        join(home, ".local", "bin"),
        join(home, ".npm-global", "bin"),
        join(home, ".bun", "bin"),
        join(home, ".cargo", "bin")
      );
    }
    if (env.NVM_DIR) directories.push(join(env.NVM_DIR, "current", "bin"));
  }

  const extensions =
    platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((extension) => extension.trim().toLowerCase()).filter(Boolean)
      : [""];

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = extension ? join(directory, `${command}${extension}`) : join(directory, command);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function suggestInstall(command: string): string {
  const installs: Record<string, string> = {
    claude: "Install with: npm install -g @anthropic-ai/claude-code",
    codex: "Install with: npm install -g @openai/codex",
    gemini: "Install with: npm install -g @google/gemini-cli"
  };
  return installs[command] ?? `Install ${command} and ensure it is available.`;
}

export function detectCodexHostPlatform(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): CodexHostPlatform {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (env["WSL_DISTRO_NAME"] || env["WSL_INTEROP"]) return "wsl";
  return "linux";
}

export function diagnoseCodexHost(
  availability: CliCommandAvailability,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}
): CodexHostDiagnosis {
  const platform = options.platform ?? process.platform;
  const hostPlatform = detectCodexHostPlatform(options.env ?? process.env, platform);
  const resolvedPath = availability.resolvedPath;
  const installKind = detectInstallKind(resolvedPath, hostPlatform);
  const invocationMode = detectInvocationMode(resolvedPath, platform);
  const warnings: string[] = [];

  if (!availability.available) {
    return {
      hostPlatform,
      nativeInstallValid: false,
      installKind,
      invocationMode,
      sandboxMode: "workspace-write",
      sandboxCompatible: false,
      ...(resolvedPath ? { resolvedPath } : {}),
      warnings,
      remediation: "Install or expose the Codex CLI on PATH before running governed Codex work."
    };
  }

  if (
    (hostPlatform === "linux" || hostPlatform === "wsl") &&
    (installKind === "windows_shim" || installKind === "windows_mounted_path")
  ) {
    warnings.push("Codex resolves to a Windows-hosted install from a Linux/WSL environment.");
    return {
      hostPlatform,
      nativeInstallValid: false,
      installKind,
      invocationMode,
      sandboxMode: "workspace-write",
      sandboxCompatible: false,
      ...(resolvedPath ? { resolvedPath } : {}),
      warnings,
      remediation: "Install Codex natively inside this Linux/WSL environment instead of relying on a Windows PATH shim."
    };
  }

  return {
    hostPlatform,
    nativeInstallValid: true,
    installKind,
    invocationMode,
    sandboxMode: "workspace-write",
    sandboxCompatible: true,
    ...(resolvedPath ? { resolvedPath } : {}),
    ...(hostPlatform === "linux" || hostPlatform === "wsl"
      ? { nativeDependencyStatus: "unknown" as const }
      : {}),
    warnings
  };
}

function classifyProbeFailure(
  stderr: string,
  stdout: string,
  diagnosis: CodexHostDiagnosis
): { summary?: string; diagnosis?: CodexHostDiagnosis } {
  const combined = `${stderr}\n${stdout}`;

  if (/MARTIN_REMOTE_TOKEN|AuthRequired\(AuthRequiredError|www_authenticate_header/iu.test(combined)) {
    const warnings = [...diagnosis.warnings, "Codex inherited auth-sensitive MCP or plugin state from the operator's default user config."];
    return {
      summary: "Codex inherited auth-sensitive MCP or plugin state from the operator's default user config.",
      diagnosis: {
        ...diagnosis,
        warnings: [...new Set(warnings)],
        remediation: "Use the resolved Codex binary's advertised user-config isolation capability, or repair the default Codex configuration before governed work."
      }
    };
  }

  if (/not supported when using Codex with a ChatGPT account/iu.test(combined)) {
    return {
      summary: "Codex launched with a model that is not supported for the current authentication mode.",
      diagnosis: {
        ...diagnosis,
        warnings: [...diagnosis.warnings, "Codex rejected the selected model for the current authentication mode."],
        remediation: "Use a model supported by the authenticated Codex installation, or omit the explicit model override."
      }
    };
  }

  if (/@openai\/codex-linux-x64|cannot find module ['\"]@openai\/codex-linux-x64['\"]/iu.test(combined)) {
    return {
      summary: "Codex native dependency '@openai/codex-linux-x64' is missing for this Linux/WSL environment.",
      diagnosis: {
        ...diagnosis,
        nativeInstallValid: false,
        sandboxCompatible: false,
        nativeDependencyStatus: "missing",
        nativeDependencyPackage: "@openai/codex-linux-x64",
        warnings: [...diagnosis.warnings, "Codex is missing its native Linux runtime package."],
        remediation: "Reinstall Codex natively inside this Linux/WSL environment before running governed work."
      }
    };
  }

  if (/CreateProcessAsUserW failed:\s*5|windows sandbox: runner error|spawn setup refresh/iu.test(combined)) {
    return {
      summary: "Codex could not launch a writable subprocess on this Windows host.",
      diagnosis: {
        ...diagnosis,
        sandboxCompatible: false,
        warnings: [...diagnosis.warnings, "Codex could not launch a writable subprocess on this Windows host."],
        remediation: "Repair or update the resolved Codex installation until its advertised writable execution mode can create a file in the workspace."
      }
    };
  }

  if (/writing is blocked by read-only sandbox|read-only filesystem sandbox|approval is disabled/iu.test(combined)) {
    return {
      summary: "Codex remained read-only even though MartinLoop requires writable execution for this governed run.",
      diagnosis: {
        ...diagnosis,
        sandboxCompatible: false,
        warnings: [...diagnosis.warnings, "Codex remained read-only for a writable governed run."],
        remediation: "Use a Codex installation or host configuration whose advertised capabilities allow workspace writes."
      }
    };
  }

  return {};
}

function isInsideGitRepository(workingDirectory: string): boolean {
  let current = resolve(workingDirectory);
  while (true) {
    if (existsSync(resolve(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function buildProbeCacheKey(input: {
  workingDirectory: string;
  platform: NodeJS.Platform;
  candidatePaths: string[];
  model?: string;
}): string {
  return JSON.stringify({
    workingDirectory: resolve(input.workingDirectory),
    platform: input.platform,
    candidatePaths: input.candidatePaths,
    model: input.model
  });
}

function buildWriteProbePrompt(markerName: string): string {
  return [
    "You are validating MartinLoop Codex host readiness.",
    "Do not modify tracked files.",
    "Use the shell command executor exactly once.",
    `Run a Node command that writes the exact text MARTIN_CODEX_WRITE_OK to ${markerName}.`,
    "Do not use MCP tools, Node REPL, or fallback tools.",
    "After the shell command succeeds, reply with READY only."
  ].join("\n");
}

export function probeCodexLaunch(
  input: {
    workingDirectory: string;
    availability?: CliCommandAvailability;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    spawnSyncImpl?: SpawnSyncLike;
    model?: string;
  }
): CodexLaunchProbeResult {
  const availability =
    input.availability ??
    resolveCliCommandAvailability("codex", {
      ...(input.platform ? { platform: input.platform } : {}),
      ...(input.spawnSyncImpl ? { spawnSyncImpl: input.spawnSyncImpl } : {})
    });
  const diagnosis = diagnoseCodexHost(availability, {
    ...(input.env ? { env: input.env } : {}),
    ...(input.platform ? { platform: input.platform } : {})
  });

  if (!availability.available) {
    return {
      ok: false,
      summary: availability.detail,
      availability,
      diagnosis,
      command: availability.command,
      args: []
    };
  }

  if (!isInsideGitRepository(input.workingDirectory)) {
    return {
      ok: false,
      summary: "Working directory is not inside a git repository. Codex exec requires a trusted repository for governed work.",
      availability,
      diagnosis,
      command: availability.resolvedPath ?? availability.command,
      args: []
    };
  }

  const spawnSyncImpl = input.spawnSyncImpl ?? spawnSync;
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const probeCandidates = buildProbeCandidates({
    availability,
    env,
    platform,
    includeDesktopCandidates: input.spawnSyncImpl === undefined
  });
  const candidatePaths = probeCandidates.map((candidate) => candidate.path);
  const cacheKey = buildProbeCacheKey({
    workingDirectory: input.workingDirectory,
    platform,
    candidatePaths,
    ...(input.model ? { model: input.model } : {})
  });

  if (input.spawnSyncImpl === undefined) {
    const cached = codexLaunchProbeCache.get(cacheKey);
    if (cached) return cached;
  }

  const candidateResults: Array<{
    path: string;
    diagnosis: CodexHostDiagnosis;
    profile?: CodexCapabilityProfile;
    args: string[];
    ok: boolean;
    summary: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  }> = [];

  for (const candidate of probeCandidates) {
    if (!candidate.diagnosis.nativeInstallValid) {
      candidateResults.push({
        path: candidate.path,
        diagnosis: candidate.diagnosis,
        args: [],
        ok: false,
        summary: candidate.diagnosis.remediation ?? "Codex host installation is not valid for this environment."
      });
      continue;
    }

    const profile = probeCodexCapabilities(candidate.path, {
      platform,
      spawnSyncImpl,
      cache: input.spawnSyncImpl === undefined
    });
    if (!profile.supportsExec) {
      candidateResults.push({
        path: candidate.path,
        diagnosis: candidate.diagnosis,
        profile,
        args: [],
        ok: false,
        summary: "Resolved Codex binary does not advertise a usable exec subcommand."
      });
      continue;
    }

    const markerName = `.martin-codex-write-probe-${String(process.pid)}-${String(Date.now())}.tmp`;
    const markerPath = join(input.workingDirectory, markerName);
    const prompt = buildWriteProbePrompt(markerName);
    let args: string[];
    try {
      args = buildCodexExecArgs({
        command: candidate.path,
        workingDirectory: input.workingDirectory,
        sandbox: "workspace-write",
        ...(input.model ? { model: input.model } : {}),
        mode: "probe",
        prompt,
        capabilityProfile: profile
      });
    } catch (error) {
      candidateResults.push({
        path: candidate.path,
        diagnosis: candidate.diagnosis,
        profile,
        args: [],
        ok: false,
        summary: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    const spawnPlan = buildProbeCommand(candidate.path, args, platform);
    const result = spawnSyncImpl(spawnPlan.command, spawnPlan.args, {
      cwd: input.workingDirectory,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      ...(buildCodexStdin(profile, prompt) !== undefined ? { input: buildCodexStdin(profile, prompt) } : {})
    });
    const probedDiagnosis: CodexHostDiagnosis = {
      ...candidate.diagnosis,
      invocationMode: spawnPlan.invocationMode
    };

    let markerVerified = false;
    try {
      markerVerified = existsSync(markerPath) && readFileSync(markerPath, "utf8") === "MARTIN_CODEX_WRITE_OK";
    } catch {
      markerVerified = false;
    } finally {
      try {
        unlinkSync(markerPath);
      } catch {
        // best effort cleanup
      }
    }

    const classified = classifyProbeFailure(result.stderr ?? "", result.stdout ?? "", probedDiagnosis);
    if (result.error || result.status !== 0 || !markerVerified) {
      candidateResults.push({
        path: candidate.path,
        diagnosis: classified.diagnosis ?? probedDiagnosis,
        profile,
        args,
        ok: false,
        summary:
          classified.summary ??
          (result.error
            ? `Codex launch probe failed: ${result.error.message}`
            : result.status !== 0
              ? `Codex launch probe exited non-zero: ${(result.stderr ?? result.stdout ?? "").trim() || String(result.status)}`
              : "Codex launch probe did not prove writable shell execution."),
        ...(result.status === null ? {} : { exitCode: result.status }),
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? ""
      });
      continue;
    }

    candidateResults.push({
      path: candidate.path,
      diagnosis: probedDiagnosis,
      profile,
      args,
      ok: true,
      summary: "Codex capability-driven prompt, shell, and workspace-write probe passed.",
      ...(result.status === null ? {} : { exitCode: result.status }),
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? ""
    });
    break;
  }

  const selectedCandidate = candidateResults.find((candidate) => candidate.ok);
  const candidateProbeResults: CodexProbeCandidateResult[] = candidateResults.map((candidate) => ({
    path: candidate.path,
    installKind: candidate.diagnosis.installKind,
    invocationMode: candidate.diagnosis.invocationMode,
    nativeInstallValid: candidate.diagnosis.nativeInstallValid,
    sandboxCompatible: candidate.diagnosis.sandboxCompatible,
    launchReady: candidate.ok,
    summary: candidate.summary,
    ...(candidate.diagnosis.remediation ? { remediation: candidate.diagnosis.remediation } : {}),
    ...(candidate.diagnosis.nativeDependencyStatus ? { nativeDependencyStatus: candidate.diagnosis.nativeDependencyStatus } : {}),
    ...(candidate.diagnosis.nativeDependencyPackage ? { nativeDependencyPackage: candidate.diagnosis.nativeDependencyPackage } : {}),
    ...(candidate.profile ? { capabilityProfile: candidate.profile } : {})
  }));

  if (selectedCandidate) {
    const success: CodexLaunchProbeResult = {
      ok: true,
      summary: selectedCandidate.summary,
      availability: {
        ...availability,
        resolvedPath: selectedCandidate.path,
        candidatePaths
      },
      diagnosis: { ...selectedCandidate.diagnosis, resolvedPath: selectedCandidate.path },
      command: selectedCandidate.path,
      args: selectedCandidate.args,
      ...(selectedCandidate.profile ? { capabilityProfile: selectedCandidate.profile } : {}),
      ...(selectedCandidate.exitCode === undefined ? {} : { exitCode: selectedCandidate.exitCode }),
      stdout: selectedCandidate.stdout,
      stderr: selectedCandidate.stderr,
      candidateProbeResults
    };
    if (input.spawnSyncImpl === undefined) codexLaunchProbeCache.set(cacheKey, success);
    return success;
  }

  const bestFailure =
    platform === "win32"
      ? candidateResults.find((candidate) => candidate.diagnosis.nativeInstallValid && candidate.diagnosis.installKind === "native") ??
        candidateResults.find((candidate) => candidate.diagnosis.nativeInstallValid) ??
        candidateResults[0]
      : candidateResults[0];

  const failure: CodexLaunchProbeResult = {
    ok: false,
    summary: bestFailure?.summary ?? diagnosis.remediation ?? "Codex launch probe failed.",
    availability: {
      ...availability,
      ...(bestFailure ? { resolvedPath: bestFailure.path } : {}),
      ...(candidatePaths.length > 0 ? { candidatePaths } : {})
    },
    diagnosis: bestFailure ? { ...bestFailure.diagnosis, resolvedPath: bestFailure.path } : diagnosis,
    command: bestFailure?.path ?? availability.resolvedPath ?? availability.command,
    args: bestFailure?.args ?? [],
    ...(bestFailure?.profile ? { capabilityProfile: bestFailure.profile } : {}),
    ...(bestFailure?.exitCode === undefined ? {} : { exitCode: bestFailure.exitCode }),
    stdout: bestFailure?.stdout,
    stderr: bestFailure?.stderr,
    candidateProbeResults
  };
  if (input.spawnSyncImpl === undefined) codexLaunchProbeCache.set(cacheKey, failure);
  return failure;
}
