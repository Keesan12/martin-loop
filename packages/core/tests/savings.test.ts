import { describe, expect, it } from "vitest";

import { calculateAvoidedUsd } from "../src/savings";

describe("calculateAvoidedUsd", () => {
  it("returns positive justified savings when a comparable uncontrolled baseline is present", () => {
    expect(
      calculateAvoidedUsd({
        lifecycleState: "completed",
        actualUsd: 1.23,
        uncontrolledBaselineUsd: 3.45
      })
    ).toBe(2.22);
  });

  it("returns zero when no justified baseline exists", () => {
    expect(calculateAvoidedUsd({ lifecycleState: "completed", actualUsd: 1.23 })).toBe(0);
  });

  it("returns zero for non-completed runs", () => {
    expect(
      calculateAvoidedUsd({
        lifecycleState: "budget_exit",
        actualUsd: 1,
        uncontrolledBaselineUsd: 5
      })
    ).toBe(0);
  });

  it("returns zero for non-completed rollback or escalation outcomes", () => {
    expect(
      calculateAvoidedUsd({
        lifecycleState: "stuck_exit",
        actualUsd: 1,
        uncontrolledBaselineUsd: 5
      })
    ).toBe(0);
    expect(
      calculateAvoidedUsd({
        lifecycleState: "human_escalation",
        actualUsd: 1,
        uncontrolledBaselineUsd: 5
      })
    ).toBe(0);
  });

  it("does not double-count retry spend", () => {
    expect(
      calculateAvoidedUsd({
        lifecycleState: "completed",
        actualUsd: 4,
        uncontrolledBaselineUsd: 6
      })
    ).toBe(2);
  });
});
