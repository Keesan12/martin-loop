// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { maybePlayArcadeWhileWaiting } from "../src/arcade/index.js";

// Helper: a promise that resolves after `ms` with a value
function delayedResolve<T>(value: T, ms: number): Promise<T> {
  return new Promise(resolve => setTimeout(() => resolve(value), ms));
}

// Helper: a promise that rejects after `ms`
function delayedReject(ms: number, reason = "task failed"): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(reason)), ms));
}

describe("maybePlayArcadeWhileWaiting", () => {
  let origStdoutIsTTY: boolean | undefined;
  let origStdinIsTTY: boolean | undefined;
  let origCI: string | undefined;

  beforeEach(() => {
    origStdoutIsTTY = process.stdout.isTTY;
    origStdinIsTTY = process.stdin.isTTY;
    origCI = process.env["CI"];
  });

  afterEach(() => {
    // Restore TTY flags
    Object.defineProperty(process.stdout, "isTTY", { value: origStdoutIsTTY, configurable: true });
    Object.defineProperty(process.stdin, "isTTY", { value: origStdinIsTTY, configurable: true });
    if (origCI === undefined) {
      delete process.env["CI"];
    } else {
      process.env["CI"] = origCI;
    }
  });

  const setNonInteractive = () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  };

  const setCI = () => {
    process.env["CI"] = "true";
  };

  it("passes through immediately when disabled", async () => {
    const task = delayedResolve("result", 10);
    const out = await maybePlayArcadeWhileWaiting(task, { disabled: true });
    expect(out).toBe("result");
  });

  it("passes through in non-TTY environment without prompting", async () => {
    setNonInteractive();
    const task = delayedResolve("result", 10);
    const out = await maybePlayArcadeWhileWaiting(task, { promptAfterMs: 5 });
    expect(out).toBe("result");
  });

  it("passes through in CI without prompting", async () => {
    setCI();
    const task = delayedResolve("result", 10);
    const out = await maybePlayArcadeWhileWaiting(task, { promptAfterMs: 5 });
    expect(out).toBe("result");
  });

  it("returns task result when task completes before prompt threshold", async () => {
    setNonInteractive();
    const task = delayedResolve("quick", 10);
    const out = await maybePlayArcadeWhileWaiting(task, { promptAfterMs: 500 });
    expect(out).toBe("quick");
  });

  it("propagates task rejection in non-interactive mode", async () => {
    setNonInteractive();
    const task = delayedReject(10);
    await expect(maybePlayArcadeWhileWaiting(task, { promptAfterMs: 500 }))
      .rejects.toThrow("task failed");
  });

  it("preserves the task result when noArcade flag is passed via disabled", async () => {
    setNonInteractive();
    const task = delayedResolve(42, 10);
    const out = await maybePlayArcadeWhileWaiting(task, { disabled: true });
    expect(out).toBe(42);
  });

  it("short task never triggers prompt threshold in non-TTY path", async () => {
    setNonInteractive();
    const start = Date.now();
    const task = delayedResolve("fast", 20);
    const out = await maybePlayArcadeWhileWaiting(task, { promptAfterMs: 10_000 });
    const elapsed = Date.now() - start;
    expect(out).toBe("fast");
    // Should complete well under the 10 s prompt threshold
    expect(elapsed).toBeLessThan(5_000);
  });

  it("task that resolves before prompt threshold returns early in non-TTY", async () => {
    setNonInteractive();
    const task = delayedResolve("early", 5);
    const out = await maybePlayArcadeWhileWaiting(task, { promptAfterMs: 200 });
    expect(out).toBe("early");
  });

  it("works with object results", async () => {
    setNonInteractive();
    const value = { status: "completed", exitCode: 0 };
    const task = Promise.resolve(value);
    const out = await maybePlayArcadeWhileWaiting(task, { disabled: true });
    expect(out).toEqual(value);
  });
});
