/** Model-authority regression guards. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { classifyRoute } from "../../core/src/routing.js";
import { parseCliArguments } from "../src/index.js";

describe("model-agnostic route classification", () => {
  it("classifies orchestration without selecting a model or provider tier", () => {
    const direct = classifyRoute({
      objective: "Fix a typo in README",
      verificationPlan: [],
      budgetUsd: 2,
    });
    const consensus = classifyRoute({
      objective: "Migrate authentication credentials and rotate encryption keys",
      verificationPlan: [],
      budgetUsd: 15,
    });

    expect(direct.selectedMode).toBe("direct");
    expect(consensus.selectedMode).toBe("consensus");
    expect(direct).not.toHaveProperty("recommendedModelTier");
    expect(consensus).not.toHaveProperty("estimatedSavingVsSonnetUsd");
  });
});

describe("model authority", () => {
  it("allows only the explicit model override to reach delegated adapters", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
      "utf8"
    );
    const adapterSelection = source.slice(
      source.indexOf("function selectAdapter("),
      source.indexOf("function buildDoctorRecommendations(")
    );

    expect(source).not.toContain("autoSelectedModel");
    expect(source).not.toContain("autoSelectModel");
    expect(adapterSelection).toContain("const effectiveModel = modelOverride;");
    expect(adapterSelection).toContain(
      "...(effectiveModel ? { model: effectiveModel } : {})"
    );
    expect(adapterSelection).not.toContain("resolveModelForTier");
    expect(adapterSelection).not.toContain("classifyRoute");
  });

  it("contains no universal model router or concrete routing matrix", () => {
    const routingSource = readFileSync(
      fileURLToPath(new URL("../../core/src/routing.ts", import.meta.url)),
      "utf8"
    );
    const coreSource = readFileSync(
      fileURLToPath(new URL("../../core/src/index.ts", import.meta.url)),
      "utf8",
    );

    expect(routingSource).not.toContain("recommendedModelTier");
    expect(routingSource).not.toContain("resolveModelForTier");
    expect(routingSource).not.toContain("selectBestEngine");
    expect(routingSource).not.toContain("gpt-4o-mini");
    expect(coreSource).not.toContain("DEFAULT_FALLBACK_MODELS");
    expect(coreSource).not.toContain("fallbackModels");
  });
});

describe("estimate parsing", () => {
  it("preserves engine selection without implying model selection", () => {
    expect(parseCliArguments(["estimate", "Fix a typo", "--engine", "claude"])).toMatchObject({
      command: "estimate",
      engine: "claude",
    });
    expect(parseCliArguments(["estimate", "Optimize query", "--engine", "openai"])).toMatchObject({
      command: "estimate",
      engine: "openai",
    });
  });
});
