import {
  createInMemoryControlPlaneRepository,
  resetControlPlaneRepository,
  setControlPlaneRepositoryForTests,
  type ControlPlaneRepository,
  type RunGraph
} from "../lib/server/control-plane-repository.js";
import { setControlPlaneAuthResolverForTests } from "../lib/server/auth.js";

export async function installSeedRepository(): Promise<ControlPlaneRepository> {
  const repository = createInMemoryControlPlaneRepository();
  const now = "2026-04-02T12:00:00.000Z";

  await repository.upsertWorkspace({
    id: "ws_martin",
    name: "Martin Loop",
    primaryContact: "Morgan Lee",
    billingEmail: "finance@martinloop.dev",
    plan: "Growth Control Plane",
    monthlyBudgetUsd: 12000,
    seatsUsed: 3,
    seatsTotal: 10,
    region: "North America",
    renewalDate: "2026-07-01",
    operatingCadence: "Weekly control review",
    createdAt: now,
    updatedAt: now
  });

  await repository.replacePolicies("ws_martin", [
    {
      id: "policy_default",
      workspaceId: "ws_martin",
      name: "Balanced Runtime",
      scope: "Workspace default",
      owner: "Runtime Ops",
      status: "Active",
      monthlyBudgetUsd: 12000,
      maxIterations: 5,
      fallbackModel: "gpt-5.4-mini",
      alertThresholdPct: 70,
      autoStopAfterMinutes: 15,
      description: "Default budget and escalation policy.",
      provenance: "workspace_policy",
      createdAt: now,
      updatedAt: now
    }
  ]);

  const runGraph: RunGraph = {
    run: {
      runId: "run_001",
      workspaceId: "ws_martin",
      projectId: "proj_finops",
      title: "Repair flaky CI",
      objective: "Restore the verification gate.",
      repoRoot: "C:/repo",
      status: "completed",
      lifecycleState: "completed",
      stopReason: "Task verified.",
      activeModel: "gpt-5.4-mini",
      adapterId: "agent:codex",
      providerId: "openai",
      transport: "cli",
      actualUsd: 2.4,
      estimatedUsd: 2.8,
      costProvenance: "actual",
      modeledAvoidedUsd: 5.6,
      tokensIn: 420,
      tokensOut: 180,
      attemptsCount: 2,
      keptAttempts: 1,
      discardedAttempts: 1,
      latestPatchDecision: "KEEP",
      latestPatchSummary: "Patch kept. Reasons: verifier_passed. Attempt summary: Applied the targeted CI fix.",
      latestPatchReasonCodes: ["verifier_passed"],
      latestPatchScore: 0.92,
      groundingViolationCount: 1,
      groundingContentOnlyCount: 0,
      blockedSafetyViolationCount: 1,
      lastSafetySurface: "filesystem",
      budgetVarianceUsd: -0.4,
      accountingMode: "actual",
      createdAt: "2026-04-02T10:00:00.000Z",
      updatedAt: "2026-04-02T10:05:00.000Z"
    },
    attempts: [
      {
        runId: "run_001",
        attemptIndex: 1,
        adapterId: "agent:codex",
        providerId: "openai",
        model: "gpt-5.4-mini",
        transport: "cli",
        status: "failed",
        summary: "First patch missed the flaky branch.",
        failureClass: "verifier_failed",
        intervention: "tighten_scope",
        verifierPassed: false,
        verificationSummary: "pnpm test still failed.",
        patchDecision: "DISCARD",
        patchSummary:
          "Patch discarded. Reasons: grounding_failure. Attempt summary: First patch referenced the wrong module.",
        patchReasonCodes: ["grounding_failure"],
        patchScore: -0.41,
        groundingViolationCount: 1,
        groundingContentOnly: false,
        groundingResolvedFiles: ["packages/core/src/index.ts"],
        safetyViolationCount: 1,
        safetySurface: "filesystem",
        safetyBlocked: true,
        safetyProfile: "ci_safe",
        budgetActualUsd: 1.1,
        budgetEstimatedUsd: 1.4,
        budgetVarianceUsd: -0.3,
        budgetProvenance: "actual",
        startedAt: "2026-04-02T10:00:01.000Z",
        completedAt: "2026-04-02T10:01:00.000Z"
      },
      {
        runId: "run_001",
        attemptIndex: 2,
        adapterId: "agent:codex",
        providerId: "openai",
        model: "gpt-5.4-mini",
        transport: "cli",
        status: "completed",
        summary: "Applied the targeted CI fix.",
        failureClass: null,
        intervention: null,
        verifierPassed: true,
        verificationSummary: "pnpm test passed.",
        patchDecision: "KEEP",
        patchSummary: "Patch kept. Reasons: verifier_passed. Attempt summary: Applied the targeted CI fix.",
        patchReasonCodes: ["verifier_passed"],
        patchScore: 0.92,
        groundingViolationCount: 0,
        groundingContentOnly: false,
        groundingResolvedFiles: [],
        safetyViolationCount: 0,
        safetySurface: null,
        safetyBlocked: false,
        safetyProfile: null,
        budgetActualUsd: 1.3,
        budgetEstimatedUsd: 1.4,
        budgetVarianceUsd: -0.1,
        budgetProvenance: "actual",
        startedAt: "2026-04-02T10:02:00.000Z",
        completedAt: "2026-04-02T10:05:00.000Z"
      }
    ],
    events: [
      {
        eventId: "run_001:attempt_1:grounding",
        runId: "run_001",
        attemptIndex: 1,
        kind: "grounding.violations_found",
        lifecycleState: null,
        timestamp: "2026-04-02T10:01:00.000Z",
        payload: {
          violationCount: 1,
          resolvedFiles: ["packages/core/src/index.ts"],
          contentOnly: false,
          violations: [
            {
              kind: "symbol_not_found",
              detail: "Missing helper symbol referenced in the first patch."
            }
          ]
        }
      },
      {
        eventId: "run_001:attempt_1:safety",
        runId: "run_001",
        attemptIndex: 1,
        kind: "safety.violations_found",
        lifecycleState: null,
        timestamp: "2026-04-02T10:01:00.000Z",
        payload: {
          surface: "filesystem",
          blocked: true,
          profile: "ci_safe",
          violations: [
            {
              kind: "patch_outside_allowed_paths",
              detail: "Attempt touched a denied path."
            }
          ]
        }
      },
      {
        eventId: "run_001:attempt_1:discarded",
        runId: "run_001",
        attemptIndex: 1,
        kind: "attempt.discarded",
        lifecycleState: null,
        timestamp: "2026-04-02T10:01:00.000Z",
        payload: {
          decision: "DISCARD",
          reason:
            "Patch discarded. Reasons: grounding_failure. Attempt summary: First patch referenced the wrong module.",
          reasonCodes: ["grounding_failure"],
          score: -0.41
        }
      },
      {
        eventId: "run_001:attempt_2:kept",
        runId: "run_001",
        attemptIndex: 2,
        kind: "attempt.kept",
        lifecycleState: null,
        timestamp: "2026-04-02T10:05:00.000Z",
        payload: {
          decision: "KEEP",
          reason: "Patch kept. Reasons: verifier_passed. Attempt summary: Applied the targeted CI fix.",
          reasonCodes: ["verifier_passed"],
          score: 0.92
        }
      },
      {
        eventId: "run_001:run.exited",
        runId: "run_001",
        attemptIndex: null,
        kind: "run.exited",
        lifecycleState: "completed",
        timestamp: "2026-04-02T10:05:00.000Z",
        payload: { lifecycleState: "completed", reason: "Task verified." }
      }
    ],
    violations: [
      {
        violationId: "vio_001",
        runId: "run_001",
        attemptIndex: 1,
        surface: "filesystem",
        blocked: true,
        violationKind: "safety.violations_found",
        detail: "Attempt touched a denied path.",
        createdAt: "2026-04-02T10:01:00.000Z"
      }
    ],
    budgetMetrics: [
      {
        metricId: "metric_001",
        runId: "run_001",
        attemptIndex: 1,
        actualUsd: 1.1,
        estimatedUsd: 1.4,
        provenance: "actual",
        patchCostUsd: 0.8,
        verificationCostUsd: 0.3,
        varianceUsd: -0.3,
        tokensIn: 200,
        tokensOut: 80,
        createdAt: "2026-04-02T10:01:00.000Z"
      },
      {
        metricId: "metric_002",
        runId: "run_001",
        attemptIndex: 2,
        actualUsd: 1.3,
        estimatedUsd: 1.4,
        provenance: "actual",
        patchCostUsd: 0.9,
        verificationCostUsd: 0.4,
        varianceUsd: -0.1,
        tokensIn: 220,
        tokensOut: 100,
        createdAt: "2026-04-02T10:05:00.000Z"
      }
    ]
  };

  await repository.replaceRunGraph(runGraph);
  setControlPlaneRepositoryForTests(repository);
  return repository;
}

export function installAuthSession(options: {
  authenticated?: boolean;
  userId?: string | null;
  role?: "admin" | "workspace";
  workspaceId?: string;
} = {}): void {
  const {
    authenticated = true,
    userId = authenticated ? "user_123" : null,
    role = "workspace",
    workspaceId = "ws_martin"
  } = options;

  setControlPlaneAuthResolverForTests(async () => ({
    isAuthenticated: authenticated,
    userId,
    sessionId: authenticated ? "sess_123" : null,
    sessionClaims: authenticated
      ? {
          metadata: {
            martinRole: role,
            workspaceId
          }
        }
      : undefined
  }));
}

export function resetControlPlaneTestState(): void {
  setControlPlaneRepositoryForTests(null);
  resetControlPlaneRepository();
  setControlPlaneAuthResolverForTests(null);
}
