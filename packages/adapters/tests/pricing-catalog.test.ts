import { describe, expect, it } from "vitest";

import {
  resolveBudgetPreflightPricePerMTokenUsd,
  resolveProviderPricing
} from "../src/pricing/catalog.js";

describe("provider pricing catalog", () => {
  it("uses the highest active model token rate for conservative budget admission", () => {
    expect(resolveBudgetPreflightPricePerMTokenUsd("gpt-6-astra", {
      provider: "openai",
      at: new Date("2026-11-03T00:00:00.000Z")
    })).toBe(75);
  });

  it("uses the provider-conservative active rate when the CLI selects its model automatically", () => {
    expect(resolveBudgetPreflightPricePerMTokenUsd(undefined, {
      provider: "openai",
      at: new Date("2026-11-03T00:00:00.000Z")
    })).toBe(75);
  });

  it("resolves the current GPT-6.1 Terra standard rates exactly", () => {
    const resolution = resolveProviderPricing("gpt-6.1-terra", {
      provider: "openai",
      at: new Date("2026-11-03T00:00:00.000Z"),
      serviceTier: "standard",
      inputTokens: 1_000
    });

    expect(resolution).toMatchObject({
      status: "exact",
      canonicalModelId: "gpt-6.1-terra",
      pricing: {
        ratesPerMillion: {
          input: 1,
          output: 5,
          cachedInput: 0.05,
          cacheWrite: { "30m": 1.25, "12h": 2.5 }
        }
      }
    });
  });

  it("prices current Claude cache reads and Haiku long prompts from distinct bands", () => {
    const sonnet = resolveProviderPricing("claude-sonnet-5-5", {
      provider: "anthropic",
      at: new Date("2026-11-03T00:00:00.000Z")
    });
    const haikuLong = resolveProviderPricing("claude-haiku-5-5", {
      provider: "anthropic",
      at: new Date("2026-11-03T00:00:00.000Z"),
      inputTokens: 100_001
    });
    const haikuShort = resolveProviderPricing("claude-haiku-5-5", {
      provider: "anthropic",
      at: new Date("2026-11-03T00:00:00.000Z"),
      inputTokens: 100_000
    });

    expect(sonnet.pricing?.ratesPerMillion.cachedInput).toBe(0.1);
    expect(sonnet.pricing?.ratesPerMillion.cacheWrite).toEqual({ "5m": 2.5, "1h": 4 });
    expect(haikuShort.pricing?.ratesPerMillion).toMatchObject({
      input: 0.1,
      output: 0.5,
      cachedInput: 0.01
    });
    expect(haikuLong.pricing?.ratesPerMillion).toMatchObject({
      input: 0.5,
      output: 2.5,
      cachedInput: 0.05
    });
  });

  it("selects long-context OpenAI rates and preserves explicit resolution status", () => {
    const longContext = resolveProviderPricing("gpt-6.1-sol", {
      provider: "openai",
      at: new Date("2026-11-03T00:00:00.000Z"),
      inputTokens: 272_001
    });
    const unknown = resolveProviderPricing("gpt-future-unknown", { provider: "openai" });

    expect(longContext).toMatchObject({
      status: "exact",
      pricing: {
        minInputTokensExclusive: 272_000,
        ratesPerMillion: { input: 4, output: 15, cachedInput: 0.2 }
      }
    });
    expect(unknown).toEqual({ status: "unknown" });
  });

  it("returns an alias for dated Claude IDs and switches promotional Gemini rates by date", () => {
    const datedClaude = resolveProviderPricing("claude-sonnet-5-5-20260928", {
      provider: "anthropic",
      at: new Date("2026-11-03T00:00:00.000Z")
    });
    const currentGemini = resolveProviderPricing("gemini-3.8-flash", {
      provider: "google",
      at: new Date("2026-11-03T00:00:00.000Z")
    });
    const futureGemini = resolveProviderPricing("gemini-3.8-flash", {
      provider: "google",
      at: new Date("2027-01-01T00:00:00.000Z")
    });

    expect(datedClaude).toMatchObject({ status: "alias", canonicalModelId: "claude-sonnet-5-5" });
    expect(currentGemini).toMatchObject({
      status: "exact",
      pricing: { effectiveUntil: "2026-12-31", ratesPerMillion: { input: 0.75, output: 3.75 } }
    });
    expect(futureGemini).toMatchObject({
      status: "exact",
      pricing: { effectiveFrom: "2027-01-01", ratesPerMillion: { input: 1.5, output: 7.5 } }
    });
  });

  it("tracks current Gemini flagship dates and rejects the unsupported 3.7 identifier", () => {
    const promotionalArgon = resolveProviderPricing("gemini-4-argon", {
      provider: "google",
      at: new Date("2026-11-30T12:00:00.000Z")
    });
    const standardArgon = resolveProviderPricing("gemini-4-argon", {
      provider: "google",
      at: new Date("2026-12-01T00:00:00.000Z")
    });
    const flash36 = resolveProviderPricing("gemini-3.6-flash", {
      provider: "google",
      at: new Date("2026-11-03T00:00:00.000Z")
    });
    const unsupported37 = resolveProviderPricing("gemini-3.7-flash", {
      provider: "google",
      at: new Date("2026-11-03T00:00:00.000Z")
    });

    expect(promotionalArgon).toMatchObject({
      status: "exact",
      pricing: {
        effectiveUntil: "2026-11-30",
        ratesPerMillion: { input: 2, output: 10, cachedInput: 0.1 }
      }
    });
    expect(standardArgon).toMatchObject({
      status: "exact",
      pricing: {
        effectiveFrom: "2026-12-01",
        ratesPerMillion: { input: 4, output: 20, cachedInput: 0.2 }
      }
    });
    expect(flash36).toMatchObject({ status: "exact", canonicalModelId: "gemini-3.6-flash" });
    expect(unsupported37).toEqual({ status: "unknown" });
  });
});
