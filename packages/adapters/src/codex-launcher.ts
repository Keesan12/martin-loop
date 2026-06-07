import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

export interface CliCommandAvailability {
  command: string;
  available: boolean;
  locator: string;
  detail: string;
  resolvedPath?: string;
}

export type CodexHostPlatform = "windows" | "linux" | "wsl" | "macos";

export interface CodexHostDiagnosis {
  hostPlatform: CodexHostPlatform;
  nativeInstallValid: boolean;
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
}

type SpawnSyncLike = typeof spawnSync;

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

function selectResolvedPath(candidates: string[], platform: NodeJS.Platform): string | undefined {
  const cleaned = candidates
    .map((line) => line.trim())
    .filter(Boolean);

  if (cleaned.length === 0) {
    return undefined;
  }

  if (platform !== "win32") {
    return cleaned[0];
  }

  const preference = (candidate: string): number => {
    switch (extname(candidate).toLowerCase()) {
      case ".cmd":
        return 0;
      case ".bat":
        return 1;
      case ".ps1":
        return 2;
      case ".exe":
        return 3;
      case "":
        return 4;
      default:
        return 5;
    }
  };

  return cleaned
    .slice()
    .sort((left, right) => preference(left) - preference(right) || left.localeCompare(right))[0];
}

function buildProbeCommand(
  command: string,
  args: string[],
  platform: NodeJS.Platform
): { command: string; args: string[] } {
  if (platform !== "win32") {
    return { command, args };
  }

  const extension = extname(command).toLowerCase();
  switch (extension) {
    case ".cmd":
    case ".bat":
      return {
        command: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/c", command, ...args]
      };
    case ".ps1":
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", command, ...args]
      };
    default:
      return { command, args };
  }
}

export function resolveCliCommandAvailability(
  command: string,
  options: {
    platform?: NodeJS.Platform;
    spawnSyncImpl?: SpawnSyncLike;
  } = {}
): CliCommandAvailability {
  const platform = options.platform ?? process.platform;
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const locator = platform === "win32" ? "where.exe" : "which";
  const result = spawnSyncImpl(locator, [command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  const resolvedPath =
    result.status === 0
      ? selectResolvedPath((result.stdout ?? "").split(/\r?\n/u), platform)
      : undefined;

  return result.status === 0
    ? {
        command,
        available: true,
        locator,
        detail: `${command} is available on PATH.`,
        ...(resolvedPath ? { resolvedPath } : {})
      }
    : {
        command,
        available: false,
        locator,
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
  const warnings: string[] = [];

  if (!availability.available) {
    return {
      hostPlatform,
      nativeInstallValid: false,
      warnings,
      remediation: "Install or expose the Codex CLI on PATH before running governed Codex work."
    };
  }

  const resolvedPath = availability.resolvedPath?.replace(/\\/gu, "/").toLowerCase() ?? "";
  const looksWindowsShim =
    resolvedPath.endsWith(".cmd") ||
    resolvedPath.endsWith(".bat") ||
    resolvedPath.endsWith(".ps1") ||
    resolvedPath.includes("/appdata/roaming/npm/");
  const looksMountedWindowsPath = resolvedPath.startsWith("/mnt/c/");

  if ((hostPlatform === "linux" || hostPlatform === "wsl") && (looksWindowsShim || looksMountedWindowsPath)) {
    warnings.push(
      "Codex resolves to a Windows-hosted install from a Linux/WSL environment."
    );
    return {
      hostPlatform,
      nativeInstallValid: false,
      warnings,
      remediation:
        "Install Codex natively inside this Linux/WSL environment instead of relying on a Windows PATH shim."
    };
  }

  return {
    hostPlatform,
    nativeInstallValid: true,
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
  const args = [
    "exec",
    "--cd",
    input.workingDirectory,
    "--sandbox",
    "workspace-write",
    "--json",
    "--color",
    "never",
    "--help"
  ];

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

  if (!diagnosis.nativeInstallValid) {
    return {
      ok: false,
      summary: diagnosis.remediation ?? "Codex host installation is not valid for this environment.",
      availability,
      diagnosis,
      command: availability.resolvedPath ?? availability.command,
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
  const spawnPlan = buildProbeCommand(availability.resolvedPath ?? availability.command, args, platform);
  const result = spawnSyncImpl(spawnPlan.command, spawnPlan.args, {
    cwd: input.workingDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.error) {
    return {
      ok: false,
      summary: `Codex launch probe failed: ${result.error.message}`,
      availability,
      diagnosis,
      command: availability.resolvedPath ?? availability.command,
      args,
      stderr: result.stderr ?? "",
      stdout: result.stdout ?? ""
    };
  }

  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    return {
      ok: false,
      summary:
        stderr.length > 0
          ? `Codex launch probe failed: ${stderr}`
          : "Codex launch probe exited non-zero.",
      availability,
      diagnosis,
      command: availability.resolvedPath ?? availability.command,
      args,
      exitCode: result.status ?? undefined,
      stderr: result.stderr ?? "",
      stdout: result.stdout ?? ""
    };
  }

  return {
    ok: true,
    summary: "Codex exec launch probe passed for the current MartinLoop invocation shape.",
    availability,
    diagnosis,
    command: availability.resolvedPath ?? availability.command,
    args,
    exitCode: result.status ?? undefined,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? ""
  };
}
