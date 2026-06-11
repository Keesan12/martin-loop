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
  /(^|[\s;&|`(])rm\s+-rf(\s|$)/iu,
  /git\s+reset\s+--hard/iu,
  /git\s+clean\s+-fd/iu,
  /curl\b[^\n|]*\|\s*(sh|bash)/iu,
  /wget\b[^\n|]*\|\s*(sh|bash)/iu,
  /(^|[\s;&|`(])sudo(\s|$)/iu,
  /(^|[\s;&|`(])mkfs(\.|\s|$)/iu,
  /(^|[\s;&|`(])dd\s+if=/iu,
  /(shutdown|reboot)(\s|$)/iu,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/iu,
  /chmod\s+-R\s+777\s+\//iu,
  /(kubectl|docker)\s+.*\b(delete|prune|rm)\b/iu,
  /ssh\s+/iu,
  /scp\s+/iu,
  // bash/sh -c "<destructive command>" wrappers — flags the wrapper shape directly,
  // since a naive regex on the outer command misses the destructive inner command.
  /\b(?:bash|sh|zsh)\s+-c\s+["'`]/iu,
  // recursive directory deletion via `find ... -delete` / `find ... -exec rm`
  /\bfind\s+\S+(?:\s+-[a-z-]+(?:\s+\S+)?)*\s+-delete\b/iu,
  /\bfind\s+\S+(?:\s+-[a-z-]+(?:\s+\S+)?)*\s+-exec\s+rm\b/iu,
  // scripting-language recursive deletion one-liners
  /\bshutil\.rmtree\s*\(/iu,
  /\bos\.(?:remove|rmdir|removedirs|unlink)\s*\(/iu,
  /\.(?:rm|rmdir|unlink)(?:Sync)?\s*\(/iu,
  /\brimraf\s*\(/iu
];

/**
 * Detects `rm` invocations that combine recursive + force flags regardless of
 * flag ordering/grouping (`-rf`, `-fr`, `-r -f`, `--recursive --force`),
 * absolute-path invocation (`/bin/rm`, `/usr/bin/rm`), case, or `${IFS}`-style
 * shell obfuscation — all of which slip past the literal `rm\s+-rf` pattern.
 */
function commandContainsDestructiveRemoval(command: string): boolean {
  const normalized = command.replace(/\$\{?IFS\}?/giu, " ").toLowerCase();

  const rmInvocation = /(?:^|[\s;&|`(])(?:[^\s;&|`(]+\/)?rm\s+([^\n;|`]+)/giu;
  let match: RegExpExecArray | null;
  while ((match = rmInvocation.exec(normalized)) !== null) {
    const args = match[1] ?? "";
    const hasRecursive = /(?:^|\s)-[a-z]*r[a-z]*(?:\s|$)|--recursive\b/u.test(args);
    const hasForce = /(?:^|\s)-[a-z]*f[a-z]*(?:\s|$)|--force\b/u.test(args);
    if (hasRecursive && hasForce) {
      return true;
    }
  }
  return false;
}

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
    pattern: /\bghp_[A-Za-z0-9_]{16,}\b/gu,
    replacement: "[REDACTED_SECRET]"
  },
  {
    kind: "secret_value",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
    replacement: "[REDACTED_SECRET]"
  },
  {
    kind: "secret_value",
    pattern: /\b(?:gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/gu,
    replacement: "[REDACTED_SECRET]"
  },
  {
    kind: "secret_value",
    pattern: /\bAKIA[0-9A-Z]{16}\b/gu,
    replacement: "[REDACTED_SECRET]"
  },
  {
    kind: "secret_value",
    pattern: /\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*[^\s"'`]+/giu,
    replacement: "AWS_SECRET_ACCESS_KEY=[REDACTED_SECRET]"
  },
  {
    kind: "secret_value",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/giu,
    replacement: "[REDACTED_SECRET]"
  },
  {
    kind: "secret_value",
    pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/gu,
    replacement: "[REDACTED_SECRET]"
  },
  {
    kind: "secret_value",
    pattern: /-----BEGIN(?:\s+[A-Z0-9]+)*\s+PRIVATE KEY-----[\s\S]*?-----END(?:\s+[A-Z0-9]+)*\s+PRIVATE KEY-----/gu,
    replacement: "[REDACTED_SECRET]"
  },
  {
    kind: "secret_value",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
    replacement: "[REDACTED_SECRET]"
  },
  {
    kind: "secret_value",
    pattern: /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["']?[A-Za-z0-9_\-/+=]{12,}["']?/giu,
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

  const blockedCommands = commands.filter(
    (command) =>
      BLOCKED_PATTERNS.some((pattern) => pattern.test(command)) ||
      commandContainsDestructiveRemoval(command)
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
  const normalizedFile = normalizePathForMatching(file);
  const normalizedPattern = normalizePathForMatching(pattern);

  if (!normalizedPattern.includes("*")) {
    return (
      normalizedFile === normalizedPattern ||
      normalizedFile.startsWith(`${normalizedPattern.replace(/\/$/u, "")}/`)
    );
  }

  const regexStr = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*\*/gu, "__DOUBLESTAR__")
    .replace(/\*/gu, "[^/]*")
    .replace(/__DOUBLESTAR__/gu, ".*");

  return new RegExp(`^${regexStr}$`, "u").test(normalizedFile);
}

function normalizePathForMatching(value: string): string {
  return value
    .replace(/\\/gu, "/")
    .replace(/^\.\//u, "")
    .replace(/\/{2,}/gu, "/")
    .replace(/\/$/u, "");
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
