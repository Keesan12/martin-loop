/**
 * Route classification and compression for governed agent runs.
 *
 * Decides whether a task needs manager/planner orchestration or can go
 * directly to a worker, based on task complexity signals. Prevents
 * wasted coordination cost (Pre Work Burn) on simple tasks.
 */

import type { RoutingMode, RoutingPolicy } from "@martin/contracts";
import { DEFAULT_ROUTING_POLICY } from "@martin/contracts";

// ---------------------------------------------------------------------------
// Route decision
// ---------------------------------------------------------------------------

export interface RouteDecision {
  selectedMode: RoutingMode;
  confidence: number;
  expectedCostUsd: number;
  expectedPreworkBurnPct: number;
  reason: string[];
  blockedSteps: string[];
  compressed: boolean;
  compressionSummary?: string;
  /**
   * Recommended model tier based on task complexity and route.
   * Follows cost-aware routing: direct → haiku/sonnet, manager → sonnet,
   * consensus → opus. Never use a more expensive model than the task needs.
   */
  recommendedModelTier: "haiku" | "sonnet" | "opus";
  /** Estimated cost saving vs always using sonnet */
  estimatedSavingVsSonnetUsd: number;
}

export interface RouteClassificationInput {
  objective: string;
  verificationPlan: string[];
  repoRoot?: string;
  allowedPaths?: string[];
  deniedPaths?: string[];
  budgetUsd: number;
  policy?: Partial<RoutingPolicy>;
  /** Number of files the task references or is scoped to. */
  scopedFileCount?: number;
  /** Historical success rate for similar tasks with direct execution (0-1). */
  historicalDirectSuccessRate?: number;
}

// ---------------------------------------------------------------------------
// Complexity signals
// ---------------------------------------------------------------------------

interface ComplexitySignals {
  objectiveLength: number;
  fileCount: number;
  hasSecurityKeywords: boolean;
  hasArchitectureKeywords: boolean;
  hasMigrationKeywords: boolean;
  hasMultiFileKeywords: boolean;
  verifierCount: number;
  budgetUsd: number;
  scopeRestricted: boolean;
}

const SECURITY_KEYWORDS = [
  "auth", "authentication", "authorization", "credential", "secret",
  "token", "password", "oauth", "jwt", "session", "csrf", "xss",
  "injection", "encryption", "certificate", "tls", "ssl", "permission"
];

const ARCHITECTURE_KEYWORDS = [
  "refactor", "architecture", "redesign", "restructure", "migration",
  "database schema", "api design", "service boundary", "microservice",
  "event sourcing", "cqrs", "distributed"
];

const MIGRATION_KEYWORDS = [
  "migration", "migrate", "upgrade", "downgrade", "schema change",
  "data migration", "database migration", "breaking change"
];

const MULTI_FILE_KEYWORDS = [
  "across", "all files", "every file", "codebase-wide", "global",
  "rename everywhere", "update all", "system-wide"
];

function extractComplexitySignals(input: RouteClassificationInput): ComplexitySignals {
  const lower = input.objective.toLowerCase();
  return {
    objectiveLength: input.objective.length,
    fileCount: input.scopedFileCount ?? estimateFileCount(input),
    hasSecurityKeywords: SECURITY_KEYWORDS.some((kw) => lower.includes(kw)),
    hasArchitectureKeywords: ARCHITECTURE_KEYWORDS.some((kw) => lower.includes(kw)),
    hasMigrationKeywords: MIGRATION_KEYWORDS.some((kw) => lower.includes(kw)),
    hasMultiFileKeywords: MULTI_FILE_KEYWORDS.some((kw) => lower.includes(kw)),
    verifierCount: input.verificationPlan.length,
    budgetUsd: input.budgetUsd,
    scopeRestricted: (input.allowedPaths?.length ?? 0) > 0 || (input.deniedPaths?.length ?? 0) > 0
  };
}

function estimateFileCount(input: RouteClassificationInput): number {
  const pathCount = (input.allowedPaths?.length ?? 0) + (input.deniedPaths?.length ?? 0);
  if (pathCount > 0) return pathCount;

  // Heuristic: short objectives with specific file refs → 1-2 files
  const fileRefs = input.objective.match(/[\w/.-]+\.\w{1,5}/g);
  return fileRefs?.length ?? 1;
}

// ---------------------------------------------------------------------------
// Confidence scoring
// ---------------------------------------------------------------------------

function calculateDirectConfidence(signals: ComplexitySignals, input: RouteClassificationInput): number {
  let confidence = 0.7; // Base: most tasks can go direct

  // Boost for simple tasks
  if (signals.objectiveLength < 200) confidence += 0.1;
  if (signals.fileCount <= 2) confidence += 0.1;
  if (signals.scopeRestricted) confidence += 0.05;
  if (signals.verifierCount === 1) confidence += 0.05;

  // Penalize for complex tasks
  if (signals.hasSecurityKeywords) confidence -= 0.25;
  if (signals.hasArchitectureKeywords) confidence -= 0.2;
  if (signals.hasMigrationKeywords) confidence -= 0.3;
  if (signals.hasMultiFileKeywords) confidence -= 0.15;
  if (signals.objectiveLength > 500) confidence -= 0.1;
  if (signals.fileCount > 5) confidence -= 0.15;
  if (signals.budgetUsd > 10) confidence -= 0.1;

  // Historical evidence
  if (input.historicalDirectSuccessRate !== undefined) {
    confidence = confidence * 0.6 + input.historicalDirectSuccessRate * 0.4;
  }

  return Math.max(0, Math.min(1, confidence));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cost-aware model tier routing
//
// Engine-agnostic tier system. Delegated CLIs may own concrete model choice.
// Never pay for reasoning/orchestration on simple tasks.
//
// Codex is intentionally not mapped to a concrete model: account and workspace
// entitlements vary, so the authenticated CLI selects its compatible default.
//
// Pricing reference (USD per 1M tokens, approx 2026):
//   haiku:  $0.80 input / $4.00 output  (~1x baseline)
//   sonnet: $3.00 input / $15.00 output (~4x haiku)
//   opus:   $15.00 input / $75.00 output (~19x haiku)
// ---------------------------------------------------------------------------

const SONNET_AVG_COST_PER_USD_BUDGET = 0.35; // sonnet uses ~35% of budget on average
const HAIKU_AVG_COST_PER_USD_BUDGET = 0.10;  // haiku uses ~10% — ~3.5x cheaper

function selectModelTier(
  mode: "direct" | "manager" | "consensus"
): RouteDecision["recommendedModelTier"] {
  // Route already encodes complexity. Direct = passed the simplicity check → haiku.
  if (mode === "direct") return "haiku";
  if (mode === "manager") return "sonnet";
  return "opus";
}

/**
 * Resolve a tier to a concrete model ID when the engine accepts provider model IDs.
 * Returns undefined when Codex or an OpenAI-compatible adapter owns model selection.
 * Callers may still pass an explicit model directly to the selected adapter.
 */
export function resolveModelForTier(
  tier: RouteDecision["recommendedModelTier"],
  engine: "claude" | "codex" | "gemini" | "openai" | string
): string | undefined {
  const engineKey = engine.toLowerCase().split("-")[0] ?? engine;
  if (engineKey === "codex" || engineKey === "openai") return undefined;

  const matrix: Record<string, Record<string, string>> = {
    claude: {
      haiku:  "claude-haiku-4-5-20251001",
      sonnet: "claude-sonnet-4-6",
      opus:   "claude-opus-4-6"
    },
    gemini: {
      haiku:  "gemini-2.5-flash",
      sonnet: "gemini-2.5-pro",
      opus:   "gemini-2.5-ultra"
    },
    deepseek: {
      haiku:  "deepseek-chat",
      sonnet: "deepseek-r1",
      opus:   "deepseek-r1"
    },
    qwen: {
      haiku:  "qwen/qwen3-8b",
      sonnet: "qwen/qwen3-32b",
      opus:   "qwen/qwen3-235b-a22b"
    },
    llama: {
      haiku:  "meta-llama/llama-3.1-8b-instruct",
      sonnet: "meta-llama/llama-3.3-70b-instruct",
      opus:   "meta-llama/llama-3.1-405b-instruct"
    }
  };

  const claudeMatrix = matrix.claude;
  return matrix[engineKey]?.[tier] ?? claudeMatrix?.[tier] ?? "claude-sonnet-4-6";
}

function estimateSavingVsSonnet(tier: RouteDecision["recommendedModelTier"], budgetUsd: number): number {
  if (tier === "sonnet") return 0;
  if (tier === "haiku") return Math.round((SONNET_AVG_COST_PER_USD_BUDGET - HAIKU_AVG_COST_PER_USD_BUDGET) * budgetUsd * 100) / 100;
  // opus costs more than sonnet — negative saving
  return Math.round(-1 * SONNET_AVG_COST_PER_USD_BUDGET * budgetUsd * 0.5 * 100) / 100;
}

/**
 * Available engine registry — describes what's installed and its capability.
 * Populated by doctor/preflight from PATH and env var detection.
 */
export interface AvailableEngine {
  id: string;
  available: boolean;
  /** Cost tier: cheap < mid < expensive */
  costTier: "cheap" | "mid" | "expensive";
  /** Capability tier: determines which task types this engine can handle */
  capabilityTier: "haiku" | "sonnet" | "opus";
}


/**
 * Select the best available engine for a given tier requirement.
 *
 * When multiple engines are available, picks the cheapest that meets
 * the capability requirement. Falls back gracefully:
 * - If required tier unavailable, upgrades to next tier of same engine
 * - If only one engine family available, uses its best equivalent
 *
 * @param requiredTier - Minimum capability tier needed
 * @param availableEngines - What's installed and authenticated
 * @returns Best engine ID and concrete model to use
 */
export function selectBestEngine(
  requiredTier: RouteDecision["recommendedModelTier"],
  availableEngines: AvailableEngine[]
): { engineId: string; model?: string; reasoning: string } {
  const available = availableEngines.filter((e) => e.available);

  if (available.length === 0) {
    // Nothing detected — default to claude (user must install)
    return {
      engineId: "claude",
      model: resolveModelForTier(requiredTier, "claude")!,
      reasoning: "No engines detected. Defaulting to claude. Run martin doctor for setup instructions."
    };
  }

  const tierRank: Record<AvailableEngine["capabilityTier"], number> = {
    haiku: 0, sonnet: 1, opus: 2
  };
  const requiredRank = tierRank[requiredTier];

  // Find the cheapest engine that meets or exceeds the required tier
  const eligible = available
    .filter((e) => tierRank[e.capabilityTier] >= requiredRank)
    .sort((a, b) => {
      // Sort by cost (cheap first), then by exact tier match
      const costOrder: Record<AvailableEngine["costTier"], number> = { cheap: 0, mid: 1, expensive: 2 };
      if (costOrder[a.costTier] !== costOrder[b.costTier]) {
        return costOrder[a.costTier] - costOrder[b.costTier];
      }
      // Prefer exact tier match over overqualified
      const aExact = a.capabilityTier === requiredTier ? 0 : 1;
      const bExact = b.capabilityTier === requiredTier ? 0 : 1;
      return aExact - bExact;
    });

  if (eligible.length > 0) {
    const best = eligible[0]!;
    const model = resolveModelForTier(requiredTier, best.id);
    const modelLabel = model ?? "authenticated default";
    return {
      engineId: best.id,
      ...(model ? { model } : {}),
      reasoning: `Selected ${best.id} (${modelLabel}) as cheapest available engine for ${requiredTier}-tier task.`
    };
  }

  // All available engines are below required tier — upgrade to best available
  const best = available.sort((a, b) => tierRank[b.capabilityTier] - tierRank[a.capabilityTier])[0]!;
  const model = resolveModelForTier(best.capabilityTier, best.id);
  const modelLabel = model ?? "authenticated default";
  return {
    engineId: best.id,
    ...(model ? { model } : {}),
    reasoning: `No ${requiredTier}-tier engine available. Upgrading to ${best.id} (${modelLabel}) — best available.`
  };
}

export function classifyRoute(input: RouteClassificationInput): RouteDecision {
  const policy = { ...DEFAULT_ROUTING_POLICY, ...input.policy };
  const signals = extractComplexitySignals(input);
  const directConfidence = calculateDirectConfidence(signals, input);

  const reason: string[] = [];
  const blockedSteps: string[] = [];

  // Policy override: forced mode
  if (policy.mode === "direct") {
    const tier = selectModelTier("direct");
    return {
      selectedMode: "direct",
      confidence: 1,
      expectedCostUsd: estimateDirectCost(input.budgetUsd),
      expectedPreworkBurnPct: 5,
      reason: ["Policy forces direct execution mode."],
      blockedSteps: ["manager", "planner", "router", "consensus"],
      compressed: true,
      compressionSummary: "Policy: direct mode — skipping all orchestration.",
      recommendedModelTier: tier,
      estimatedSavingVsSonnetUsd: estimateSavingVsSonnet(tier, input.budgetUsd)
    };
  }

  if (policy.mode === "consensus") {
    const tier = selectModelTier("consensus");
    return {
      selectedMode: "consensus",
      confidence: 0.5,
      expectedCostUsd: input.budgetUsd * 0.8,
      expectedPreworkBurnPct: 35,
      reason: ["Policy forces consensus mode."],
      blockedSteps: [],
      compressed: false,
      recommendedModelTier: tier,
      estimatedSavingVsSonnetUsd: estimateSavingVsSonnet(tier, input.budgetUsd)
    };
  }

  // Adaptive routing
  if (directConfidence >= policy.skipOrchestrationIfConfidenceAbove) {
    reason.push(`Direct confidence ${(directConfidence * 100).toFixed(0)}% exceeds threshold ${(policy.skipOrchestrationIfConfidenceAbove * 100).toFixed(0)}%.`);

    if (signals.objectiveLength < 200) reason.push("Short, focused objective.");
    if (signals.fileCount <= 2) reason.push(`Scoped to ${String(signals.fileCount)} file(s).`);
    if (signals.scopeRestricted) reason.push("Path scope is restricted.");
    blockedSteps.push("manager", "consensus");

    const tier = selectModelTier("direct");
    return {
      selectedMode: "direct",
      confidence: directConfidence,
      expectedCostUsd: estimateDirectCost(input.budgetUsd),
      expectedPreworkBurnPct: 8,
      reason,
      blockedSteps,
      compressed: true,
      compressionSummary: `Compressed from manager→planner→worker to direct worker. Estimated savings: ${String(Math.round(input.budgetUsd * 0.3 * 100) / 100)} USD.`,
      recommendedModelTier: tier,
      estimatedSavingVsSonnetUsd: estimateSavingVsSonnet(tier, input.budgetUsd)
    };
  }

  // Complex task — needs orchestration
  if (signals.hasSecurityKeywords) reason.push("Security-sensitive task detected.");
  if (signals.hasMigrationKeywords) reason.push("Migration task detected.");
  if (signals.hasArchitectureKeywords) reason.push("Architectural scope detected.");
  if (signals.fileCount > 5) reason.push(`Touches ${String(signals.fileCount)}+ files.`);

  const needsConsensus = signals.hasSecurityKeywords && signals.hasMigrationKeywords;
  const mode = needsConsensus ? "consensus" : "manager";
  const tier = selectModelTier(mode);

  return {
    selectedMode: mode,
    confidence: directConfidence,
    expectedCostUsd: input.budgetUsd * (needsConsensus ? 0.8 : 0.6),
    expectedPreworkBurnPct: needsConsensus ? 40 : 25,
    reason,
    blockedSteps: needsConsensus ? [] : ["consensus"],
    compressed: false,
    recommendedModelTier: tier,
    estimatedSavingVsSonnetUsd: estimateSavingVsSonnet(tier, input.budgetUsd)
  };
}

function estimateDirectCost(budgetUsd: number): number {
  // Direct execution typically uses 30-50% of budget
  return Math.round(budgetUsd * 0.35 * 100) / 100;
}

/**
 * Checks whether a run's Pre Work Burn exceeds the routing policy limits.
 * Returns a block reason if exceeded, undefined if within bounds.
 */
export function evaluatePreworkBurnPolicy(
  preworkCostUsd: number,
  totalCostUsd: number,
  policy: Partial<RoutingPolicy> = {}
): { exceeded: boolean; reason?: string } {
  const resolved = { ...DEFAULT_ROUTING_POLICY, ...policy };

  if (!resolved.enabled) {
    return { exceeded: false };
  }

  if (preworkCostUsd > resolved.maxPreworkCostUsd) {
    return {
      exceeded: true,
      reason: `Pre-work cost $${preworkCostUsd.toFixed(2)} exceeds routing policy cap of $${resolved.maxPreworkCostUsd.toFixed(2)}.`
    };
  }

  const burnPct = totalCostUsd > 0 ? (preworkCostUsd / totalCostUsd) * 100 : 0;
  if (burnPct > resolved.maxPreworkBudgetPct) {
    return {
      exceeded: true,
      reason: `Pre Work Burn at ${burnPct.toFixed(0)}% exceeds routing policy cap of ${String(resolved.maxPreworkBudgetPct)}%.`
    };
  }

  return { exceeded: false };
}
