import type { VerifiedHandoffV1 } from "@martin/contracts";
import { describe, expect, it } from "vitest";

import {
  buildGovernedPlanStages,
  renderGovernedRunPlan,
  renderVerifiedHandoff,
  stripAnsi,
  type GovernedRunPlanView
} from "../src/index.js";

const plan: GovernedRunPlanView = {
  ready: true,
  task: "Repair Windows updater without changing governed truth",
  engine: "codex",
  mode: "live",
  budget: {
    maxUsd: 10,
    softLimitUsd: 8,
    maxIterations: 4,
    maxTokens: 100000
  },
  verifier: [
    "C:\\Users\\Example\\Projects\\MartinLoop\\scripts\\verify.ps1"
  ],
  receiptScope: {
    repoRoot:
      "C:\\Users\\Example\\Projects\\MartinLoop"
  },
  policyProfile: "default",
  blockingIssues: [],
  warnings: [],
  stages: []
};
plan.stages = buildGovernedPlanStages(plan);

function handoff(outcome: VerifiedHandoffV1["outcome"]): VerifiedHandoffV1 {
  return {
    schemaVersion: "1.0.0",
    handoffId: "handoff_loop_fixture",
    loopId: "loop_fixture",
    generatedAt: "2026-08-17T00:00:00.000Z",
    task: {
      title: "Repair updater",
      objective: "Repair Windows updater without changing governed truth"
    },
    definitionOfDone: {
      acceptanceCriteria: ["Windows updater launches safely"],
      verificationPlan: ["pnpm test"]
    },
    outcome,
    sourceStatus: {
      status: outcome === "VERIFIED" ? "completed" : "failed",
      lifecycleState:
        outcome === "VERIFIED" ? "completed" : "human_escalation"
    },
    verification: {
      status: outcome === "VERIFIED" ? "PASSED" : "NOT_RUN",
      summary:
        outcome === "VERIFIED"
          ? "All configured completion evidence passed."
          : "Completion was not established.",
      checks: [
        {
          command: "pnpm test",
          status: outcome === "VERIFIED" ? "PASSED" : "NOT_RUN"
        }
      ],
      warnings: []
    },
    requirements: [],
    scope: {
      status: "WITHIN_SCOPE",
      allowedPaths: ["packages/cli"],
      deniedPaths: [],
      changedFiles: ["packages/cli/src/updater.ts"],
      violations: []
    },
    testIntegrity: {
      verdict: "VERIFIED",
      status: "UNCHANGED",
      protectedPaths: [],
      changedProtectedPaths: [],
      findings: [],
      summary: "Protected tests unchanged."
    },
    unresolvedWork:
      outcome === "VERIFIED" ? [] : ["Windows execution proof remains incomplete"],
    ...(outcome === "STOPPED" ? { stopReason: "provider_failure" } : {}),
    recovery: {
      rollbackBoundaryAvailable: true,
      rollbackAttempted: false,
      isolatedRef: "refs/heads/fix/windows-updater",
      nextCommand: "pnpm test",
      summary: "Rollback boundary is available."
    },
    usage: {
      attempts: 2,
      actualUsd: 1.25,
      tokensIn: 1000,
      tokensOut: 500,
      costProvenance: "actual"
    },
    receiptIntegrity: {
      state: "verified",
      loopRecordSha256: "abc123"
    },
    nextAction:
      outcome === "VERIFIED"
        ? "Share the verified handoff."
        : "Inspect the preserved recovery boundary."
  };
}

describe("Governed Run Plan V2", () => {
  it.each([80, 120, 160])("renders truthful data within %i columns", (width) => {
    const rendered = stripAnsi(
      renderGovernedRunPlan(plan, {
        width,
        environment: { color: "always", colorDepth: 24, isTty: true }
      })
    );

    expect(rendered).toContain("GOVERNED RUN PLAN");
    expect(rendered).toContain("Repair Windows updater");
    expect(rendered).toContain("$10.00");
    expect(rendered).not.toContain("$2.80");
    expect(Math.max(...rendered.split("\n").map((line) => line.length))).toBeLessThanOrEqual(
      width
    );
  });

  it("renders blocked issues from the real view", () => {
    const blocked = {
      ...plan,
      ready: false,
      blockingIssues: ["Configured verifier is unavailable"]
    };
    blocked.stages = buildGovernedPlanStages(blocked);

    const rendered = stripAnsi(renderGovernedRunPlan(blocked));
    expect(rendered).toContain("PREFLIGHT BLOCKED");
    expect(rendered).toContain("Configured verifier is unavailable");
  });
});

describe("Verified Handoff V2", () => {
  it.each(["VERIFIED", "NEEDS_REVIEW", "STOPPED"] as const)(
    "renders the real %s outcome",
    (outcome) => {
      const rendered = stripAnsi(renderVerifiedHandoff(handoff(outcome), { width: 80 }));
      expect(rendered).toContain("MARTINLOOP VERIFIED HANDOFF");
      expect(rendered).toContain(outcome.replace("_", " "));
      expect(rendered).toContain("Receipt Integrity");
      expect(rendered).toContain("Rollback boundary is available.");
    }
  );

  it("renders the canonical stop reason and unresolved work", () => {
    const rendered = stripAnsi(renderVerifiedHandoff(handoff("STOPPED"), { width: 120 }));
    expect(rendered).toContain("provider failure");
    expect(rendered).toContain("Windows execution proof remains incomplete");
    expect(rendered).not.toContain("budget exhausted");
  });

  it("keeps NO_COLOR output free of ANSI sequences", () => {
    const rendered = renderVerifiedHandoff(handoff("VERIFIED"), {
      width: 120,
      environment: { color: "auto", isTty: true, noColor: true }
    });
    expect(rendered).not.toContain("\u001b[");
  });
});
