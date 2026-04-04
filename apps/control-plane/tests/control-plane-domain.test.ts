import { describe, expect, it } from "vitest";

import {
  createBillingProfile,
  createTelemetryEnvelope,
  createWorkspaceProfile
} from "../lib/domain/models.js";

describe("createWorkspaceProfile", () => {
  it("fills finance-and-ops defaults for a hosted control-plane workspace", () => {
    const workspace = createWorkspaceProfile({
      id: "ws_martin",
      name: "Martin Loop",
      primaryContact: "Morgan Lee",
      billingEmail: "finance@martinloop.dev"
    });

    expect(workspace.plan).toBe("Growth");
    expect(workspace.monthlyBudgetUsd).toBe(45000);
    expect(workspace.seatsUsed).toBe(18);
    expect(workspace.seatsTotal).toBe(25);
  });
});

describe("createBillingProfile", () => {
  it("creates a forecast-ready billing model with a default seat utilization", () => {
    const billing = createBillingProfile({
      workspaceId: "ws_martin",
      planName: "Growth Control Plane",
      monthlyCommitUsd: 12000,
      forecastSpendUsd: 10840,
      realizedSavingsUsd: 28760
    });

    expect(billing.paymentStatus).toBe("Healthy");
    expect(billing.seatUtilizationPct).toBe(72);
    expect(billing.invoices).toHaveLength(0);
  });
});

describe("createTelemetryEnvelope", () => {
  it("normalizes telemetry loops and computes aggregate actual and avoided spend", () => {
    const envelope = createTelemetryEnvelope(
      {
        workspaceId: "ws_martin",
        source: "sdk",
        loops: [
          {
            loopId: "loop_1",
            name: "Invoice reconciliation",
            project: "finance-close",
            ownerTeam: "Finance Systems",
            agentCount: 4,
            status: "watch",
            actualCostUsd: 142,
            avoidedCostUsd: 318,
            tokensProcessed: 182000,
            lastSeenAt: "2026-03-27T13:00:00.000Z"
          },
          {
            loopId: "loop_2",
            name: "Contract variance review",
            project: "revops",
            ownerTeam: "Operations",
            agentCount: 3,
            status: "healthy",
            actualCostUsd: 84,
            avoidedCostUsd: 190,
            tokensProcessed: 104000,
            lastSeenAt: "2026-03-27T13:05:00.000Z"
          }
        ]
      },
      "2026-03-27T13:10:00.000Z"
    );

    expect(envelope.submittedAt).toBe("2026-03-27T13:10:00.000Z");
    expect(envelope.totalActualUsd).toBe(226);
    expect(envelope.totalAvoidedUsd).toBe(508);
    expect(envelope.loops[0]?.savingsRatio).toBeCloseTo(2.24, 2);
  });
});
