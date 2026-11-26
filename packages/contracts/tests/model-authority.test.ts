import { describe, expect, it } from "vitest";

import {
  assertConcreteLiveModel,
  validateConcreteLiveModel,
} from "../src/index.js";

describe("concrete live model authority", () => {
  it.each([
    [undefined, "model_required"],
    [null, "model_required"],
    [0, "model_must_be_string"],
    [{}, "model_must_be_string"],
    ["", "model_required"],
    ["   \t", "model_required"],
    [" gpt-6.1-sol", "model_outer_whitespace"],
    ["gpt-6.1-sol ", "model_outer_whitespace"],
    ["auto", "model_reserved_sentinel"],
    ["PROOF", "model_reserved_sentinel"],
    ["Stub", "model_reserved_sentinel"],
    ["fallback", "model_reserved_sentinel"],
    ["SIMULATION", "model_reserved_sentinel"],
    ["Default", "model_reserved_sentinel"],
  ] as const)("rejects invalid explicit-live model %j", (input, reason) => {
    expect(validateConcreteLiveModel(input)).toEqual({
      valid: false,
      reason,
    });
    expect(() => assertConcreteLiveModel(input)).toThrow(reason);
  });

  it.each([
    "gpt-6.1-sol",
    "claude-sonnet-4-20261001",
    "anthropic/claude-sonnet-4",
    "qwen2.5-coder:32b-instruct-q4_K_M",
    "openrouter/vendor.model+reasoning@2026-11-20",
    "local://my_model.v2#safe",
  ])("accepts and preserves concrete identifier %s byte-for-byte", (model) => {
    expect(validateConcreteLiveModel(model)).toEqual({
      valid: true,
      model,
    });
    expect(assertConcreteLiveModel(model)).toBe(model);
  });
});
