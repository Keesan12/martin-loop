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

export function classifyRoute(input: RouteClassificationInput): RouteDecision {
  const policy = { ...DEFAULT_ROUTING_POLICY, ...input.policy };
  const signals = extractComplexitySignals(input);
  const directConfidence = calculateDirectConfidence(signals, input);

  const reason: string[] = [];
  const blockedSteps: string[] = [];

  // Policy override: forced mode
  if (policy.mode === "direct") {
    return {
      selectedMode: "direct",
      confidence: 1,
      expectedCostUsd: estimateDirectCost(input.budgetUsd),
      expectedPreworkBurnPct: 5,
      reason: ["Policy forces direct execution mode."],
      blockedSteps: ["manager", "planner", "router", "consensus"],
      compressed: true,
      compressionSummary: "Policy: direct mode — skipping all orchestration."
    };
  }

  if (policy.mode === "consensus") {
    return {
      selectedMode: "consensus",
      confidence: 0.5,
      expectedCostUsd: input.budgetUsd * 0.8,
      expectedPreworkBurnPct: 35,
      reason: ["Policy forces consensus mode."],
      blockedSteps: [],
      compressed: false
    };
  }

  // Adaptive routing
  if (directConfidence >= policy.skipOrchestrationIfConfidenceAbove) {
    reason.push(`Direct confidence ${(directConfidence * 100).toFixed(0)}% exceeds threshold ${(policy.skipOrchestrationIfConfidenceAbove * 100).toFixed(0)}%.`);

    if (signals.objectiveLength < 200) reason.push("Short, focused objective.");
    if (signals.fileCount <= 2) reason.push(`Scoped to ${String(signals.fileCount)} file(s).`);
    if (signals.scopeRestricted) reason.push("Path scope is restricted.");
    blockedSteps.push("manager", "consensus");

    return {
      selectedMode: "direct",
      confidence: directConfidence,
      expectedCostUsd: estimateDirectCost(input.budgetUsd),
      expectedPreworkBurnPct: 8,
      reason,
      blockedSteps,
      compressed: true,
      compressionSummary: `Compressed from manager→planner→worker to direct worker. Estimated savings: ${String(Math.round(input.budgetUsd * 0.3 * 100) / 100)} USD.`
    };
  }

  // Complex task — needs orchestration
  if (signals.hasSecurityKeywords) reason.push("Security-sensitive task detected.");
  if (signals.hasMigrationKeywords) reason.push("Migration task detected.");
  if (signals.hasArchitectureKeywords) reason.push("Architectural scope detected.");
  if (signals.fileCount > 5) reason.push(`Touches ${String(signals.fileCount)}+ files.`);

  const needsConsensus = signals.hasSecurityKeywords && signals.hasMigrationKeywords;

  return {
    selectedMode: needsConsensus ? "consensus" : "manager",
    confidence: directConfidence,
    expectedCostUsd: input.budgetUsd * (needsConsensus ? 0.8 : 0.6),
    expectedPreworkBurnPct: needsConsensus ? 40 : 25,
    reason,
    blockedSteps: needsConsensus ? [] : ["consensus"],
    compressed: false
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
