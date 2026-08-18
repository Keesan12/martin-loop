/**
 * Autonomous model selection tests.
 *
 * Validates that MartinLoop automatically selects the appropriate model tier
 * based on task complexity, and resolves to concrete model IDs per engine.
 * No mocks. All tests call real classifyRoute and resolveModelForTier.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyRoute, resolveModelForTier, selectBestEngine, type AvailableEngine } from "../../core/src/routing.js";
import { parseCliArguments } from "../src/index.js";

describe("classifyRoute model tier selection", () => {
  it("simple task → haiku tier", () => {
    const route = classifyRoute({
      objective: "Fix a typo in README",
      verificationPlan: [],
      budgetUsd: 2
    });
    expect(route.selectedMode).toBe("direct");
    expect(route.recommendedModelTier).toBe("haiku");
  });

  it("architectural task → sonnet tier", () => {
    const route = classifyRoute({
      objective: "Refactor the service layer architecture",
      verificationPlan: [],
      budgetUsd: 8
    });
    expect(route.recommendedModelTier).toBe("sonnet");
  });

  it("security + migration → opus tier", () => {
    const route = classifyRoute({
      objective: "Migrate authentication credentials and rotate encryption keys",
      verificationPlan: [],
      budgetUsd: 15
    });
    expect(route.selectedMode).toBe("consensus");
    expect(route.recommendedModelTier).toBe("opus");
  });
});

describe("resolveModelForTier cross-engine", () => {
  it("haiku → claude-haiku-4-5 for claude engine", () => {
    expect(resolveModelForTier("haiku", "claude")).toBe("claude-haiku-4-5-20251001");
  });

  it("leaves concrete model choice to the authenticated Codex CLI", () => {
    expect(resolveModelForTier("haiku", "codex")).toBeUndefined();
  });

  it("haiku → gemini-2.5-flash for gemini engine", () => {
    expect(resolveModelForTier("haiku", "gemini")).toBe("gemini-2.5-flash");
  });

  it("does not pin a Codex model for sonnet-tier work", () => {
    expect(resolveModelForTier("sonnet", "codex")).toBeUndefined();
  });

  it("does not pin a Codex model for opus-tier work", () => {
    expect(resolveModelForTier("opus", "codex")).toBeUndefined();
  });

  it("leaves OpenAI-compatible model selection to adapter configuration", () => {
    expect(resolveModelForTier("haiku", "openai")).toBeUndefined();
  });

  it("haiku → deepseek-chat for deepseek engine", () => {
    expect(resolveModelForTier("haiku", "deepseek")).toBe("deepseek-chat");
  });

  it("unknown engine falls back to claude model", () => {
    const model = resolveModelForTier("sonnet", "unknown-engine");
    expect(model).toBe("claude-sonnet-4-6");
  });
});

describe("live execution model authority", () => {
  it("keeps recommendations out of execution unless --model is explicit", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
      "utf8"
    );

    expect(source).not.toContain("autoSelectedModel");
    expect(source).not.toContain("autoSelectModel");
    expect(source).toContain("const effectiveModel = modelOverride;");

    const adapterSelection = source.slice(
      source.indexOf("function selectAdapter("),
      source.indexOf("function buildDoctorRecommendations(")
    );
    expect(adapterSelection).toContain("const effectiveModel = modelOverride;");
    expect(adapterSelection).toContain(
      "...(effectiveModel ? { model: effectiveModel } : {})"
    );
    expect(adapterSelection).not.toContain("resolveModelForTier");
    expect(adapterSelection).not.toContain("classifyRoute");

    const routingSource = readFileSync(
      fileURLToPath(new URL("../../core/src/routing.ts", import.meta.url)),
      "utf8"
    );
    expect(routingSource).not.toContain("gpt-4o-mini");
  });
});

describe("selectBestEngine", () => {
  it("returns claude default when no engines available", () => {
    const result = selectBestEngine("haiku", []);
    expect(result.engineId).toBe("claude");
    expect(result.reasoning).toContain("No engines detected");
  });

  it("picks cheapest available engine for haiku tier", () => {
    const engines: AvailableEngine[] = [
      { id: "claude", available: true, costTier: "cheap", capabilityTier: "haiku" },
      { id: "gemini", available: true, costTier: "cheap", capabilityTier: "haiku" }
    ];
    const result = selectBestEngine("haiku", engines);
    expect(["claude", "gemini"]).toContain(result.engineId);
    expect(result.model).toBeTruthy();
  });

  it("upgrades to best available when required tier not available", () => {
    const engines: AvailableEngine[] = [
      { id: "claude", available: true, costTier: "cheap", capabilityTier: "haiku" }
    ];
    // Request opus but only haiku available
    const result = selectBestEngine("opus", engines);
    expect(result.reasoning).toContain("Upgrading");
    expect(result.engineId).toBe("claude");
  });

  it("skips unavailable engines", () => {
    const engines: AvailableEngine[] = [
      { id: "claude", available: false, costTier: "cheap", capabilityTier: "haiku" },
      { id: "gemini", available: true, costTier: "cheap", capabilityTier: "haiku" }
    ];
    const result = selectBestEngine("haiku", engines);
    expect(result.engineId).toBe("gemini");
  });
});

describe("estimate command model tier in output", () => {
  it("estimate command parses correctly for claude", () => {
    const parsed = parseCliArguments(["estimate", "Fix a typo", "--engine", "claude"]);
    expect(parsed).toMatchObject({ command: "estimate", engine: "claude" });
  });

  it("estimate command parses deepseek as engine", () => {
    const parsed = parseCliArguments(["estimate", "Optimize query", "--engine", "openai"]);
    expect(parsed).toMatchObject({ command: "estimate", engine: "openai" });
  });
});
