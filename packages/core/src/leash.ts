import { isAbsolute, relative, resolve } from "node:path";

import type { ApprovalPolicy, ExecutionProfile, LoopTask } from "@martin/contracts";

export type SafetySurface = "command" | "filesystem" | "secret" | "spend" | "network" | "dependency";

export type SafetyViolationKind =
  | "command_blocked"
  | "path_not_allowed"
  | "path_denied"
  | "path_outside_repo"
  | "network_blocked"
  | "dependency_approval_required"
  | "migration_approval_required"
  | "config_change_approval_required"
  | "secret_value"
  | "protected_path";

export interface SafetyViolation {
  kind: SafetyViolationKind;
  message: string;
  command?: string;
  file?: string;
  match?: string;
}

export interface SafetyLeashDecision {
  allowed: boolean;
  blocked: boolean;
  riskLevel: "safe" | "blocked";
  surface: SafetySurface;
  profile?: ExecutionProfile;
  blockedCommands: string[];
  violations: SafetyViolation[];
  reason?: string;
}

export interface ResolvedExecutionProfile {
  name: ExecutionProfile;
  networkMode: "off" | "allowlisted" | "open";
  allowedNetworkDomains: string[];
  requireDependencyApproval: boolean;
  requireMigrationApproval: boolean;
  requireConfigApproval: boolean;
}

const BLOCKED_PATTERNS: RegExp[] = [
  /(^|\s)rm\s+-rf(\s|$)/u,
  /git\s+reset\s+--hard/iu,
  /git\s+clean\s+-fd/iu,
  /curl\b[^\n|]*\|\s*(sh|bash)/iu,
  /wget\b[^\n|]*\|\s*(sh|bash)/iu,
  /(^|\s)sudo(\s|$)/u,
  /(^|\s)mkfs(\.|\s|$)/u,
  /(^|\s)dd\s+if=/u,
  /(shutdown|reboot)(\s|$)/iu,
  /:\(\)\{:\|:&\};:/u,
  /chmod\s+-R\s+777\s+\//iu,
  /(kubectl|docker)\s+.*\b(delete|prune|rm)\b/iu,
  /ssh\s+/iu,
  /scp\s+/iu
];

const SECRET_PATTERNS: Array<{ kind: SafetyViolationKind; pattern: RegExp; replacement: string }> = [
  {
    kind: "secret_value",
    pattern: /\bOPENAI_API_KEY\s*=\s*[^\s"'`]+/giu,
    replacement: "OPENAI_API_KEY=[REDACTED_SECRET]"
  },
  {
    kind: "secret_value",
    pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/gu,
    replacement: "[REDACTED_SECRET]"
  },
  {
    kind: "secret_value",
    pattern: /\bghp_[A-Za-z0-9_]{8,}\b/gu,
    replacement: "[REDACTED_SECRET]"
  }
];

const PROTECTED_PATH_PATTERNS: Array<{ kind: SafetyViolationKind; pattern: RegExp; replacement: string }> = [
  {
    kind: "protected_path",
    pattern: /\B\.env(?!\.example\b)(?:\.[A-Za-z0-9._-]+)?\b/giu,
    replacement: "[REDACTED_PATH]"
  },
  {
    kind: "protected_path",
    pattern: /\bid_rsa\b/giu,
    replacement: "[REDACTED_PATH]"
  },
  {
    kind: "protected_path",
    pattern: /\b[A-Za-z0-9._/-]+\.(pem|p12|key)\b/giu,
    replacement: "[REDACTED_PATH]"
  }
];

export function evaluateVerificationLeash(
  task: Pick<
    LoopTask,
    "verificationPlan" | "verificationStack" | "executionProfile" | "allowedNetworkDomains"
  >
): SafetyLeashDecision {
  const commands = [
    ...(task.verificationPlan ?? []),
    ...((task.verificationStack ?? []).map((step) => step.command))
  ].filter(Boolean);
  const profile = resolveExecutionProfile(task);

  const blockedCommands = commands.filter((command) =>
    BLOCKED_PATTERNS.some((pattern) => pattern.test(command))
  );

  const violations = blockedCommands.map((command) => ({
    kind: "command_blocked" as const,
    command,
    message: `Blocked destructive verifier command: ${command}`
  }));

  if (blockedCommands.length > 0) {
    return {
      allowed: false,
      blocked: true,
      riskLevel: "blocked",
      surface: "command",
      profile: profile.name,
      blockedCommands,
      violations,
      reason: "Safety leash blocked destructive or unbounded verifier commands."
    };
  }

  const networkViolations = commands
    .map((command) => buildNetworkViolation(command, profile))
    .filter((violation): violation is SafetyViolation => Boolean(violation));

  if (networkViolations.length > 0) {
    return {
      allowed: false,
      blocked: true,
      riskLevel: "blocked",
      surface: "network",
      profile: profile.name,
      blockedCommands: commands.filter((command) => buildNetworkViolation(command, profile)),
      violations: networkViolations,
      reason: `Safety leash blocked outbound network access for the ${profile.name} profile.`
    };
  }

  return {
    allowed: true,
    blocked: false,
    riskLevel: "safe",
    surface: "command",
    profile: profile.name,
    blockedCommands: [],
    violations: []
  };
}

export function evaluateFilesystemLeash(input: {
  repoRoot?: string;
  changedFiles: string[];
  allowedPaths?: string[];
  deniedPaths?: string[];
}): SafetyLeashDecision {
  const violations: SafetyViolation[] = [];

  for (const rawFile of input.changedFiles) {
    const normalized = normalizeChangedFile(rawFile, input.repoRoot);

    if (normalized.outsideRepo) {
      violations.push({
        kind: "path_outside_repo",
        file: rawFile,
        message: `Changed file is outside the configured repo root: ${rawFile}`
      });
      continue;
    }

    const file = normalized.file;
    if (!file) {
      continue;
    }

    if ((input.deniedPaths ?? []).some((pattern) => matchesPathPattern(file, pattern))) {
      violations.push({
        kind: "path_denied",
        file,
        message: `Changed file matches a denylisted path: ${file}`
      });
      continue;
    }

    const allowedPaths = input.allowedPaths ?? [];
    if (allowedPaths.length > 0 && !allowedPaths.some((pattern) => matchesPathPattern(file, pattern))) {
      violations.push({
        kind: "path_not_allowed",
        file,
        message: `Changed file is outside the allowed paths: ${file}`
      });
    }
  }

  if (violations.length > 0) {
    return {
      allowed: false,
      blocked: true,
      riskLevel: "blocked",
      surface: "filesystem",
      blockedCommands: [],
      violations,
      reason: "Safety leash blocked file changes outside the allowed repo contract."
    };
  }

  return {
    allowed: true,
    blocked: false,
    riskLevel: "safe",
    surface: "filesystem",
    blockedCommands: [],
    violations: []
  };
}

export function evaluateSecretLeash(input: { values: string[] }): SafetyLeashDecision {
  const violations: SafetyViolation[] = [];

  for (const value of input.values) {
    if (!value) continue;

    for (const rule of SECRET_PATTERNS) {
      for (const match of value.matchAll(rule.pattern)) {
        const matched = match[0];
        if (!matched) continue;
        violations.push({
          kind: rule.kind,
          match: matched,
          message: "Secret-like credential value detected in the runtime context."
        });
      }
    }
  }

  if (violations.length > 0) {
    return {
      allowed: false,
      blocked: true,
      riskLevel: "blocked",
      surface: "secret",
      blockedCommands: [],
      violations,
      reason: "Safety leash blocked secret-like credential values from entering the runtime context."
    };
  }

  return {
    allowed: true,
    blocked: false,
    riskLevel: "safe",
    surface: "secret",
    blockedCommands: [],
    violations: []
  };
}

export function resolveExecutionProfile(input: {
  executionProfile?: ExecutionProfile;
  allowedNetworkDomains?: string[];
}): ResolvedExecutionProfile {
  const name = input.executionProfile ?? "strict_local";
  const allowedNetworkDomains = [...(input.allowedNetworkDomains ?? [])];

  switch (name) {
    case "ci_safe":
      return {
        name,
        networkMode: "off",
        allowedNetworkDomains,
        requireDependencyApproval: true,
        requireMigrationApproval: true,
        requireConfigApproval: true
      };
    case "staging_controlled":
      return {
        name,
        networkMode: allowedNetworkDomains.length > 0 ? "allowlisted" : "off",
        allowedNetworkDomains,
        requireDependencyApproval: true,
        requireMigrationApproval: true,
        requireConfigApproval: true
      };
    case "research_untrusted":
      return {
        name,
        networkMode: allowedNetworkDomains.length > 0 ? "allowlisted" : "open",
        allowedNetworkDomains,
        requireDependencyApproval: true,
        requireMigrationApproval: true,
        requireConfigApproval: true
      };
    case "strict_local":
    default:
      return {
        name: "strict_local",
        networkMode: "off",
        allowedNetworkDomains,
        requireDependencyApproval: true,
        requireMigrationApproval: true,
        requireConfigApproval: true
      };
  }
}

export function evaluateChangeApprovalLeash(input: {
  changedFiles: string[];
  executionProfile?: ExecutionProfile;
  approvalPolicy?: ApprovalPolicy;
}): SafetyLeashDecision {
  const profile = resolveExecutionProfile({
    executionProfile: input.executionProfile
  });
  const violations: SafetyViolation[] = [];

  for (const file of input.changedFiles.map((entry) => entry.replace(/\\/gu, "/"))) {
    if (isDependencyFile(file) && profile.requireDependencyApproval && !input.approvalPolicy?.dependencyAdds) {
      violations.push({
        kind: "dependency_approval_required",
        file,
        message: `Dependency-related file change requires approval in the ${profile.name} profile: ${file}`
      });
      continue;
    }

    if (isMigrationFile(file) && profile.requireMigrationApproval && !input.approvalPolicy?.migrations) {
      violations.push({
        kind: "migration_approval_required",
        file,
        message: `Migration change requires approval in the ${profile.name} profile: ${file}`
      });
      continue;
    }

    if (isConfigChangeFile(file) && profile.requireConfigApproval && !input.approvalPolicy?.configChanges) {
      violations.push({
        kind: "config_change_approval_required",
        file,
        message: `Deployment or configuration change requires approval in the ${profile.name} profile: ${file}`
      });
    }
  }

  if (violations.length > 0) {
    return {
      allowed: false,
      blocked: true,
      riskLevel: "blocked",
      surface: "dependency",
      profile: profile.name,
      blockedCommands: [],
      violations,
      reason: "Safety leash blocked dependency, migration, or configuration changes that require approval."
    };
  }

  return {
    allowed: true,
    blocked: false,
    riskLevel: "safe",
    surface: "dependency",
    profile: profile.name,
    blockedCommands: [],
    violations: []
  };
}

export function redactSecretsFromText(input: string): string {
  let output = input;

  for (const rule of [...SECRET_PATTERNS, ...PROTECTED_PATH_PATTERNS]) {
    output = output.replace(rule.pattern, rule.replacement);
  }

  return output;
}

function normalizeChangedFile(
  file: string,
  repoRoot?: string
): { file?: string; outsideRepo: boolean } {
  const normalizedInput = file.replace(/\\/gu, "/");

  if (!repoRoot) {
    return {
      file: normalizedInput,
      outsideRepo: normalizedInput.startsWith("../") || normalizedInput.includes("/../")
    };
  }

  const absoluteRoot = resolve(repoRoot);
  const absoluteFile = isAbsolute(file) ? resolve(file) : resolve(absoluteRoot, file);
  const repoRelative = relative(absoluteRoot, absoluteFile).replace(/\\/gu, "/");

  if (
    repoRelative.length === 0 ||
    repoRelative === ".." ||
    repoRelative.startsWith("../") ||
    isAbsolute(repoRelative)
  ) {
    return { outsideRepo: true };
  }

  return {
    file: repoRelative,
    outsideRepo: false
  };
}

function matchesPathPattern(file: string, pattern: string): boolean {
  const normalizedFile = file.replace(/\\/gu, "/");
  const normalizedPattern = pattern.replace(/\\/gu, "/");

  if (normalizedPattern.includes("**")) {
    const prefix = normalizedPattern.split("**")[0] ?? normalizedPattern;
    return normalizedFile.startsWith(prefix.replace(/\/$/u, ""));
  }

  if (normalizedPattern.endsWith("*")) {
    return normalizedFile.startsWith(normalizedPattern.replace(/\*+$/u, ""));
  }

  return (
    normalizedFile === normalizedPattern ||
    normalizedFile.startsWith(`${normalizedPattern.replace(/\/$/u, "")}/`)
  );
}

function buildNetworkViolation(
  command: string,
  profile: ResolvedExecutionProfile
): SafetyViolation | undefined {
  const targets = extractNetworkTargets(command);
  if (targets.length === 0) {
    return undefined;
  }

  if (profile.networkMode === "open") {
    return undefined;
  }

  if (profile.networkMode === "allowlisted") {
    const blockedTarget = targets.find(
      (target) => !profile.allowedNetworkDomains.some((domain) => target === domain || target.endsWith(`.${domain}`))
    );
    if (!blockedTarget) {
      return undefined;
    }

    return {
      kind: "network_blocked",
      command,
      match: blockedTarget,
      message: `Network target is not allowlisted for the ${profile.name} profile: ${blockedTarget}`
    };
  }

  return {
    kind: "network_blocked",
    command,
    match: targets[0],
    message: `Outbound network access is blocked for the ${profile.name} profile.`
  };
}

function extractNetworkTargets(command: string): string[] {
  if (!/\b(curl|wget|invoke-webrequest|iwr|httpie|http)\b/iu.test(command)) {
    return [];
  }

  return [...command.matchAll(/https?:\/\/([^/\s"'`]+)/giu)]
    .map((match) => match[1]?.toLowerCase())
    .filter((value): value is string => Boolean(value));
}

function isDependencyFile(file: string): boolean {
  const normalized = file.replace(/\\/gu, "/");
  return [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "pyproject.toml",
    "requirements.txt",
    "Cargo.toml",
    "Cargo.lock"
  ].includes(normalized.split("/").at(-1) ?? normalized);
}

function isMigrationFile(file: string): boolean {
  const normalized = file.replace(/\\/gu, "/");
  return (
    normalized.includes("/migrations/") ||
    normalized.startsWith("migrations/") ||
    normalized.includes("prisma/migrations/")
  );
}

function isConfigChangeFile(file: string): boolean {
  const normalized = file.replace(/\\/gu, "/");
  const leaf = normalized.split("/").at(-1) ?? normalized;

  if (
    [
      "vercel.json",
      "netlify.toml",
      "wrangler.toml",
      "docker-compose.yml",
      "docker-compose.yaml",
      "compose.yml",
      "compose.yaml",
      "fly.toml",
      "railway.json"
    ].includes(leaf)
  ) {
    return true;
  }

  return (
    normalized.startsWith(".github/workflows/") ||
    normalized.startsWith("deploy/") ||
    normalized.startsWith("deployment/") ||
    normalized.startsWith("infra/") ||
    normalized.startsWith("infrastructure/") ||
    normalized.startsWith("ops/")
  );
}
