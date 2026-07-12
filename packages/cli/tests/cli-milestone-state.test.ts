import { afterEach, describe, expect, it, vi } from "vitest";

// Hoisted before imports — intercepts node:fs/promises used inside cli-milestone-state.ts
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(new Error("no state file")),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import { readFile } from "node:fs/promises";

import {
  computeRank,
  deriveSavingsConfidence,
  estimatedUncontrolledUsd,
  nextRank,
  recordRunAndGetPrompt,
  wasRollbackTaken,
  wasVerifierBlocked,
  type MilestoneState,
} from "../src/cli-milestone-state.js";
import type { LoopRecord } from "@martin/contracts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeLoop(overrides: {
  status?: string;
  lifecycleState?: string;
  actualUsd?: number;
  avoidedUsd?: number;
  provenance?: string;
} = {}): LoopRecord {
  return {
    loopId: "test-loop",
    workspaceId: "ws",
    projectId: "proj",
    status: overrides.status ?? "completed",
    lifecycleState: overrides.lifecycleState ?? "completed",
    cost: {
      actualUsd: overrides.actualUsd ?? 0.10,
      avoidedUsd: overrides.avoidedUsd ?? 0.50,
      tokensIn: 100,
      tokensOut: 50,
      provenance: overrides.provenance as "actual" | "estimated" | undefined,
    },
    attempts: [],
    artifacts: [],
    events: [],
    task: { objective: "test", verificationPlan: [] },
    budget: { maxUsd: 1, softLimitUsd: 0.9, maxIterations: 5, maxTokens: 10000 },
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as LoopRecord;
}

function makeState(overrides: Partial<MilestoneState> = {}): MilestoneState {
  return {
    version: 5,
    firstRunAt: null,
    runCount: 0,
    successfulRunCount: 0,
    failedRunCount: 0,
    totalActualSpendUsd: 0,
    totalEstimatedUncontrolledSpendUsd: 0,
    totalSavedUsd: 0,
    savingsConfidence: "unavailable",
    bestRunSavedUsd: null,
    bestRunAt: null,
    reposUsed: [],
    lastRunAt: null,
    dailyStreakDays: 0,
    receiptsGenerated: 0,
    rollbacksTriggered: 0,
    verifierBlocks: 0,
    currentRank: "Observer",
    loopMilestones: { reached: [] },
    streakMilestones: { reached: [] },
    savingsMilestones: { reachedUsd: [] },
    star: { shownCount: 0, confirmed: false },
    feedback: { shownCount: 0, scores: [], featureVotes: [], email: null },
    waitlist: { status: "not_asked", declinedCount: 0, email: null, shownAt: null },
    suppressUntilRun: 0,
    ...overrides,
  };
}

// readFile is mocked to return string — matches the real readFile("utf8") return type
function mockStateFile(state: MilestoneState): void {
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(state));
}

async function runWithTty(input: Parameters<typeof recordRunAndGetPrompt>[0]) {
  const savedCI = process.env["CI"];
  delete process.env["CI"];
  // vi.spyOn requires the property to exist — process.stdout.isTTY is undefined in
  // non-TTY test environments. Object.defineProperty works regardless.
  const savedDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true, writable: true });
  try {
    return await recordRunAndGetPrompt(input);
  } finally {
    if (savedDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", savedDescriptor);
    } else {
      delete (process.stdout as unknown as Record<string, unknown>)["isTTY"];
    }
    if (savedCI !== undefined) process.env["CI"] = savedCI;
  }
}

const BASE_INPUT = {
  success: true,
  repoRoot: "/tmp/test-repo",
  actualSpendUsd: 0.10,
  estimatedUncontrolledUsd: 0.60,
  savingsConfidence: "confirmed" as const,
  rollbackTaken: false,
  verifierBlock: false,
};

afterEach(() => {
  vi.clearAllMocks();
  // Reset readFile default back to "no file" for each test
  vi.mocked(readFile).mockRejectedValue(new Error("no state file"));
});

// ---------------------------------------------------------------------------
// computeRank — all 7 thresholds
// ---------------------------------------------------------------------------

describe("computeRank", () => {
  it.each([
    [0, 0, "Observer"],
    [9, 999, "Observer"],
    [10, 0, "Operator"],
    [24, 9, "Operator"],
    [25, 10, "Engineer"],
    [49, 24, "Engineer"],
    [50, 25, "Architect"],
    [99, 99, "Architect"],
    [100, 100, "Control Plane"],
    [499, 499, "Control Plane"],
    [500, 500, "Infrastructure"],
    [999, 999, "Infrastructure"],
    [1000, 1000, "Legend"],
    [9999, 9999, "Legend"],
  ] as const)("assigns %s runs / $%s saved → %s", (runs, saved, expected) => {
    expect(computeRank(runs, saved)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// nextRank
// ---------------------------------------------------------------------------

describe("nextRank", () => {
  it("returns null for Legend — no higher rank exists", () => {
    expect(nextRank("Legend")).toBeNull();
  });

  it.each([
    ["Observer", "Operator", 10],
    ["Operator", "Engineer", 25],
    ["Engineer", "Architect", 50],
    ["Architect", "Control Plane", 100],
    ["Control Plane", "Infrastructure", 500],
    ["Infrastructure", "Legend", 1000],
  ] as const)("%s → next is %s at %s loops", (current, expectedName, expectedLoops) => {
    const next = nextRank(current);
    expect(next?.name).toBe(expectedName);
    expect(next?.loopsNeeded).toBe(expectedLoops);
  });
});

// ---------------------------------------------------------------------------
// deriveSavingsConfidence
// ---------------------------------------------------------------------------

describe("deriveSavingsConfidence", () => {
  it.each([
    ["actual", "confirmed"],
    ["estimated", "estimated"],
    [undefined, "unavailable"],
  ] as const)("provenance %s → confidence %s", (provenance, expected) => {
    expect(deriveSavingsConfidence(makeLoop({ provenance }))).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// estimatedUncontrolledUsd
// ---------------------------------------------------------------------------

describe("estimatedUncontrolledUsd", () => {
  it("sums actualUsd and avoidedUsd", () => {
    expect(estimatedUncontrolledUsd(makeLoop({ actualUsd: 0.20, avoidedUsd: 0.80 }))).toBeCloseTo(1.00);
  });

  it("returns actualUsd when avoidedUsd is zero", () => {
    expect(estimatedUncontrolledUsd(makeLoop({ actualUsd: 0.10, avoidedUsd: 0 }))).toBeCloseTo(0.10);
  });
});

// ---------------------------------------------------------------------------
// wasRollbackTaken
// ---------------------------------------------------------------------------

describe("wasRollbackTaken", () => {
  it("returns true for budget_exit lifecycleState", () => {
    expect(wasRollbackTaken(makeLoop({ lifecycleState: "budget_exit" }))).toBe(true);
  });

  it.each(["completed", "failed", "running"] as const)(
    "returns false for %s lifecycleState",
    (state) => {
      expect(wasRollbackTaken(makeLoop({ lifecycleState: state }))).toBe(false);
    }
  );
});

// ---------------------------------------------------------------------------
// wasVerifierBlocked
// ---------------------------------------------------------------------------

describe("wasVerifierBlocked", () => {
  it("returns true when status is failed", () => {
    expect(wasVerifierBlocked(makeLoop({ status: "failed" }))).toBe(true);
  });

  it("returns false when status is completed", () => {
    expect(wasVerifierBlocked(makeLoop({ status: "completed" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recordRunAndGetPrompt — CI / non-TTY guard
// ---------------------------------------------------------------------------

describe("recordRunAndGetPrompt — CI guard", () => {
  it("returns empty result and skips state I/O when CI env var is set", async () => {
    const savedCI = process.env["CI"];
    process.env["CI"] = "1";
    try {
      const result = await recordRunAndGetPrompt(BASE_INPUT);
      expect(result.inlineMilestones).toHaveLength(0);
      expect(result.interactivePrompt).toBeNull();
      expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    } finally {
      if (savedCI !== undefined) process.env["CI"] = savedCI;
      else delete process.env["CI"];
    }
  });

  it("returns empty result when stdout is not a TTY", async () => {
    const orig = process.stdout.isTTY;
    (process.stdout as NodeJS.WriteStream & { isTTY: boolean }).isTTY = false;
    try {
      const result = await recordRunAndGetPrompt(BASE_INPUT);
      expect(result.inlineMilestones).toHaveLength(0);
      expect(result.interactivePrompt).toBeNull();
    } finally {
      (process.stdout as NodeJS.WriteStream & { isTTY: boolean }).isTTY = orig;
    }
  });
});

// ---------------------------------------------------------------------------
// recordRunAndGetPrompt — corrupt / missing state file
// ---------------------------------------------------------------------------

describe("recordRunAndGetPrompt — state file edge cases", () => {
  it("starts from fresh state when the state file contains invalid JSON", async () => {
    vi.mocked(readFile).mockResolvedValueOnce("not valid json {{{}");
    const result = await runWithTty(BASE_INPUT);
    // Should not throw — returns a valid result from a fresh state
    expect(result).toHaveProperty("inlineMilestones");
    expect(result).toHaveProperty("interactivePrompt");
  });

  it("starts from fresh state when the state file has a non-v5 version", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ version: 4, runCount: 999 }));
    const result = await runWithTty(BASE_INPUT);
    // Old state is discarded — no phantom run count carried forward
    expect(result).toHaveProperty("inlineMilestones");
  });

  it("fills missing nested fields when v5 state file is incomplete", async () => {
    // Simulate a v5 state written by an older iteration that lacked some fields
    vi.mocked(readFile).mockResolvedValueOnce(
      JSON.stringify({ version: 5, successfulRunCount: 3, runCount: 3 })
    );
    // Should not throw — fillDefaults covers missing sub-objects
    const result = await runWithTty(BASE_INPUT);
    expect(result).toHaveProperty("inlineMilestones");
  });
});

// ---------------------------------------------------------------------------
// recordRunAndGetPrompt — suppressUntilRun
// ---------------------------------------------------------------------------

describe("recordRunAndGetPrompt — suppressUntilRun", () => {
  it("suppresses interactive GTM prompt when suppressUntilRun has not been reached", async () => {
    // runCount is 5, suppressUntilRun is 10 — GTM should be silent
    mockStateFile(makeState({
      runCount: 5,
      successfulRunCount: 5,
      suppressUntilRun: 10,
      totalSavedUsd: 5,
      savingsConfidence: "confirmed",
      star: { shownCount: 0, confirmed: false },
    }));

    const result = await runWithTty(BASE_INPUT);
    expect(result.interactivePrompt).toBeNull();
  });

  it("allows GTM prompt once suppressUntilRun threshold is passed", async () => {
    // After the call, runCount becomes 11 which is > suppressUntilRun of 10
    mockStateFile(makeState({
      runCount: 10,
      successfulRunCount: 10,
      suppressUntilRun: 10,
      totalSavedUsd: 2,
      savingsConfidence: "confirmed",
      star: { shownCount: 0, confirmed: false },
      waitlist: { status: "declined", declinedCount: 2, email: null, shownAt: null },
      feedback: { shownCount: 1, lastShownAtRunCount: 5, lastShownAtSavedUsd: 1, scores: [], featureVotes: [], email: null },
    }));

    const result = await runWithTty({ ...BASE_INPUT, estimatedUncontrolledUsd: 2.20 });
    // runCount after update is 11, suppressUntilRun is 10 — should fire
    expect(result.interactivePrompt?.kind).toBe("star");
  });
});

// ---------------------------------------------------------------------------
// recordRunAndGetPrompt — loop milestone
// ---------------------------------------------------------------------------

describe("recordRunAndGetPrompt — loop milestone", () => {
  it("fires loop_milestone at the exact run that crosses the 10-loop threshold", async () => {
    mockStateFile(makeState({ successfulRunCount: 9, runCount: 9 }));
    const result = await runWithTty(BASE_INPUT);
    expect(result.interactivePrompt).toEqual({ kind: "loop_milestone", count: 10 });
  });

  it("does not fire loop_milestone again after the threshold was already recorded", async () => {
    mockStateFile(makeState({
      successfulRunCount: 10,
      runCount: 10,
      loopMilestones: { reached: [10] },
    }));
    const result = await runWithTty(BASE_INPUT);
    expect(result.interactivePrompt?.kind).not.toBe("loop_milestone");
  });

  it("returns no GTM prompt alongside the loop_milestone — they are mutually exclusive", async () => {
    // State would otherwise trigger star prompt, but loop milestone takes the slot
    mockStateFile(makeState({
      successfulRunCount: 9,
      runCount: 9,
      totalSavedUsd: 5,
      savingsConfidence: "confirmed",
      star: { shownCount: 0, confirmed: false },
    }));
    const result = await runWithTty({ ...BASE_INPUT, estimatedUncontrolledUsd: 5.20 });
    expect(result.interactivePrompt).toEqual({ kind: "loop_milestone", count: 10 });
  });
});

// ---------------------------------------------------------------------------
// recordRunAndGetPrompt — star Tier 3 fallback
// ---------------------------------------------------------------------------

describe("recordRunAndGetPrompt — star Tier 3 fallback", () => {
  it("fires star at run 5 when savings are unavailable and feedback has already been shown", async () => {
    // feedbackByRuns would fire at run 5 if lastShownAtRunCount is unset, so we set it
    mockStateFile(makeState({
      successfulRunCount: 4,
      runCount: 4,
      savingsConfidence: "unavailable",
      totalSavedUsd: 0,
      feedback: {
        shownCount: 1,
        lastShownAtRunCount: 3,
        lastShownAtSavedUsd: 0,
        scores: [{ score: 4, runCount: 3 }],
        featureVotes: [],
        email: null,
      },
      star: { shownCount: 0, confirmed: false },
    }));

    const result = await runWithTty({
      ...BASE_INPUT,
      savingsConfidence: "unavailable",
      actualSpendUsd: 0,
      estimatedUncontrolledUsd: 0,
    });

    expect(result.interactivePrompt).toEqual({ kind: "star", hard: false });
  });

  it("does not fire star when already shown twice (max 2 shows)", async () => {
    mockStateFile(makeState({
      successfulRunCount: 3,
      runCount: 3,
      savingsConfidence: "unavailable",
      totalSavedUsd: 0,
      feedback: {
        shownCount: 1,
        lastShownAtRunCount: 2,
        lastShownAtSavedUsd: 0,
        scores: [],
        featureVotes: [],
        email: null,
      },
      star: { shownCount: 2, confirmed: false },
    }));

    const result = await runWithTty({
      ...BASE_INPUT,
      savingsConfidence: "unavailable",
      actualSpendUsd: 0,
      estimatedUncontrolledUsd: 0,
    });

    // shownCount >= 2 suppresses further star prompts
    expect(result.interactivePrompt?.kind).not.toBe("star");
  });
});

// ---------------------------------------------------------------------------
// recordRunAndGetPrompt — inline milestones (streak)
// ---------------------------------------------------------------------------

describe("recordRunAndGetPrompt — inline milestones", () => {
  it("emits streak_milestone inline when daily streak crosses 3 days", async () => {
    mockStateFile(makeState({
      successfulRunCount: 5,
      runCount: 5,
      lastRunAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      dailyStreakDays: 2,
      streakMilestones: { reached: [] },
    }));

    const result = await runWithTty(BASE_INPUT);
    expect(result.inlineMilestones).toContainEqual({ kind: "streak_milestone", days: 3 });
  });

  it("emits inline milestone without blocking the interactive GTM slot", async () => {
    mockStateFile(makeState({
      successfulRunCount: 5,
      runCount: 5,
      lastRunAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      dailyStreakDays: 2,
      streakMilestones: { reached: [] },
      totalSavedUsd: 1.50,
      savingsConfidence: "confirmed",
      star: { shownCount: 0, confirmed: false },
      feedback: {
        shownCount: 1,
        lastShownAtRunCount: 3,
        lastShownAtSavedUsd: 0,
        scores: [],
        featureVotes: [],
        email: null,
      },
      waitlist: { status: "declined", declinedCount: 2, email: null, shownAt: null },
    }));

    const result = await runWithTty({ ...BASE_INPUT, estimatedUncontrolledUsd: 2.00 });
    expect(result.inlineMilestones.some(m => m.kind === "streak_milestone")).toBe(true);
    expect(result.interactivePrompt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// recordRunAndGetPrompt — GTM priority: waitlist > feedback > star
// ---------------------------------------------------------------------------

describe("recordRunAndGetPrompt — GTM prompt priority", () => {
  it("shows waitlist over feedback when both thresholds are met", async () => {
    mockStateFile(makeState({
      successfulRunCount: 10,
      runCount: 10,
      totalSavedUsd: 60,
      savingsConfidence: "confirmed",
      reposUsed: ["/repo-a", "/repo-b"],
      waitlist: { status: "not_asked", declinedCount: 0, email: null, shownAt: null },
      feedback: { shownCount: 0, scores: [], featureVotes: [], email: null },
    }));

    const result = await runWithTty({ ...BASE_INPUT, estimatedUncontrolledUsd: 60.20 });
    expect(result.interactivePrompt?.kind).toBe("waitlist");
  });

  it("shows feedback over star when both thresholds are met", async () => {
    mockStateFile(makeState({
      successfulRunCount: 10,
      runCount: 10,
      totalSavedUsd: 11,
      savingsConfidence: "confirmed",
      waitlist: { status: "declined", declinedCount: 2, email: null, shownAt: null },
      feedback: { shownCount: 0, scores: [], featureVotes: [], email: null },
      star: { shownCount: 0, confirmed: false },
    }));

    const result = await runWithTty({ ...BASE_INPUT, estimatedUncontrolledUsd: 11.20 });
    expect(result.interactivePrompt?.kind).toBe("feedback");
  });

  it("shows star when waitlist is declined and feedback has been recently shown", async () => {
    mockStateFile(makeState({
      successfulRunCount: 10,
      runCount: 10,
      totalSavedUsd: 2,
      savingsConfidence: "confirmed",
      waitlist: { status: "declined", declinedCount: 2, email: null, shownAt: null },
      feedback: {
        shownCount: 1,
        lastShownAtSavedUsd: 1.50, // delta < $50, so feedbackBySpend is false
        lastShownAtRunCount: 9,
        scores: [],
        featureVotes: [],
        email: null,
      },
      star: { shownCount: 0, confirmed: false },
    }));

    const result = await runWithTty({ ...BASE_INPUT, estimatedUncontrolledUsd: 2.20 });
    expect(result.interactivePrompt?.kind).toBe("star");
  });
});
