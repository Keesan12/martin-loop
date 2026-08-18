import { describe, expect, it, vi } from "vitest";

import {
  isArcadeOfferEligible,
  offerArcadeWhileWaiting,
  type ArcadeOfferRuntime
} from "../src/arcade/offer.js";

function eligibleRuntime(
  overrides: Partial<ArcadeOfferRuntime> = {}
): ArcadeOfferRuntime {
  return {
    mode: "ask",
    stdoutIsTty: true,
    stdinIsTty: true,
    ci: false,
    term: "xterm-256color",
    columns: 100,
    rows: 30,
    ...overrides
  };
}

describe("Arcade offer policy", () => {
  it.each([
    [{ outputMode: "json" }, false],
    [{ outputMode: "quiet" }, false],
    [{ outputMode: "human", ci: true }, false],
    [{ outputMode: "human", stdoutIsTty: false }, false],
    [{ outputMode: "human", stdinIsTty: false }, false],
    [{ outputMode: "human", columns: 49 }, false],
    [{ outputMode: "human", rows: 17 }, false],
    [{ outputMode: "human", term: "dumb" }, false],
    [{ outputMode: "human" }, true]
  ] as const)("evaluates terminal eligibility", (input, expected) => {
    const { outputMode, ...runtime } = input;
    expect(
      isArcadeOfferEligible(
        outputMode,
        eligibleRuntime(runtime)
      )
    ).toBe(expected);
  });

  it("does not invoke Arcade when mode is never", async () => {
    const play = vi.fn((task: Promise<string>) => task);
    await expect(
      offerArcadeWhileWaiting(
        Promise.resolve("done"),
        { outputMode: "human" },
        eligibleRuntime({ mode: "never", play })
      )
    ).resolves.toBe("done");
    expect(play).not.toHaveBeenCalled();
  });

  it("does not prompt when the task finishes quickly", async () => {
    const ask = vi.fn();
    await expect(
      offerArcadeWhileWaiting(
        Promise.resolve("done"),
        { outputMode: "human" },
        eligibleRuntime({
          wait: () => new Promise<void>(() => undefined),
          ask
        })
      )
    ).resolves.toBe("done");
    expect(ask).not.toHaveBeenCalled();
  });

  it("starts Arcade immediately in always mode", async () => {
    const play = vi.fn(async () => "played");
    await expect(
      offerArcadeWhileWaiting(
        Promise.resolve("done"),
        { outputMode: "human" },
        eligibleRuntime({ mode: "always", play })
      )
    ).resolves.toBe("played");
    expect(play).toHaveBeenCalledOnce();
  });

  it.each([
    [false, false],
    [true, true]
  ] as const)("honors an ask-mode choice of %s", async (choice, shouldPlay) => {
    const play = vi.fn((task: Promise<string>) => task);
    const task = new Promise<string>((resolve) => {
      setTimeout(() => resolve("done"), 25);
    });
    await expect(
      offerArcadeWhileWaiting(
        task,
        { outputMode: "human" },
        eligibleRuntime({
          wait: async () => undefined,
          ask: () => ({
            promise: Promise.resolve(choice),
            cancel: vi.fn()
          }),
          play
        })
      )
    ).resolves.toBe("done");
    expect(play).toHaveBeenCalledTimes(shouldPlay ? 1 : 0);
  });

  it("propagates the original task error", async () => {
    const error = new Error("governed task failed");
    await expect(
      offerArcadeWhileWaiting(
        Promise.reject(error),
        { outputMode: "human" },
        eligibleRuntime({
          wait: () => new Promise<void>(() => undefined)
        })
      )
    ).rejects.toBe(error);
  });
});
