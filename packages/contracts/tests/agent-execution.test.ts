import { describe, expect, it } from "vitest";

import {
  DEFAULT_AGENT_EXECUTION_INTENT,
  DEFAULT_PROVIDER_EXECUTION_TIMEOUT_MS,
  GOVERNED_AUTONOMOUS_BOUNDARY,
  normalizeProviderExecutionTimeoutMs
} from "../src/index.js";

describe("provider-neutral agent execution contract", () => {
  it("defaults to governed autonomous execution with a finite five-minute provider timeout", () => {
    expect(DEFAULT_AGENT_EXECUTION_INTENT).toBe("governed-autonomous");
    expect(GOVERNED_AUTONOMOUS_BOUNDARY).toEqual({
      interaction: "non-interactive",
      writeScope: "workspace-only"
    });
    expect(DEFAULT_PROVIDER_EXECUTION_TIMEOUT_MS).toBe(300_000);
    expect(Number.isFinite(DEFAULT_PROVIDER_EXECUTION_TIMEOUT_MS)).toBe(true);
  });

  it("accepts a positive finite provider timeout override", () => {
    expect(normalizeProviderExecutionTimeoutMs(900_000)).toBe(900_000);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid provider timeout %s",
    (value) => {
      expect(() => normalizeProviderExecutionTimeoutMs(value)).toThrow(/positive finite/iu);
    }
  );
});
