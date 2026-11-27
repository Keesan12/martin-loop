import { describe, expect, it, vi } from "vitest";

import { runMartin, type MartinAdapter, type MartinAdapterResult } from "../src/index.js";

function adapterWithSettlement(input: {
  providerId?: string;
  model?: string;
  observeVerification?: () => void;
}): MartinAdapter {
  return {
    adapterId: "agent-cli:codex",
    kind: "agent-cli",
    label: "settlement binding fixture",
    metadata: { providerId: "codex", model: "gpt-6.1-sol" },
    async execute() {
      const result = {
        status: "completed" as const,
        summary: "provider completed",
        usage: {
          actualUsd: 0.01,
          tokensIn: 10,
          tokensOut: 5,
          providerSettlement: {
            providerId: input.providerId ?? "codex",
            ...(input.model !== undefined ? { model: input.model } : {}),
            source: "codex_jsonl" as const,
            inputTokens: 10,
            outputTokens: 5,
            rawUsageAvailable: true,
            settledAt: "2026-11-19T20:00:00.000Z",
          },
        },
      } as Omit<MartinAdapterResult, "verification"> & { verification?: MartinAdapterResult["verification"] };
      Object.defineProperty(result, "verification", {
        enumerable: true,
        get() {
          input.observeVerification?.();
          return { passed: true, summary: "verified" };
        },
      });
      return result as MartinAdapterResult;
    },
  };
}

async function execute(adapter: MartinAdapter) {
  return runMartin({
    workspaceId: "ws-provider-binding",
    projectId: "proj-provider-binding",
    task: {
      title: "Bind provider settlement",
      objective: "Require settlement authority to match the executing adapter.",
      verificationPlan: [],
    },
    budget: { maxUsd: 1, softLimitUsd: 1, maxIterations: 1, maxTokens: 1_000 },
    adapter,
  });
}

describe("provider settlement binding", () => {
  it("accepts settlement matching the executing provider and model", async () => {
    const observeVerification = vi.fn();
    const result = await execute(adapterWithSettlement({
      providerId: "codex",
      model: "gpt-6.1-sol",
      observeVerification,
    }));

    expect(result.loop.attempts).toHaveLength(1);
    expect(result.loop.attempts[0]).toMatchObject({
      adapterId: "agent-cli:codex",
      model: "gpt-6.1-sol",
    });
    expect(result.loop.cost.providerSettlement).toMatchObject({
      providerId: "codex",
      model: "gpt-6.1-sol",
    });
    expect(observeVerification).toHaveBeenCalled();
  });

  it("rejects a contradictory provider before verification is observed", async () => {
    const observeVerification = vi.fn();

    await expect(execute(adapterWithSettlement({
      providerId: "openai-compatible",
      model: "gpt-6.1-sol",
      observeVerification,
    }))).rejects.toMatchObject({
      code: "PROVIDER_SETTLEMENT_PROVIDER_MISMATCH",
      accountingEvidence: {
        actualUsd: 0.01,
        tokensIn: 10,
        tokensOut: 5,
        providerSettlement: { providerId: "openai-compatible", model: "gpt-6.1-sol" },
      },
    });
    expect(observeVerification).not.toHaveBeenCalled();
  });

  it("rejects a contradictory observed model before verification is observed", async () => {
    const observeVerification = vi.fn();

    await expect(execute(adapterWithSettlement({
      providerId: "codex",
      model: "gpt-5.4",
      observeVerification,
    }))).rejects.toMatchObject({ code: "PROVIDER_SETTLEMENT_MODEL_MISMATCH" });
    expect(observeVerification).not.toHaveBeenCalled();
  });

  it("preserves a missing model observation instead of fabricating one", async () => {
    const result = await execute(adapterWithSettlement({ providerId: "codex" }));

    expect(result.loop.cost.providerSettlement).toMatchObject({ providerId: "codex" });
    expect(result.loop.cost.providerSettlement).not.toHaveProperty("model");
    expect(result.loop.attempts[0]?.model).toBe("gpt-6.1-sol");
  });
});
