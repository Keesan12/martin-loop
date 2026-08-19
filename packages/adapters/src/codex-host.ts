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

import { createSpawnPlan, resolveNpmShimScript } from "./cli-bridge.js";
import {
  buildCodexExecArgs,
  buildCodexStdin,
  cacheCodexCapabilityProfile,
  codexWriteStrategies,
  probeCodexCapabilities,
  type CodexCapabilityProfile,
  type CodexPromptTransport,
  type CodexWriteStrategy
} from "./codex-capabilities.js";

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
  writeStrategy?: CodexWriteStrategy;
  promptTransport?: CodexPromptTransport;
}

export interface CodexLaunchProbeResult {
  ok: boolean;
  summary: string;
  availability: CliCommandAvailability;
  diagnosis: CodexHostDiagnosis;
  command: string;
  args: string[];
  capabilityProfile?: CodexCapabilityProfile;
  writeStrategy?: CodexWriteStrategy;
  promptTransport?: CodexPromptTransport;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  candidateProbeResults?: CodexProbeCandidateResult[];
}

type SpawnSyncLike = typeof spawnSync;
const launchProbeCache = new Map<string, CodexLaunchProbeResult>();

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
    return { writable: false, reason: error instanceof Error ? error.message : String(error) };
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
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) return [];
  const base = join(localAppData, "OpenAI", "Codex", "bin");
  if (!existsSync(base)) return [];

  const found: Array<{ path: string; mtimeMs: number }> = [];
  const direct = join(base, "codex.exe");
  if (existsSync(direct)) found.push({ path: direct, mtimeMs: statSync(direct).mtimeMs });
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(base, entry.name, "codex.exe");
    if (existsSync(candidate)) found.push({ path: candidate, mtimeMs: statSync(candidate).mtimeMs });
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return normalizeCandidates(found.map((item) => item.path));
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
    return {
      command,
      available: true,
      locator: discovery.locator,
      detail: `${command} is available on PATH.`,
      resolvedPath: discovery.candidates[0],
      candidatePaths: discovery.candidates
    };
  }

  const offPath = discoverCommandOffPath(command, platform, env);
  if (offPath) {
    return {
      command,
      available: true,
      locator: "off-path-discovery",
      detail: `${command} found at ${offPath} (not on PATH, auto-discovered).`,
      resolvedPath: offPath,
      candidatePaths: [offPath]
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

  const extensions = platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((item) => item.trim().toLowerCase()).filter(Boolean)
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
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return "wsl";
  return "linux";
}

function detectInstallKind(path: string | undefined, host: CodexHostPlatform): CodexInstallKind {
  if (!path) return "missing";
  const normalized = path.replace(/\\/gu, "/").toLowerCase();
  if ((host === "linux" || host === "wsl") && normalized.startsWith("/mnt/c/")) return "windows_mounted_path";
  if (/\.(cmd|bat|ps1)$/iu.test(normalized) || normalized.includes("/appdata/roaming/npm/")) return "windows_shim";
  return "native";
}

function detectInvocationMode(path: string | undefined, platform: NodeJS.Platform): CodexInvocationMode {
  if (platform !== "win32" || !path) return "direct";
  const extension = extname(path).toLowerCase();
  if (extension === ".ps1") return "powershell";
  if (extension === ".cmd" || extension === ".bat") return "cmd_shell";
  return "direct";
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

  if (!availability.available) {
    return {
      hostPlatform,
      nativeInstallValid: false,
      installKind,
      invocationMode,
      sandboxMode: "workspace-write",
      sandboxCompatible: false,
      warnings: [],
      remediation: "Install or expose the Codex CLI on PATH before running governed Codex work."
    };
  }

  if ((hostPlatform === "linux" || hostPlatform === "wsl") && installKind === "windows_mounted_path") {
    return {
      hostPlatform,
      nativeInstallValid: false,
      installKind,
      invocationMode,
      sandboxMode: "workspace-write",
      sandboxCompatible: false,
      resolvedPath,
      warnings: ["Codex resolves to a Windows-hosted install from Linux/WSL."],
      remediation: "Install Codex natively inside this Linux/WSL environment before governed work."
    };
  }

  return {
    hostPlatform,
    nativeInstallValid: true,
    installKind,
    invocationMode,
    sandboxMode: "workspace-write",
    sandboxCompatible: true,
    resolvedPath,
    ...(hostPlatform === "linux" || hostPlatform === "wsl" ? { nativeDependencyStatus: "unknown" as const } : {}),
    warnings: []
  };
}

interface OrderedCandidate {
  path: string;
  diagnosis: CodexHostDiagnosis;
  preference: number;
  discoveryIndex: number;
}

function candidatePreference(path: string, diagnosis: CodexHostDiagnosis, platform: NodeJS.Platform): number {
  const base = diagnosis.installKind === "native" ? 0 : diagnosis.installKind === "windows_shim" ? 20 : 30;
  if (platform !== "win32" || diagnosis.installKind !== "windows_shim") return base;
  return base + (/\.(cmd|bat|ps1)$/iu.test(path) ? 0 : 1);
}

function buildCandidates(input: {
  availability: CliCommandAvailability;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  includeDesktopCandidates: boolean;
}): OrderedCandidate[] {
  const pathCandidates = normalizeCandidates(
    input.availability.candidatePaths ?? [input.availability.resolvedPath ?? input.availability.command]
  );
  const desktop = input.platform === "win32" && input.includeDesktopCandidates
    ? discoverWindowsDesktopCodexCandidates(input.env).filter((path) => !pathCandidates.includes(path))
    : [];
  return [...pathCandidates, ...desktop]
    .map((path, discoveryIndex) => {
      const diagnosis = diagnoseCodexHost(
        { ...input.availability, resolvedPath: path },
        { env: input.env, platform: input.platform }
      );
      return {
        path,
        diagnosis,
        preference: candidatePreference(path, diagnosis, input.platform),
        discoveryIndex
      };
    })
    .sort((a, b) => a.preference === b.preference ? a.discoveryIndex - b.discoveryIndex : a.preference - b.preference);
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

function buildInjectedSpawnPlan(
  binaryPath: string,
  args: string[],
  platform: NodeJS.Platform
): { command: string; args: string[]; invocationMode: CodexInvocationMode } {
  if (platform !== "win32") return { command: binaryPath, args, invocationMode: "direct" };
  const extension = extname(binaryPath).toLowerCase();
  if (extension === ".cmd" || extension === ".bat" || extension === ".ps1") {
    const script = resolveNpmShimScript(binaryPath);
    if (script) return { command: process.execPath, args: [script, ...args], invocationMode: "direct" };
    if (extension === ".ps1") {
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", binaryPath, ...args],
        invocationMode: "powershell"
      };
    }
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/c", binaryPath, ...args],
      invocationMode: "cmd_shell"
    };
  }
  return { command: binaryPath, args, invocationMode: "direct" };
}

function buildMarkerPrompt(marker: string): string {
  const command = `node -e "require('node:fs').writeFileSync(process.argv[1],'MARTIN_CODEX_WRITE_OK')" ${marker}`;
  return [
    "You are validating MartinLoop Codex host readiness.",
    "Do not modify tracked files.",
    "Use the shell command executor exactly once.",
    `Run exactly: ${command}`,
    "Do not use MCP tools or alternate tools.",
    "After it succeeds, reply READY."
  ].join("\n");
}

function classifyFailure(stderr: string, stdout: string, diagnosis: CodexHostDiagnosis): CodexHostDiagnosis {
  const combined = `${stderr}\n${stdout}`;
  if (/@openai\/codex-linux-x64|cannot find module ['"]@openai\/codex-linux-x64['"]/iu.test(combined)) {
    return {
      ...diagnosis,
      nativeInstallValid: false,
      sandboxCompatible: false,
      nativeDependencyStatus: "missing",
      nativeDependencyPackage: "@openai/codex-linux-x64",
      warnings: [...diagnosis.warnings, "Codex native Linux package is missing."],
      remediation: "Reinstall Codex natively in this Linux/WSL environment."
    };
  }
  if (/CreateProcessAsUserW failed:\s*5|windows sandbox: runner error/iu.test(combined)) {
    return {
      ...diagnosis,
      sandboxCompatible: false,
      warnings: [...diagnosis.warnings, "This Codex invocation could not create a writable subprocess on Windows."],
      remediation: "Use another capability strategy advertised by this exact Codex binary, or repair the host sandbox."
    };
  }
  return diagnosis;
}

function probeCacheKey(input: {
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

export function probeCodexLaunch(input: {
  workingDirectory: string;
  availability?: CliCommandAvailability;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawnSyncImpl?: SpawnSyncLike;
  model?: string;
}): CodexLaunchProbeResult {
  const availability = input.availability ?? resolveCliCommandAvailability("codex", {
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.env ? { env: input.env } : {}),
    ...(input.spawnSyncImpl ? { spawnSyncImpl: input.spawnSyncImpl } : {})
  });
  const diagnosis = diagnoseCodexHost(availability, {
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.env ? { env: input.env } : {})
  });

  if (!availability.available) {
    return { ok: false, summary: availability.detail, availability, diagnosis, command: availability.command, args: [] };
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

  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const spawnSyncImpl = input.spawnSyncImpl ?? spawnSync;
  const candidates = buildCandidates({
    availability,
    env,
    platform,
    includeDesktopCandidates: input.spawnSyncImpl === undefined
  });
  const candidatePaths = candidates.map((candidate) => candidate.path);
  const key = probeCacheKey({
    workingDirectory: input.workingDirectory,
    platform,
    candidatePaths,
    ...(input.model ? { model: input.model } : {})
  });
  if (input.spawnSyncImpl === undefined) {
    const cached = launchProbeCache.get(key);
    if (cached) return cached;
  }

  const candidateResults: CodexProbeCandidateResult[] = [];
  let selected:
    | {
        candidate: OrderedCandidate;
        profile: CodexCapabilityProfile;
        args: string[];
        strategy: CodexWriteStrategy;
        transport: CodexPromptTransport;
        exitCode?: number;
        stdout?: string;
        stderr?: string;
      }
    | undefined;
  let lastFailure:
    | {
        candidate: OrderedCandidate;
        profile?: CodexCapabilityProfile;
        args: string[];
        summary: string;
        exitCode?: number;
        stdout?: string;
        stderr?: string;
      }
    | undefined;

  candidateLoop: for (const candidate of candidates) {
    if (!candidate.diagnosis.nativeInstallValid) {
      candidateResults.push({
        path: candidate.path,
        installKind: candidate.diagnosis.installKind,
        invocationMode: candidate.diagnosis.invocationMode,
        nativeInstallValid: false,
        sandboxCompatible: false,
        launchReady: false,
        summary: candidate.diagnosis.remediation ?? "Codex installation is not valid for this host."
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
        installKind: candidate.diagnosis.installKind,
        invocationMode: candidate.diagnosis.invocationMode,
        nativeInstallValid: true,
        sandboxCompatible: false,
        launchReady: false,
        summary: "Resolved Codex binary does not advertise a usable exec subcommand.",
        capabilityProfile: profile
      });
      continue;
    }

    const transports = profile.promptTransports?.length ? profile.promptTransports : [profile.promptTransport];
    const strategies = codexWriteStrategies(profile);
    let candidateSummary = "No advertised Codex invocation strategy proved writable execution.";

    for (const strategy of strategies) {
      for (const transport of transports) {
        const marker = `.martin-codex-write-probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
        const markerPath = join(input.workingDirectory, marker);
        const prompt = buildMarkerPrompt(marker);
        let args: string[];
        try {
          args = buildCodexExecArgs({
            command: candidate.path,
            workingDirectory: input.workingDirectory,
            sandbox: "workspace-write",
            ...(input.model ? { model: input.model } : {}),
            mode: "probe",
            prompt,
            capabilityProfile: profile,
            promptTransport: transport,
            writeStrategy: strategy
          });
        } catch (error) {
          candidateSummary = error instanceof Error ? error.message : String(error);
          lastFailure = { candidate, profile, args: [], summary: candidateSummary };
          continue;
        }

        const plan = input.spawnSyncImpl
          ? buildInjectedSpawnPlan(candidate.path, args, platform)
          : { ...createSpawnPlan(candidate.path, args, input.workingDirectory, false), invocationMode: "direct" as const };
        const stdin = buildCodexStdin(profile, prompt, transport);
        const result = spawnSyncImpl(plan.command, plan.args, {
          cwd: input.workingDirectory,
          encoding: "utf8",
          stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
          ...(stdin !== undefined ? { input: stdin } : {})
        });

        let markerVerified = false;
        try {
          markerVerified = existsSync(markerPath) && readFileSync(markerPath, "utf8") === "MARTIN_CODEX_WRITE_OK";
        } finally {
          try {
            unlinkSync(markerPath);
          } catch {
            // best effort cleanup
          }
        }

        if (!result.error && result.status === 0 && markerVerified) {
          const negotiated = cacheCodexCapabilityProfile(
            { ...profile, selectedWriteStrategy: strategy, promptTransport: transport },
            platform
          );
          selected = {
            candidate: {
              ...candidate,
              diagnosis: { ...candidate.diagnosis, invocationMode: plan.invocationMode }
            },
            profile: negotiated,
            args,
            strategy,
            transport,
            ...(result.status === null ? {} : { exitCode: result.status }),
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? ""
          };
          candidateResults.push({
            path: candidate.path,
            installKind: candidate.diagnosis.installKind,
            invocationMode: plan.invocationMode,
            nativeInstallValid: true,
            sandboxCompatible: true,
            launchReady: true,
            summary: `Codex capability negotiation passed with ${strategy} / ${transport}.`,
            capabilityProfile: negotiated,
            writeStrategy: strategy,
            promptTransport: transport
          });
          break candidateLoop;
        }

        const failureDiagnosis = classifyFailure(result.stderr ?? "", result.stdout ?? "", candidate.diagnosis);
        candidateSummary = result.error
          ? `Codex launch probe failed: ${result.error.message}`
          : result.status !== 0
            ? `Codex launch probe exited non-zero: ${(result.stderr ?? result.stdout ?? "").trim() || String(result.status)}`
            : `Codex ${strategy} / ${transport} invocation did not prove workspace writes.`;
        lastFailure = {
          candidate: { ...candidate, diagnosis: failureDiagnosis },
          profile,
          args,
          summary: candidateSummary,
          ...(result.status === null ? {} : { exitCode: result.status }),
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? ""
        };
      }
    }

    candidateResults.push({
      path: candidate.path,
      installKind: candidate.diagnosis.installKind,
      invocationMode: candidate.diagnosis.invocationMode,
      nativeInstallValid: candidate.diagnosis.nativeInstallValid,
      sandboxCompatible: false,
      launchReady: false,
      summary: candidateSummary,
      capabilityProfile: profile,
      ...(candidate.diagnosis.remediation ? { remediation: candidate.diagnosis.remediation } : {})
    });
  }

  if (selected) {
    const result: CodexLaunchProbeResult = {
      ok: true,
      summary: `Codex capability-driven workspace-write probe passed using ${selected.strategy} / ${selected.transport}.`,
      availability: { ...availability, resolvedPath: selected.candidate.path, candidatePaths },
      diagnosis: { ...selected.candidate.diagnosis, resolvedPath: selected.candidate.path },
      command: selected.candidate.path,
      args: selected.args,
      capabilityProfile: selected.profile,
      writeStrategy: selected.strategy,
      promptTransport: selected.transport,
      ...(selected.exitCode === undefined ? {} : { exitCode: selected.exitCode }),
      ...(selected.stdout === undefined ? {} : { stdout: selected.stdout }),
      ...(selected.stderr === undefined ? {} : { stderr: selected.stderr }),
      candidateProbeResults: candidateResults
    };
    if (input.spawnSyncImpl === undefined) launchProbeCache.set(key, result);
    return result;
  }

  const failed = lastFailure;
  const result: CodexLaunchProbeResult = {
    ok: false,
    summary: failed?.summary ?? diagnosis.remediation ?? "No Codex candidate proved governed writable execution.",
    availability: {
      ...availability,
      ...(failed ? { resolvedPath: failed.candidate.path } : {}),
      ...(candidatePaths.length ? { candidatePaths } : {})
    },
    diagnosis: failed
      ? { ...failed.candidate.diagnosis, resolvedPath: failed.candidate.path }
      : diagnosis,
    command: failed?.candidate.path ?? availability.resolvedPath ?? availability.command,
    args: failed?.args ?? [],
    ...(failed?.profile ? { capabilityProfile: failed.profile } : {}),
    ...(failed?.exitCode === undefined ? {} : { exitCode: failed.exitCode }),
    ...(failed?.stdout === undefined ? {} : { stdout: failed.stdout }),
    ...(failed?.stderr === undefined ? {} : { stderr: failed.stderr }),
    candidateProbeResults: candidateResults
  };
  if (input.spawnSyncImpl === undefined) launchProbeCache.set(key, result);
  return result;
}
