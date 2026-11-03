import { describe, expect, it } from "vitest";

describe("Swarm timing", () => {
  it.each([
    [{ agents: 3, maxConcurrency: 3 }, 360_000],
    [{ agents: 15, maxConcurrency: 5 }, 840_000],
  ])("derives the parent deadline from execution waves for %o", async (shape, expected) => {
    const contracts = await import("../src/index.js");
    expect(contracts).toHaveProperty("resolveSwarmDeadlineMs");
    const resolveDeadline = (
      contracts as typeof contracts & {
        resolveSwarmDeadlineMs(input: typeof shape): number;
      }
    ).resolveSwarmDeadlineMs;
    expect(resolveDeadline(shape)).toBe(expected);
  });

  it.each([
    [{ agents: 0, maxConcurrency: 1 }, /agents.*positive safe integer/iu],
    [{ agents: 3, maxConcurrency: 0 }, /maxConcurrency.*positive safe integer/iu],
    [{ agents: 3, maxConcurrency: 4 }, /maxConcurrency.*cannot exceed agents/iu],
    [
      { agents: Number.MAX_SAFE_INTEGER, maxConcurrency: 1 },
      /derived deadline.*Node timer maximum/iu,
    ],
  ])("rejects invalid execution shape %o", async (shape, expected) => {
    const { resolveSwarmDeadlineMs } = await import("../src/index.js");
    expect(() => resolveSwarmDeadlineMs(shape)).toThrow(expected);
  });
});
