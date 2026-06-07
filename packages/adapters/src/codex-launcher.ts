import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

export interface CliCommandAvailability {
  command: string;
  available: boolean;
  locator: string;
  detail: string;
  resolvedPath?: string;
  candidatePaths?: string[];
}

export type CodexHostPlatform = "windows" | "linux" | "wsl" | "macos";

export type CodexInstallKind =
  | "missing"
  | "native"
  | "windows_shim"
  | "windows_mounted_path";

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

export interface CodexLaunchProbeResult {
  ok: boolean;
  summary: string;
  availability: CliCommandAvailability;
  diagnosis: CodexHostDiagnosis;
  command: string;
  args: string[];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  candidateProbeResults?: CodexProbeCandidateResult[];
}

export interface CodexExecArgsOptions {
  workingDirectory: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  model?: string;
  extraArgs?: string[];
  mode?: "prompt" | "probe";
}

type SpawnSyncLike = typeof spawnSync;
const codexLaunchProbeCache = new Map<string, CodexLaunchProbeResult>();

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
}

interface CodexProbeJsonEvent {
  type?: string;
  item?: {
    type?: string;
    status?: string;
    exit_code?: number | null;
    aggregated_output?: string;
  };
}

interface OrderedProbeCandidate {
  path: string;
  diagnosis: CodexHostDiagnosis;
  preference: number;
  discoveryIndex: number;
}

const CODEX_LAUNCH_PROBE_PROMPT = [
  "You are validating MartinLoop Codex host readiness.",
  "Do not edit files.",
  "Use the shell command executor exactly once to run: git status --short -- .",
  "Do not use MCP tools, Node REPL, or any fallback tool if shell execution fails.",
  "If the shell command succeeds, reply with READY only.",
  "If it fails, reply with the exact failure in one sentence."
].join("\n");

function buildProbeCacheKey(input: {
  workingDirectory: string;
  platform: NodeJS.Platform;
  candidatePaths: string[];
}): string {
  return JSON.stringify({
    workingDirectory: resolve(input.workingDirectory),
    platform: input.platform,
    candidatePaths: input.candidatePaths
  });
}

function isInsideGitRepository(workingDirectory: string): boolean {
  let current = resolve(workingDirectory);

  while (true) {
    if (existsSync(resolve(current, ".git"))) {
      return true;
    }

    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

function normalizeCandidates(lines: string[]): string[] {
  return [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
}

function readLocatorCandidates(
  command: string,
  platform: NodeJS.Platform,
  spawnSyncImpl: SpawnSyncLike
): { locator: string; candidates: string[]; foundOnPath: boolean } {
  const locator = platform === "win32" ? "where.exe" : "which";
  const result = spawnSyncImpl(locator, [command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  return {
    locator,
    candidates:
      result.status === 0
        ? normalizeCandidates((result.stdout ?? "").split(/\r?\n/u))
        : [],
    foundOnPath: result.status === 0
  };
}

function discoverWindowsDesktopCodexCandidates(env: NodeJS.ProcessEnv): string[] {
  const localAppData = env["LOCALAPPDATA"];
  if (!localAppData) {
    return [];
  }

  const baseDirectory = join(localAppData, "OpenAI", "Codex", "bin");
  if (!existsSync(baseDirectory)) {
    return [];
  }

  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  const directCandidate = join(baseDirectory, "codex.exe");
  if (existsSync(directCandidate)) {
    candidates.push({ path: directCandidate, mtimeMs: statSync(directCandidate).mtimeMs });
  }

  for (const entry of readdirSync(baseDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = join(baseDirectory, entry.name, "codex.exe");
    if (!existsSync(candidate)) {
      continue;
    }
    candidates.push({ path: candidate, mtimeMs: statSync(candidate).mtimeMs });
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return normalizeCandidates(candidates.map((candidate) => candidate.path));
}

function codexProbePreference(diagnosis: CodexHostDiagnosis): number {
  if (diagnosis.installKind === "native" && diagnosis.invocationMode === "direct") {
    return 0;
  }
  if (diagnosis.installKind === "native") {
    return 1;
  }
  if (diagnosis.installKind === "windows_shim") {
    return 2;
  }
  return 3;
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
      ? discoverWindowsDesktopCodexCandidates(input.env).filter(
          (candidatePath) => !pathCandidates.includes(candidatePath)
        )
      : [];

  return [...pathCandidates, ...desktopCandidates]
    .map((path, discoveryIndex) => {
      const diagnosis = diagnoseCodexHost(
        {
          ...input.availability,
          resolvedPath: path
        },
        {
          env: input.env,
          platform: input.platform
        }
      );

      return {
        path,
        diagnosis,
        preference: input.platform === "win32" ? codexProbePreference(diagnosis) : 0,
        discoveryIndex
      };
    })
    .sort((left, right) =>
      left.preference === right.preference
        ? left.discoveryIndex - right.discoveryIndex
        : left.preference - right.preference
    );
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
  switch (extension) {
    case ".cmd":
    case ".bat":
      return {
        command: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/c", command, ...args],
        invocationMode: "cmd_shell"
      };
    case ".ps1":
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", command, ...args],
        invocationMode: "powershell"
      };
    default:
      return { command, args, invocationMode: "direct" };
  }
}

function detectInstallKind(
  resolvedPath: string | undefined,
  hostPlatform: CodexHostPlatform
): CodexInstallKind {
  if (!resolvedPath) {
    return "missing";
  }

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

  if (looksWindowsShim) {
    return "windows_shim";
  }

  return "native";
}

function detectInvocationMode(resolvedPath: string | undefined, platform: NodeJS.Platform): CodexInvocationMode {
  if (platform !== "win32" || !resolvedPath) {
    return "direct";
  }

  const extension = extname(resolvedPath).toLowerCase();
  if (extension === ".ps1") {
    return "powershell";
  }
  if (extension === ".cmd" || extension === ".bat") {
    return "cmd_shell";
  }
  return "direct";
}

function classifyProbeFailure(
  stderr: string,
  stdout: string,
  diagnosis: CodexHostDiagnosis
): { summary?: string; diagnosis?: CodexHostDiagnosis } {
  const combined = `${stderr}\n${stdout}`;

  if (
    /@openai\/codex-linux-x64/iu.test(combined) ||
    /cannot find module ['"]@openai\/codex-linux-x64['"]/iu.test(combined)
  ) {
    const warnings = [...diagnosis.warnings];
    const missingDependencyWarning =
      "Codex is missing the native Linux package '@openai/codex-linux-x64' required for this host.";
    if (!warnings.includes(missingDependencyWarning)) {
      warnings.push(missingDependencyWarning);
    }
    return {
      summary:
        "Codex native dependency '@openai/codex-linux-x64' is missing for this Linux/WSL environment.",
      diagnosis: {
        ...diagnosis,
        nativeInstallValid: false,
        sandboxCompatible: false,
        warnings,
        nativeDependencyStatus: "missing",
        nativeDependencyPackage: "@openai/codex-linux-x64",
        remediation:
          "Reinstall Codex natively inside this Linux/WSL environment so the '@openai/codex-linux-x64' package is present before running governed Codex work."
      }
    };
  }

  if (
    /CreateProcessAsUserW failed:\s*5/iu.test(combined) ||
    /windows sandbox: runner error: CreateProcessAsUserW failed:\s*5/iu.test(combined) ||
    /spawn setup refresh/iu.test(combined)
  ) {
    const warnings = [...diagnosis.warnings];
    const sandboxFailureWarning =
      "Codex workspace-write sandbox could not launch subprocesses on this Windows host.";
    if (!warnings.includes(sandboxFailureWarning)) {
      warnings.push(sandboxFailureWarning);
    }
    return {
      summary:
        "Codex workspace-write sandbox could not launch subprocesses on this Windows host.",
      diagnosis: {
        ...diagnosis,
        sandboxCompatible: false,
        warnings,
        remediation:
          "Update or reinstall Codex on this Windows host until `codex exec --sandbox workspace-write` can launch a simple shell command before running governed Codex work."
      }
    };
  }

  return {};
}

export function buildCodexExecArgs(options: CodexExecArgsOptions): string[] {
  const sandbox = options.sandbox ?? "workspace-write";
  const modelArgs = options.model ? ["--model", options.model] : [];
  const extraArgs = options.extraArgs ?? [];

  return [
    "exec",
    "--cd",
    options.workingDirectory,
    "--sandbox",
    sandbox,
    "--json",
    "--color",
    "never",
    ...modelArgs,
    ...extraArgs,
    "-"
  ];
}

function parseCodexProbeEvents(stdout: string): CodexProbeJsonEvent[] {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as CodexProbeJsonEvent;
      } catch {
        return undefined;
      }
    })
    .filter((event): event is CodexProbeJsonEvent => event !== undefined);
}

function hasSuccessfulCommandExecution(events: CodexProbeJsonEvent[]): boolean {
  return events.some(
    (event) =>
      event.type === "item.completed" &&
      event.item?.type === "command_execution" &&
      event.item?.status === "completed" &&
      event.item?.exit_code === 0
  );
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
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const discovery = readLocatorCandidates(command, platform, spawnSyncImpl);
  const resolvedPath = discovery.candidates[0];

  return discovery.candidates.length > 0
    ? {
        command,
        available: true,
        locator: discovery.locator,
        detail: `${command} is available on PATH.`,
        ...(resolvedPath ? { resolvedPath } : {}),
        candidatePaths: discovery.candidates
      }
    : {
        command,
        available: false,
        locator: discovery.locator,
        detail: `${command} is not available on PATH.`
      };
}

export function detectCodexHostPlatform(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): CodexHostPlatform {
  if (platform === "win32") {
    return "windows";
  }

  if (platform === "darwin") {
    return "macos";
  }

  if (env["WSL_DISTRO_NAME"] || env["WSL_INTEROP"]) {
    return "wsl";
  }

  return "linux";
}

export function diagnoseCodexHost(
  availability: CliCommandAvailability,
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  } = {}
): CodexHostDiagnosis {
  const hostPlatform = detectCodexHostPlatform(
    options.env ?? process.env,
    options.platform ?? process.platform
  );
  const resolvedPath = availability.resolvedPath;
  const installKind = detectInstallKind(resolvedPath, hostPlatform);
  const invocationMode = detectInvocationMode(resolvedPath, options.platform ?? process.platform);
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
    warnings.push(
      "Codex resolves to a Windows-hosted install from a Linux/WSL environment."
    );
    return {
      hostPlatform,
      nativeInstallValid: false,
      installKind,
      invocationMode,
      sandboxMode: "workspace-write",
      sandboxCompatible: false,
      ...(resolvedPath ? { resolvedPath } : {}),
      warnings,
      remediation:
        "Install Codex natively inside this Linux/WSL environment instead of relying on a Windows PATH shim."
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

export function probeCodexLaunch(
  input: {
    workingDirectory: string;
    availability?: CliCommandAvailability;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    spawnSyncImpl?: SpawnSyncLike;
  }
): CodexLaunchProbeResult {
  const availability =
    input.availability ??
    resolveCliCommandAvailability("codex", {
      platform: input.platform,
      spawnSyncImpl: input.spawnSyncImpl
    });
  const diagnosis = diagnoseCodexHost(availability, {
    env: input.env,
    platform: input.platform
  });
  const args = buildCodexExecArgs({
    workingDirectory: input.workingDirectory,
    mode: "probe"
  });

  if (!availability.available) {
    return {
      ok: false,
      summary: availability.detail,
      availability,
      diagnosis,
      command: availability.command,
      args
    };
  }

  if (!isInsideGitRepository(input.workingDirectory)) {
    return {
      ok: false,
      summary:
        "Working directory is not inside a git repository. Codex exec requires a trusted repo unless --skip-git-repo-check is explicitly enabled.",
      availability,
      diagnosis,
      command: availability.resolvedPath ?? availability.command,
      args
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
    candidatePaths
  });
  if (input.spawnSyncImpl === undefined) {
    const cached = codexLaunchProbeCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }
  const candidateResults: Array<{
    path: string;
    diagnosis: CodexHostDiagnosis;
    ok: boolean;
    summary: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  }> = [];

  const probeCandidatePath = (candidate: OrderedProbeCandidate): boolean => {
    const candidateDiagnosis = candidate.diagnosis;

    if (!candidateDiagnosis.nativeInstallValid) {
      candidateResults.push({
        path: candidate.path,
        diagnosis: candidateDiagnosis,
        ok: false,
        summary:
          candidateDiagnosis.remediation ?? "Codex host installation is not valid for this environment."
      });
      return false;
    }

    const spawnPlan = buildProbeCommand(candidate.path, args, platform);
    const result = spawnSyncImpl(spawnPlan.command, spawnPlan.args, {
      cwd: input.workingDirectory,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      input: CODEX_LAUNCH_PROBE_PROMPT
    });
    const probedDiagnosis = {
      ...candidateDiagnosis,
      invocationMode: spawnPlan.invocationMode
    };

    if (result.error) {
      const classifiedFailure = classifyProbeFailure(result.stderr ?? "", result.stdout ?? "", probedDiagnosis);
      candidateResults.push({
        path: candidate.path,
        diagnosis: classifiedFailure.diagnosis ?? probedDiagnosis,
        ok: false,
        summary: classifiedFailure.summary ?? `Codex launch probe failed: ${result.error.message}`,
        stderr: result.stderr ?? "",
        stdout: result.stdout ?? ""
      });
      return false;
    }

    if (result.status !== 0) {
      const stderr = (result.stderr ?? "").trim();
      const classifiedFailure = classifyProbeFailure(result.stderr ?? "", result.stdout ?? "", probedDiagnosis);
      candidateResults.push({
        path: candidate.path,
        diagnosis: classifiedFailure.diagnosis ?? probedDiagnosis,
        ok: false,
        summary:
          classifiedFailure.summary ??
          (stderr.length > 0 ? `Codex launch probe failed: ${stderr}` : "Codex launch probe exited non-zero."),
        exitCode: result.status ?? undefined,
        stderr: result.stderr ?? "",
        stdout: result.stdout ?? ""
      });
      return false;
    }

    const events = parseCodexProbeEvents(result.stdout ?? "");
    if (!hasSuccessfulCommandExecution(events)) {
      const classifiedFailure = classifyProbeFailure(result.stderr ?? "", result.stdout ?? "", probedDiagnosis);
      candidateResults.push({
        path: candidate.path,
        diagnosis: classifiedFailure.diagnosis ?? probedDiagnosis,
        ok: false,
        summary:
          classifiedFailure.summary ?? "Codex launch probe did not complete a shell command successfully.",
        exitCode: result.status ?? undefined,
        stderr: result.stderr ?? "",
        stdout: result.stdout ?? ""
      });
      return false;
    }

    candidateResults.push({
      path: candidate.path,
      diagnosis: probedDiagnosis,
      ok: true,
      summary: "Codex exec prompt-and-shell probe passed for the current MartinLoop invocation shape.",
      exitCode: result.status ?? undefined,
      stderr: result.stderr ?? "",
      stdout: result.stdout ?? ""
    });
    return true;
  };

  for (const candidate of probeCandidates) {
    if (probeCandidatePath(candidate)) {
      break;
    }
  }

  const successfulCandidates = candidateResults.filter((candidate) => candidate.ok);
  const selectedCandidate = successfulCandidates[0];
  const candidateProbeResults = candidateResults.map((candidate) => ({
    path: candidate.path,
    installKind: candidate.diagnosis.installKind,
    invocationMode: candidate.diagnosis.invocationMode,
    nativeInstallValid: candidate.diagnosis.nativeInstallValid,
    sandboxCompatible: candidate.diagnosis.sandboxCompatible,
    launchReady: candidate.ok,
    summary: candidate.summary,
    ...(candidate.diagnosis.remediation ? { remediation: candidate.diagnosis.remediation } : {}),
    ...(candidate.diagnosis.nativeDependencyStatus
      ? { nativeDependencyStatus: candidate.diagnosis.nativeDependencyStatus }
      : {}),
    ...(candidate.diagnosis.nativeDependencyPackage
      ? { nativeDependencyPackage: candidate.diagnosis.nativeDependencyPackage }
      : {})
  }));

  if (selectedCandidate) {
    const successResult: CodexLaunchProbeResult = {
      ok: true,
      summary: selectedCandidate.summary,
      availability: {
        ...availability,
        resolvedPath: selectedCandidate.path,
        candidatePaths
      },
      diagnosis: {
        ...selectedCandidate.diagnosis,
        resolvedPath: selectedCandidate.path
      },
      command: selectedCandidate.path,
      args,
      exitCode: selectedCandidate.exitCode,
      stderr: selectedCandidate.stderr,
      stdout: selectedCandidate.stdout,
      candidateProbeResults
    };
    if (input.spawnSyncImpl === undefined) {
      codexLaunchProbeCache.set(cacheKey, successResult);
    }
    return successResult;
  }

  const bestFailure =
    platform === "win32"
      ? candidateResults.find(
          (candidate) =>
            candidate.diagnosis.nativeInstallValid && candidate.diagnosis.installKind === "native"
        ) ??
        candidateResults.find((candidate) => candidate.diagnosis.nativeInstallValid) ??
        candidateResults[0]
      : candidateResults[0];

  const failureResult: CodexLaunchProbeResult = {
    ok: false,
    summary: bestFailure?.summary ?? diagnosis.remediation ?? "Codex launch probe failed.",
    availability: {
      ...availability,
      ...(bestFailure ? { resolvedPath: bestFailure.path } : {}),
      ...(candidatePaths.length ? { candidatePaths } : {})
    },
    diagnosis: bestFailure
      ? {
          ...bestFailure.diagnosis,
          resolvedPath: bestFailure.path
        }
      : diagnosis,
    command: bestFailure?.path ?? availability.resolvedPath ?? availability.command,
    args,
    exitCode: bestFailure?.exitCode,
    stderr: bestFailure?.stderr,
    stdout: bestFailure?.stdout,
    candidateProbeResults
  };
  if (input.spawnSyncImpl === undefined) {
    codexLaunchProbeCache.set(cacheKey, failureResult);
  }
  return failureResult;
}
