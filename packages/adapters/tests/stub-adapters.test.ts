// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { MartinAdapterRequest } from "@martin/core";

import { createStubDirectProviderAdapter } from "../src/index.js";

describe("createStubDirectProviderAdapter", () => {
  it("returns a safe default failure until a live provider is wired in", async () => {
    const adapter = createStubDirectProviderAdapter({
      providerId: "openai",
      model: "gpt-5-mini"
    });

    const result = await adapter.execute(createRequest());

    expect(adapter.kind).toBe("direct-provider");
    expect(adapter.metadata.providerId).toBe("openai");
    expect(adapter.metadata.transport).toBe("http");
    expect(adapter.metadata.capabilities.usageSettlement).toBe(true);
    expect(adapter.metadata.capabilities.workspaceMutations).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.failure?.message).toContain("not configured");
    expect(result.usage.actualUsd).toBe(0);
    expect(result.usage.provenance).toBe("unavailable");
  });
});

function createRequest(): MartinAdapterRequest {
  return {
    loopId: "loop_001",
    workspaceId: "ws_ops",
    projectId: "proj_runtime",
    attemptIndex: 1,
    task: {
      title: "Repair the runtime adapter",
      objective: "Keep the alpha runtime deterministic.",
      verificationPlan: ["pnpm --filter @martin/core test"]
    },
    context: {
      taskTitle: "Repair the runtime adapter",
      objective: "Keep the alpha runtime deterministic.",
      verificationPlan: ["pnpm --filter @martin/core test"],
      recentAttempts: [],
      constraints: {
        remainingBudgetUsd: 10,
        remainingIterations: 3,
        remainingTokens: 2_000
      },
      focus: "Deliver a verified fix without expanding scope."
    },
    budget: {
      maxUsd: 10,
      softLimitUsd: 6,
      maxIterations: 3,
      maxTokens: 2_000
    },
    costState: {
      pressure: "healthy",
      shouldStop: false,
      remainingBudgetUsd: 10,
      remainingIterations: 3,
      remainingTokens: 2_000
    }
  };
}
