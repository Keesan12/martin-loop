// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  runRedPhase,
  buildRedFindings,
  shouldAcceptPatch,
  type MockModelClient
} from "../src/red-blue/red-phase.js";
import { resolveRedBudgetPolicy } from "../src/red-blue/risk-tiers.js";

const mockPatch = {
  patchId: "test-patch-001",
  diff: "+const x = 1;",
  changedFiles: ["src/index.ts"]
};

describe("Red/Blue Control Plane (SLICE-01-A)", () => {

  it("baseline task: Red phase runs programmatic probes only, no model call", async () => {
    const findings = await runRedPhase(mockPatch, "baseline", 0.05);
    expect(findings.modelCallMade).toBe(false);
    expect(findings.modelUsed).toBeUndefined();
    expect(findings.riskTier).toBe("baseline");
    expect(typeof findings.probesRun).toBe("number");
    expect(findings.probesRun).toBeGreaterThan(0);
  });

  it("high-risk task: Red phase runs paranoid scan, no model call", async () => {
    const findings = await runRedPhase(mockPatch, "high_risk", 0.05);
    expect(findings.modelCallMade).toBe(false);
    expect(findings.modelUsed).toBeUndefined();
    expect(findings.riskTier).toBe("high_risk");
    expect(findings.probesRun).toBeGreaterThan(0);
  });

  it("release-critical task: Red phase permits one Haiku call", async () => {
    const mockClient: MockModelClient = {
      complete: vi.fn().mockResolvedValue({ findings: [], tokensUsed: 100, costUsd: 0.001 })
    };
    const findings = await runRedPhase(mockPatch, "release_critical", 0.05, { modelClient: mockClient });
    expect(findings.modelCallMade).toBe(true);
    expect(findings.modelUsed).toBe("claude-haiku-4-5-20251001");
    expect(mockClient.complete).toHaveBeenCalledTimes(1);
  });

  it("unresolved Red finding with severity=block prevents patch acceptance", () => {
    const findings = buildRedFindings({
      riskTier: "baseline",
      findings: [{ trapId: "T01", severity: "block", description: "assertion deleted" }]
    });
    expect(shouldAcceptPatch(findings)).toBe(false);
  });

  it("Red findings are emitted into ledger events array after phase completes", async () => {
    const ledgerEvents: unknown[] = [];
    await runRedPhase(mockPatch, "baseline", 0.05, {
      onLedgerEvent: (event) => { ledgerEvents.push(event); }
    });
    expect(ledgerEvents.some((e: any) => e.type === "red_phase_findings")).toBe(true);
  });

  it("settlement: accepted patch has zero block-severity findings", () => {
    const findings = buildRedFindings({ riskTier: "baseline", findings: [] });
    expect(shouldAcceptPatch(findings)).toBe(true);
  });

});

describe("Risk tier budget policy", () => {

  it("baseline budget cap is 30% of Blue", () => {
    const policy = resolveRedBudgetPolicy("baseline", 1.00);
    expect(policy.redBudgetCapUsd).toBeCloseTo(0.30, 5);
    expect(policy.modelCallAllowed).toBe(false);
  });

  it("high_risk budget cap is 100% of Blue", () => {
    const policy = resolveRedBudgetPolicy("high_risk", 1.00);
    expect(policy.redBudgetCapUsd).toBeCloseTo(1.00, 5);
    expect(policy.modelCallAllowed).toBe(false);
  });

  it("release_critical budget cap is 150% of Blue and model is allowed", () => {
    const policy = resolveRedBudgetPolicy("release_critical", 1.00);
    expect(policy.redBudgetCapUsd).toBeCloseTo(1.50, 5);
    expect(policy.modelCallAllowed).toBe(true);
  });

});
