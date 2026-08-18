import { afterEach, describe, expect, it, vi } from "vitest";

// Hoisted before imports — intercepts node:readline used inside ux.ts's createLineReader()
let createInterfaceCalls = 0;
let answerQueue: string[] = [];

vi.mock("node:readline", () => {
  return {
    createInterface: vi.fn(() => {
      createInterfaceCalls += 1;
      const onceHandlers: Record<string, ((arg?: string) => void)[]> = {};
      const on = (event: string, cb: (arg?: string) => void) => {
        (onceHandlers[event] ??= []).push(cb);
      };
      return {
        on,
        once: (event: string, cb: (arg?: string) => void) => {
          if (event === "line") {
            // Simulate each answer arriving asynchronously, after the CLI has
            // already moved past the point where it used to exit — this is
            // exactly the race the old `void renderMilestonePrompt(...)` (and
            // later, the per-question `readline.createInterface(...)`) bugs
            // lost. Each call pops the next queued "typed" answer.
            const answer = answerQueue.shift() ?? "";
            setTimeout(() => cb(answer), 10);
          } else {
            on(event, cb);
          }
        },
        close: vi.fn(),
      };
    }),
  };
});

describe("renderRunHeader — receipt persistence messaging", () => {
  it.each([
    ["actual", "$1.25 provider-settled actual"],
    ["calculated", "$1.25 calculated from observed usage"],
    ["estimated", "$1.25 estimated"],
    ["unavailable", "cost unavailable"]
  ] as const)("labels %s run cost truthfully", (provenance, expected) => {
    const header = renderRunHeader(
      "Observer",
      "success",
      1,
      1.25,
      0,
      0,
      "unavailable",
      true,
      provenance
    );

    expect(header).toContain(expected);
    if (provenance !== "actual") {
      expect(header).not.toContain("$1.25 actual");
    }
  });

  it("states that a failed run's signed receipt was retained", () => {
    const header = renderRunHeader("Observer", "failure", 2, 0, 0, 0, "unavailable", true);

    expect(header).toContain("failure evidence and a signed receipt were saved");
    expect(header).not.toContain("no receipts this time");
  });

  it("does not claim a receipt exists when persistence failed", () => {
    const header = renderRunHeader("Observer", "failure", 1, 0, 0, 0, "unavailable", false);

    expect(header).toContain("no receipt is available");
  });
});

import { renderMilestonePrompt, renderRunHeader } from "../src/ux.js";

describe("renderMilestonePrompt — feedback prompt capture", () => {
  const originalIsTTY = process.stdout.isTTY;

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });
    createInterfaceCalls = 0;
    answerQueue = [];
  });

  it("awaits the user's typed score and invokes onFeedback with it before resolving", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    answerQueue = ["3"];

    const onFeedback = vi.fn().mockResolvedValue(undefined);

    // If this promise resolved before the delayed "line" event fired, the
    // fire-and-forget bug would be back: the caller (the `run` command)
    // would move on before the user's answer was ever captured.
    await renderMilestonePrompt(
      { kind: "feedback" },
      { rank: "Observer", prevRank: null, totalSavedUsd: 0, successfulRunCount: 0, starShownCount: 0 },
      {
        onStarConfirmed: vi.fn(),
        onWaitlistJoined: vi.fn(),
        onWaitlistDeclined: vi.fn(),
        onFeedback,
      }
    );

    expect(onFeedback).toHaveBeenCalledTimes(1);
    expect(onFeedback).toHaveBeenCalledWith(3, undefined, undefined);
  });

  it("carries a high score through both follow-up questions using one shared reader", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    // score, then feature vote, then email — three sequential questions.
    answerQueue = ["5", "better docs", "someone@example.com"];

    const onFeedback = vi.fn().mockResolvedValue(undefined);

    await renderMilestonePrompt(
      { kind: "feedback" },
      { rank: "Observer", prevRank: null, totalSavedUsd: 0, successfulRunCount: 0, starShownCount: 0 },
      {
        onStarConfirmed: vi.fn(),
        onWaitlistJoined: vi.fn(),
        onWaitlistDeclined: vi.fn(),
        onFeedback,
      }
    );

    // The critical regression check: only ONE readline interface should be
    // created for the whole interaction, even though three questions were
    // asked. Creating a fresh interface per question was the root cause of
    // the "answer silently discarded" bug.
    expect(createInterfaceCalls).toBe(1);
    expect(onFeedback).toHaveBeenCalledTimes(1);
    expect(onFeedback).toHaveBeenCalledWith(5, "better docs", "someone@example.com");
  });

  it("carries a low score through its single follow-up question", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    answerQueue = ["1", "the CLI hangs on the feedback prompt"];

    const onFeedback = vi.fn().mockResolvedValue(undefined);

    await renderMilestonePrompt(
      { kind: "feedback" },
      { rank: "Observer", prevRank: null, totalSavedUsd: 0, successfulRunCount: 0, starShownCount: 0 },
      {
        onStarConfirmed: vi.fn(),
        onWaitlistJoined: vi.fn(),
        onWaitlistDeclined: vi.fn(),
        onFeedback,
      }
    );

    expect(createInterfaceCalls).toBe(1);
    expect(onFeedback).toHaveBeenCalledTimes(1);
    expect(onFeedback).toHaveBeenCalledWith(1, "the CLI hangs on the feedback prompt", undefined);
  });
});
