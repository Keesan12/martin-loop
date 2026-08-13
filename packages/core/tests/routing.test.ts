import { describe, expect, it } from "vitest";
import {
  classifyRoute,
  evaluatePreworkBurnPolicy,
  type RouteClassificationInput
} from "../src/routing.js";
import { calculateCostPerOutcome } from "../src/policy.js";

// ---------------------------------------------------------------------------
// classifyRoute
// ---------------------------------------------------------------------------

describe("classifyRoute", () => {
  function input(overrides: Partial<RouteClassificationInput> = {}): RouteClassificationInput {
    return {
      objective: "Fix the off-by-one error in counter.ts",
      verificationPlan: ["npm test"],
      budgetUsd: 2,
      ...overrides
    };
  }

  it("selects direct execution for a simple scoped bug fix", () => {
    const result = classifyRoute(input({
      scopedFileCount: 1,
      allowedPaths: ["src/counter.ts"]
    }));

    expect(result.selectedMode).toBe("direct");
    expect(result.confidence).toBeGreaterThan(0.85);
    expect(result.compressed).toBe(true);
    expect(result.blockedSteps).toContain("manager");
  });

  it("selects manager for a security-sensitive task", () => {
    const result = classifyRoute(input({
      objective: "Refactor the authentication middleware to use JWT tokens instead of session cookies",
      budgetUsd: 8,
      scopedFileCount: 6
    }));

    expect(result.selectedMode).toBe("manager");
    expect(result.confidence).toBeLessThan(0.85);
    expect(result.compressed).toBe(false);
  });

  it("selects consensus for security + migration combined", () => {
    const result = classifyRoute(input({
      objective: "Migrate the authentication database schema and update the credential encryption layer",
      budgetUsd: 15,
      scopedFileCount: 10
    }));

    expect(result.selectedMode).toBe("consensus");
  });

  it("respects forced direct mode in policy", () => {
    const result = classifyRoute(input({
      objective: "Refactor the entire auth system across 20 files",
      budgetUsd: 20,
      policy: { mode: "direct" }
    }));

    expect(result.selectedMode).toBe("direct");
    expect(result.confidence).toBe(1);
    expect(result.blockedSteps).toContain("manager");
    expect(result.blockedSteps).toContain("consensus");
  });

  it("uses historical success rate when available", () => {
    const withHistory = classifyRoute(input({
      historicalDirectSuccessRate: 0.95
    }));
    const withoutHistory = classifyRoute(input());

    // Historical high success should boost confidence
    expect(withHistory.confidence).toBeGreaterThanOrEqual(withoutHistory.confidence);
  });

  it("penalizes multi-file keywords", () => {
    const simple = classifyRoute(input({ objective: "Fix typo in README" }));
    const multiFile = classifyRoute(input({
      objective: "Rename the UserService class across all files in the codebase"
    }));

    expect(simple.confidence).toBeGreaterThan(multiFile.confidence);
  });

  it("estimates lower cost for direct routes than manager routes", () => {
    const direct = classifyRoute(input({ scopedFileCount: 1 }));
    const complex = classifyRoute(input({
      objective: "Refactor the authentication system",
      scopedFileCount: 8,
      budgetUsd: 10
    }));

    expect(direct.expectedCostUsd).toBeLessThan(complex.expectedCostUsd);
  });

  it("produces a compression summary when route is compressed", () => {
    const result = classifyRoute(input({ scopedFileCount: 1 }));

    if (result.compressed) {
      expect(result.compressionSummary).toBeDefined();
      expect(result.compressionSummary!.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// evaluatePreworkBurnPolicy
// ---------------------------------------------------------------------------

describe("evaluatePreworkBurnPolicy", () => {
  it("passes when prework is within both caps", () => {
    const result = evaluatePreworkBurnPolicy(0.5, 5.0, {
      maxPreworkCostUsd: 2.0,
      maxPreworkBudgetPct: 25
    });

    expect(result.exceeded).toBe(false);
  });

  it("blocks when dollar cap is exceeded", () => {
    const result = evaluatePreworkBurnPolicy(2.5, 5.0, {
      maxPreworkCostUsd: 2.0,
      maxPreworkBudgetPct: 80
    });

    expect(result.exceeded).toBe(true);
    expect(result.reason).toContain("$2.50");
    expect(result.reason).toContain("$2.00");
  });

  it("blocks when percentage cap is exceeded", () => {
    const result = evaluatePreworkBurnPolicy(1.5, 3.0, {
      maxPreworkCostUsd: 10.0,
      maxPreworkBudgetPct: 25
    });

    expect(result.exceeded).toBe(true);
    expect(result.reason).toContain("50%");
    expect(result.reason).toContain("25%");
  });

  it("passes when routing policy is disabled", () => {
    const result = evaluatePreworkBurnPolicy(100, 100, { enabled: false });

    expect(result.exceeded).toBe(false);
  });

  it("uses defaults when no policy is provided", () => {
    // Default maxPreworkCostUsd is 2.0, maxPreworkBudgetPct is 25
    const withinDefaults = evaluatePreworkBurnPolicy(0.3, 3.0);
    expect(withinDefaults.exceeded).toBe(false);

    const exceedsDefaults = evaluatePreworkBurnPolicy(3.0, 5.0);
    expect(exceedsDefaults.exceeded).toBe(true);
  });

  it("handles zero total cost without division error", () => {
    const result = evaluatePreworkBurnPolicy(0, 0);
    expect(result.exceeded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// calculateCostPerOutcome
// ---------------------------------------------------------------------------

describe("calculateCostPerOutcome", () => {
  it("returns cost-per-accepted-change for accepted runs", () => {
    const result = calculateCostPerOutcome({
      totalCostUsd: 3.50,
      preworkCostUsd: 1.20,
      attemptCount: 2,
      accepted: true,
      verificationPassed: true
    });

    expect(result.costPerAcceptedChange).toBe(3.50);
    expect(result.costPerAttempt).toBe(1.75);
    expect(result.acceptanceRate).toBe(1);
    expect(result.wastedCoordinationUsd).toBe(1.20);
  });

  it("returns undefined cost-per-accepted-change for rejected runs", () => {
    const result = calculateCostPerOutcome({
      totalCostUsd: 4.00,
      preworkCostUsd: 2.80,
      attemptCount: 3,
      accepted: false,
      verificationPassed: false
    });

    expect(result.costPerAcceptedChange).toBeUndefined();
    expect(result.acceptanceRate).toBe(0);
    // All spend is wasted when not accepted
    expect(result.wastedCoordinationUsd).toBe(4.00);
  });

  it("handles zero attempts without division error", () => {
    const result = calculateCostPerOutcome({
      totalCostUsd: 0,
      preworkCostUsd: 0,
      attemptCount: 0,
      accepted: false,
      verificationPassed: false
    });

    expect(result.costPerAttempt).toBe(0);
  });

  it("rounds dollar values to two decimal places", () => {
    const result = calculateCostPerOutcome({
      totalCostUsd: 1.0 / 3.0,
      preworkCostUsd: 0.1234567,
      attemptCount: 1,
      accepted: true,
      verificationPassed: true
    });

    const costStr = result.costPerAttempt.toString();
    const decimals = costStr.includes(".") ? costStr.split(".")[1]!.length : 0;
    expect(decimals).toBeLessThanOrEqual(2);
  });
});
