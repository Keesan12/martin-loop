import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { DEFAULT_BUDGET } from "@martin/contracts";

import {
  detectCliAvailability,
  type MartinEngine,
  type RunStoreInspection
} from "./tool-support.js";

export type MartinPolicyPack =
  | "solo-founder"
  | "startup-team"
  | "enterprise-strict"
  | "oss-maintainer"
  | "security-sensitive";

export interface RepoGitState {
  available: boolean;
  isRepo: boolean;
  clean: boolean;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
}

export interface RepoSignals {
  workingDirectory: string;
  packageManager: "pnpm" | "npm" | "yarn" | "bun" | "unknown";
  languages: string[];
  frameworks: string[];
  verifiers: {
    test: string[];
    lint: string[];
    build: string[];
    defaultPlan: string[];
  };
  packageScripts: Record<string, string>;
  git: RepoGitState;
  sensitivePaths: string[];
  availableHosts: Record<
    "claude" | "codex" | "cursor" | "gemini",
    {
      available: boolean;
      detail: string;
      resolvedPath?: string;
    }
  >;
}

export interface MartinRiskAssessment {
  score: number;
  level: "low" | "medium" | "high";
  reasons: string[];
  recommendedAction: "proceed" | "review" | "require_human_approval";
}

export interface MartinPolicyPackDefinition {
  name: MartinPolicyPack;
  summary: string;
  defaultVerifiers: string[];
  defaultAllowedPaths: string[];
  defaultBlockedPaths: string[];
  dossierExpectations: string[];
  requireApprovalAtOrAbove: MartinRiskAssessment["level"];
}

export interface MartinPlanBudget {
  maxUsd: number;
  softLimitUsd: number;
  maxIterations: number;
  maxTokens: number;
  maxMinutes: number;
  maxFilesChanged: number;
  maxCommands: number;
}

export interface MartinRunContract {
  objective: string;
  context?: string;
  allowedPaths: string[];
  blockedPaths: string[];
  budget: MartinPlanBudget;
  verifiers: string[];
  risk: MartinRiskAssessment;
  policyPack: MartinPolicyPack;
  requiresApproval: boolean;
}

export interface MartinPlanProposal {
  objective: string;
  implementationSummary: string;
  proposedFileScope: {
    allowedPaths: string[];
    blockedPaths: string[];
  };
  proposedVerifiers: string[];
  estimatedBudget: MartinPlanBudget;
  risk: MartinRiskAssessment;
  approvalRecommendation: "not_required" | "recommended" | "required";
  policyPack: MartinPolicyPackDefinition;
  nextSteps: string[];
}

export interface MartinReadinessReport {
  score: number;
  level: "low" | "medium" | "high";
  missingSafeguards: string[];
  repo: {
    git: RepoGitState;
    packageManager: RepoSignals["packageManager"];
    languages: string[];
    frameworks: string[];
  };
  safeguards: {
    verifierDetected: boolean;
    repoScoped: boolean;
    branchSafe: boolean;
    runStoreHealthy: boolean;
  };
  availableHosts: RepoSignals["availableHosts"];
}

interface ContractOverrides {
  objective: string;
  context?: string;
  verificationPlan?: string[];
  allowedPaths?: string[];
  deniedPaths?: string[];
  policyPack?: MartinPolicyPack;
  maxUsd?: number;
  maxIterations?: number;
  maxTokens?: number;
  maxMinutes?: number;
  maxFilesChanged?: number;
  maxCommands?: number;
}

const HOST_COMMANDS = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor",
  gemini: "gemini"
} as const;

const GIT_STATE_CACHE_TTL_MS = 60_000;
const repoGitStateCache = new Map<
  string,
  { expiresAt: number; value: RepoGitState }
>();

const POLICY_PACKS: Record<MartinPolicyPack, Omit<MartinPolicyPackDefinition, "defaultVerifiers">> = {
  "solo-founder": {
    name: "solo-founder",
    summary: "Fast local defaults with light scope controls and proof-first review.",
    defaultAllowedPaths: ["src/**", "tests/**", "docs/**"],
    defaultBlockedPaths: [".env", ".env.*", ".git/**", "node_modules/**", "dist/**"],
    dossierExpectations: ["objective", "files touched", "verifier result", "next action"],
    requireApprovalAtOrAbove: "high"
  },
  "startup-team": {
    name: "startup-team",
    summary: "Team-safe defaults with verifier expectations and branch hygiene.",
    defaultAllowedPaths: ["src/**", "tests/**", "docs/**"],
    defaultBlockedPaths: [
      ".env",
      ".env.*",
      ".git/**",
      "infra/**",
      "deploy/**",
      "node_modules/**"
    ],
    dossierExpectations: [
      "objective",
      "scope",
      "commands run",
      "verifier result",
      "risk flags",
      "review focus"
    ],
    requireApprovalAtOrAbove: "medium"
  },
  "enterprise-strict": {
    name: "enterprise-strict",
    summary: "Fail-closed local policy that blocks infra, dependency, and secret-risk paths by default.",
    defaultAllowedPaths: ["src/**", "tests/**"],
    defaultBlockedPaths: [
      ".env",
      ".env.*",
      ".git/**",
      "infra/**",
      "deploy/**",
      ".github/workflows/**",
      "package.json",
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock"
    ],
    dossierExpectations: [
      "objective",
      "scope contract",
      "tests",
      "risk score",
      "review blockers",
      "rollback evidence"
    ],
    requireApprovalAtOrAbove: "medium"
  },
  "oss-maintainer": {
    name: "oss-maintainer",
    summary: "OSS-focused policy with docs, tests, and reviewable diff discipline.",
    defaultAllowedPaths: ["packages/**", "tests/**", "docs/**", "README.md", "CHANGELOG.md"],
    defaultBlockedPaths: [".env", ".env.*", ".git/**", "infra/**", "deploy/**"],
    dossierExpectations: [
      "objective",
      "diff summary",
      "tests",
      "risk flags",
      "release notes impact"
    ],
    requireApprovalAtOrAbove: "medium"
  },
  "security-sensitive": {
    name: "security-sensitive",
    summary: "Local security policy with strict approvals around auth, secrets, and privileged files.",
    defaultAllowedPaths: ["src/**", "tests/**"],
    defaultBlockedPaths: [
      ".env",
      ".env.*",
      ".git/**",
      "infra/**",
      "deploy/**",
      ".github/workflows/**",
      "package.json",
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
      "auth/**",
      "payments/**",
      "secrets/**"
    ],
    dossierExpectations: [
      "objective",
      "scope contract",
      "security review",
      "tests",
      "risk score",
      "human approval receipt"
    ],
    requireApprovalAtOrAbove: "medium"
  }
};

export function inspectRepoSignals(workingDirectory: string): RepoSignals {
  const packageScripts = readPackageScripts(workingDirectory);
  const packageManager = detectPackageManager(workingDirectory);
  const frameworks = detectFrameworks(workingDirectory, packageScripts);
  const languages = detectLanguages(workingDirectory, frameworks);
  const verifiers = detectVerifierCommands(packageScripts, packageManager);

  return {
    workingDirectory,
    packageManager,
    languages,
    frameworks,
    verifiers,
    packageScripts,
    git: detectGitState(workingDirectory),
    sensitivePaths: detectSensitivePaths(workingDirectory),
    availableHosts: {
      claude: detectCliAvailability(HOST_COMMANDS.claude),
      codex: detectCliAvailability(HOST_COMMANDS.codex),
      cursor: detectCliAvailability(HOST_COMMANDS.cursor),
      gemini: detectCliAvailability(HOST_COMMANDS.gemini)
    }
  };
}

export function buildReadinessReport(
  signals: RepoSignals,
  runStore: RunStoreInspection
): MartinReadinessReport {
  const missingSafeguards: string[] = [];

  if (!signals.git.available || !signals.git.isRepo) {
    missingSafeguards.push("Git repository context is unavailable.");
  }
  if (signals.git.isRepo && !signals.git.clean) {
    missingSafeguards.push("Working tree is dirty; agent edits may overlap uncommitted work.");
  }
  if (signals.verifiers.defaultPlan.length === 0) {
    missingSafeguards.push("No test/lint/build verifier plan was detected.");
  }
  if (!runStore.exists) {
    missingSafeguards.push("Martin runs root does not exist yet.");
  }
  if (!signals.git.branch || /^(main|master)$/u.test(signals.git.branch)) {
    missingSafeguards.push("Work is not isolated on a feature branch.");
  }

  let score = 100;
  score -= missingSafeguards.length * 12;
  if (signals.frameworks.length === 0) {
    score -= 8;
  }
  if (!signals.availableHosts.claude.available && !signals.availableHosts.codex.available) {
    score -= 18;
  }
  score = Math.max(0, Math.min(100, score));

  const level = score >= 80 ? "low" : score >= 55 ? "medium" : "high";

  return {
    score,
    level,
    missingSafeguards,
    repo: {
      git: signals.git,
      packageManager: signals.packageManager,
      languages: signals.languages,
      frameworks: signals.frameworks
    },
    safeguards: {
      verifierDetected: signals.verifiers.defaultPlan.length > 0,
      repoScoped: signals.git.isRepo,
      branchSafe: Boolean(signals.git.branch && !/^(main|master)$/u.test(signals.git.branch)),
      runStoreHealthy: runStore.exists
    },
    availableHosts: signals.availableHosts
  };
}

export function buildPolicyPackDefinition(
  policyPack: MartinPolicyPack | undefined,
  signals: RepoSignals
): MartinPolicyPackDefinition {
  const name = policyPack ?? inferPolicyPack(signals);
  const base = POLICY_PACKS[name];
  return {
    ...base,
    defaultVerifiers:
      signals.verifiers.defaultPlan.length > 0
        ? signals.verifiers.defaultPlan
        : fallbackVerifierPlan(signals.packageManager)
  };
}

export function buildPlanProposal(
  workingDirectory: string,
  overrides: ContractOverrides
): MartinPlanProposal {
  const signals = inspectRepoSignals(workingDirectory);
  const policy = buildPolicyPackDefinition(overrides.policyPack, signals);
  const scope = inferScopeFromObjective(overrides.objective, policy, overrides);
  const estimatedBudget = buildBudget(overrides, signals);
  const risk = assessRunRisk({
    objective: overrides.objective,
    context: overrides.context,
    allowedPaths: scope.allowedPaths,
    blockedPaths: scope.blockedPaths,
    verifiers: selectVerifiers(policy, overrides.verificationPlan),
    signals
  });

  const approvalRecommendation =
    risk.level === "high"
      ? "required"
      : risk.level === "medium"
        ? "recommended"
        : "not_required";

  return {
    objective: overrides.objective,
    implementationSummary: buildImplementationSummary(overrides.objective, scope.allowedPaths),
    proposedFileScope: scope,
    proposedVerifiers: selectVerifiers(policy, overrides.verificationPlan),
    estimatedBudget,
    risk,
    approvalRecommendation,
    policyPack: policy,
    nextSteps: [
      "Review the proposed scope and risk reasons.",
      "Run martin_preflight with the same objective, policy pack, and verifier plan.",
      "Execute martin_run only after the run contract looks safe and reviewable."
    ]
  };
}

export function buildRunContract(
  workingDirectory: string,
  overrides: ContractOverrides
): MartinRunContract {
  const plan = buildPlanProposal(workingDirectory, overrides);
  return {
    objective: overrides.objective,
    ...(overrides.context ? { context: overrides.context } : {}),
    allowedPaths: plan.proposedFileScope.allowedPaths,
    blockedPaths: plan.proposedFileScope.blockedPaths,
    budget: plan.estimatedBudget,
    verifiers: plan.proposedVerifiers,
    risk: plan.risk,
    policyPack: plan.policyPack.name,
    requiresApproval:
      plan.approvalRecommendation === "required" ||
      shouldRequireApproval(plan.policyPack.requireApprovalAtOrAbove, plan.risk.level)
  };
}

export function assessRunRisk(input: {
  objective: string;
  context?: string;
  allowedPaths: string[];
  blockedPaths: string[];
  verifiers: string[];
  signals: RepoSignals;
}): MartinRiskAssessment {
  const reasons: string[] = [];
  let score = 12;
  const text = `${input.objective} ${input.context ?? ""}`.toLowerCase();

  if (input.signals.git.isRepo && !input.signals.git.clean) {
    score += 18;
    reasons.push("Repository has uncommitted changes.");
  }
  if (input.verifiers.length === 0) {
    score += 22;
    reasons.push("No verifier commands are configured for this run.");
  }
  if (input.allowedPaths.length === 0) {
    score += 15;
    reasons.push("No edit allowlist was provided.");
  }
  if (/(auth|login|permission|secret|token|payment|billing|deploy|infra|migration)/u.test(text)) {
    score += 26;
    reasons.push("Objective touches sensitive auth, secret, payment, or deployment concerns.");
  }
  if (/(dependency|package\.json|lockfile|upgrade|install)/u.test(text)) {
    score += 14;
    reasons.push("Objective may require dependency or lockfile changes.");
  }
  if (input.blockedPaths.some((candidate) => /package\.json|lock|workflow|infra/u.test(candidate))) {
    score += 6;
    reasons.push("Policy pack blocks high-risk repo surfaces by default.");
  }
  if (input.signals.sensitivePaths.length > 0 && input.allowedPaths.some((candidate) => candidate === "**" || candidate === "*")) {
    score += 10;
    reasons.push("Wide edit scope overlaps with sensitive repo areas.");
  }

  score = Math.max(0, Math.min(100, score));
  const level = score >= 70 ? "high" : score >= 40 ? "medium" : "low";

  return {
    score,
    level,
    reasons,
    recommendedAction:
      level === "high"
        ? "require_human_approval"
        : level === "medium"
          ? "review"
          : "proceed"
  };
}

export function buildRepoRiskMap(signals: RepoSignals): {
  workingDirectory: string;
  packageManager: RepoSignals["packageManager"];
  frameworks: string[];
  sensitivePaths: string[];
  recommendedPolicyPack: MartinPolicyPack;
} {
  return {
    workingDirectory: signals.workingDirectory,
    packageManager: signals.packageManager,
    frameworks: signals.frameworks,
    sensitivePaths: signals.sensitivePaths,
    recommendedPolicyPack: inferPolicyPack(signals)
  };
}

function detectPackageManager(workingDirectory: string): RepoSignals["packageManager"] {
  if (existsSync(path.join(workingDirectory, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (existsSync(path.join(workingDirectory, "package-lock.json"))) {
    return "npm";
  }
  if (existsSync(path.join(workingDirectory, "yarn.lock"))) {
    return "yarn";
  }
  if (existsSync(path.join(workingDirectory, "bun.lockb")) || existsSync(path.join(workingDirectory, "bun.lock"))) {
    return "bun";
  }
  return "unknown";
}

function readPackageScripts(workingDirectory: string): Record<string, string> {
  const packageJsonPath = path.join(workingDirectory, "package.json");
  if (!existsSync(packageJsonPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

function detectFrameworks(workingDirectory: string, scripts: Record<string, string>): string[] {
  const packageJsonPath = path.join(workingDirectory, "package.json");
  const frameworks = new Set<string>();

  if (existsSync(path.join(workingDirectory, "next.config.js")) || existsSync(path.join(workingDirectory, "next.config.mjs"))) {
    frameworks.add("Next.js");
  }
  if (existsSync(path.join(workingDirectory, "vite.config.ts")) || existsSync(path.join(workingDirectory, "vite.config.js"))) {
    frameworks.add("Vite");
  }
  if (existsSync(packageJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = {
        ...(parsed.dependencies ?? {}),
        ...(parsed.devDependencies ?? {})
      };
      if ("next" in deps) {
        frameworks.add("Next.js");
      }
      if ("react" in deps) {
        frameworks.add("React");
      }
      if ("vitest" in deps) {
        frameworks.add("Vitest");
      }
      if ("jest" in deps) {
        frameworks.add("Jest");
      }
      if ("typescript" in deps || existsSync(path.join(workingDirectory, "tsconfig.json"))) {
        frameworks.add("TypeScript");
      }
    } catch {
      // ignore malformed package metadata here; doctor surfaces the gap elsewhere
    }
  }

  if (Object.keys(scripts).some((key) => key.startsWith("test"))) {
    frameworks.add("Scripted verification");
  }

  return [...frameworks];
}

function detectLanguages(workingDirectory: string, frameworks: string[]): string[] {
  const languages = new Set<string>();
  if (existsSync(path.join(workingDirectory, "tsconfig.json")) || frameworks.includes("TypeScript")) {
    languages.add("TypeScript");
  }
  if (existsSync(path.join(workingDirectory, "package.json"))) {
    languages.add("JavaScript");
  }
  if (existsSync(path.join(workingDirectory, "pyproject.toml")) || existsSync(path.join(workingDirectory, "requirements.txt"))) {
    languages.add("Python");
  }
  if (existsSync(path.join(workingDirectory, "go.mod"))) {
    languages.add("Go");
  }
  if (existsSync(path.join(workingDirectory, "Cargo.toml"))) {
    languages.add("Rust");
  }
  return [...languages];
}

function detectVerifierCommands(
  scripts: Record<string, string>,
  packageManager: RepoSignals["packageManager"]
): RepoSignals["verifiers"] {
  const prefix =
    packageManager === "pnpm"
      ? "pnpm"
      : packageManager === "yarn"
        ? "yarn"
        : packageManager === "bun"
          ? "bun run"
          : "npm run";

  const test: string[] = [];
  const lint: string[] = [];
  const build: string[] = [];

  for (const key of Object.keys(scripts)) {
    if (/^test($|:|-)/u.test(key)) {
      test.push(commandForScript(prefix, key));
    }
    if (/^lint($|:|-)/u.test(key)) {
      lint.push(commandForScript(prefix, key));
    }
    if (/^build($|:|-)/u.test(key)) {
      build.push(commandForScript(prefix, key));
    }
  }

  const defaultPlan = [...test.slice(0, 1), ...lint.slice(0, 1), ...build.slice(0, 1)];

  return { test, lint, build, defaultPlan };
}

function detectGitState(workingDirectory: string): RepoGitState {
  const cacheKey = workingDirectory;
  const cached = repoGitStateCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const status = spawnSync("git", ["status", "--porcelain", "--branch"], {
    cwd: workingDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (status.status !== 0) {
    const availability = spawnSync("git", ["--version"], {
      cwd: workingDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });

    const value =
      availability.status !== 0
        ? {
            available: false,
            isRepo: false,
            clean: false
          }
        : {
            available: true,
            isRepo: false,
            clean: false
          };

    repoGitStateCache.set(cacheKey, {
      expiresAt: Date.now() + GIT_STATE_CACHE_TTL_MS,
      value
    });

    return value;
  }

  const statusLines = (status.stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const dirty = statusLines.some((line) => !line.startsWith("##"));
  const header = statusLines.find((line) => line.startsWith("##"));
  const branch = header
    ?.replace(/^##\s+/u, "")
    .split("...")[0]
    ?.trim()
    .replace(/\s+\[.*$/u, "");
  const upstream = header?.match(/\.\.\.([^\s[]+)/u)?.[1];
  const ahead = parseCount(header, /ahead (\d+)/u);
  const behind = parseCount(header, /behind (\d+)/u);

  const value: RepoGitState = {
    available: true,
    isRepo: true,
    clean: !dirty,
    ...(branch ? { branch } : {}),
    ...(upstream ? { upstream } : {}),
    ...(ahead !== undefined ? { ahead } : {}),
    ...(behind !== undefined ? { behind } : {})
  };

  repoGitStateCache.set(cacheKey, {
    expiresAt: Date.now() + GIT_STATE_CACHE_TTL_MS,
    value
  });

  return value;
}

function detectSensitivePaths(workingDirectory: string): string[] {
  const candidates = [
    ".env",
    ".env.local",
    "infra",
    "deploy",
    ".github/workflows",
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "Dockerfile",
    "docker-compose.yml",
    "auth",
    "payments"
  ];

  return candidates.filter((candidate) => existsSync(path.join(workingDirectory, candidate)));
}

function inferPolicyPack(signals: RepoSignals): MartinPolicyPack {
  const sensitive = signals.sensitivePaths.join(" ").toLowerCase();
  if (/(auth|payment|workflow|deploy|infra|docker)/u.test(sensitive)) {
    return "security-sensitive";
  }
  if (/README|CHANGELOG/u.test(Object.keys(signals.packageScripts).join(" "))) {
    return "oss-maintainer";
  }
  return signals.git.isRepo && signals.git.clean ? "startup-team" : "solo-founder";
}

function inferScopeFromObjective(
  objective: string,
  policy: MartinPolicyPackDefinition,
  overrides: ContractOverrides
): {
  allowedPaths: string[];
  blockedPaths: string[];
} {
  if ((overrides.allowedPaths?.length ?? 0) > 0 || (overrides.deniedPaths?.length ?? 0) > 0) {
    return {
      allowedPaths: overrides.allowedPaths ?? [],
      blockedPaths: overrides.deniedPaths ?? []
    };
  }

  const normalized = objective.toLowerCase();
  if (/(readme|docs|changelog|release notes)/u.test(normalized)) {
    return {
      allowedPaths: ["docs/**", "README.md", "CHANGELOG.md"],
      blockedPaths: [...policy.defaultBlockedPaths, "src/**"]
    };
  }
  if (/(test|verifier|spec|coverage)/u.test(normalized)) {
    return {
      allowedPaths: ["src/**", "tests/**"],
      blockedPaths: policy.defaultBlockedPaths
    };
  }
  if (/(mcp|cli|package)/u.test(normalized)) {
    return {
      allowedPaths: ["packages/**", "tests/**", "docs/**"],
      blockedPaths: policy.defaultBlockedPaths
    };
  }

  return {
    allowedPaths: [...policy.defaultAllowedPaths],
    blockedPaths: [...policy.defaultBlockedPaths]
  };
}

function buildBudget(overrides: ContractOverrides, signals: RepoSignals): MartinPlanBudget {
  const defaultCommands = signals.verifiers.defaultPlan.length > 0 ? 12 : 8;
  return {
    maxUsd: overrides.maxUsd ?? DEFAULT_BUDGET.maxUsd,
    softLimitUsd: Math.min(
      overrides.maxUsd ?? DEFAULT_BUDGET.maxUsd,
      DEFAULT_BUDGET.softLimitUsd
    ),
    maxIterations: overrides.maxIterations ?? DEFAULT_BUDGET.maxIterations,
    maxTokens: overrides.maxTokens ?? DEFAULT_BUDGET.maxTokens,
    maxMinutes: overrides.maxMinutes ?? 20,
    maxFilesChanged: overrides.maxFilesChanged ?? 8,
    maxCommands: overrides.maxCommands ?? defaultCommands
  };
}

function selectVerifiers(
  policy: MartinPolicyPackDefinition,
  explicitVerificationPlan?: string[]
): string[] {
  return explicitVerificationPlan && explicitVerificationPlan.length > 0
    ? explicitVerificationPlan
    : policy.defaultVerifiers;
}

function buildImplementationSummary(objective: string, allowedPaths: string[]): string {
  const scopeHint =
    allowedPaths.length > 0
      ? `Limit work to ${allowedPaths.slice(0, 3).join(", ")}${allowedPaths.length > 3 ? " and adjacent tests/docs" : ""}.`
      : "Establish a narrower file scope before execution.";
  return `${objective.trim()} ${scopeHint}`.trim();
}

function commandForScript(prefix: string, name: string): string {
  if (prefix === "pnpm") {
    return name === "test" ? "pnpm test" : `pnpm ${name}`;
  }
  if (prefix === "yarn") {
    return name === "test" ? "yarn test" : `yarn ${name}`;
  }
  if (prefix === "bun run") {
    return `bun run ${name}`;
  }
  return `npm run ${name}`;
}

function fallbackVerifierPlan(packageManager: RepoSignals["packageManager"]): string[] {
  switch (packageManager) {
    case "pnpm":
      return ["pnpm test", "pnpm lint", "pnpm build"];
    case "yarn":
      return ["yarn test", "yarn lint", "yarn build"];
    case "bun":
      return ["bun run test", "bun run lint", "bun run build"];
    case "npm":
      return ["npm test", "npm run lint", "npm run build"];
    default:
      return [];
  }
}

function shouldRequireApproval(
  threshold: MartinPolicyPackDefinition["requireApprovalAtOrAbove"],
  level: MartinRiskAssessment["level"]
): boolean {
  const ordering = ["low", "medium", "high"] as const;
  return ordering.indexOf(level) >= ordering.indexOf(threshold);
}

function parseCount(value: string | undefined, pattern: RegExp): number | undefined {
  const match = value?.match(pattern)?.[1];
  if (!match) {
    return undefined;
  }
  const parsed = Number.parseInt(match, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
