import { describe, expect, it } from "vitest";

import type { MartinAdapterRequest } from "@martin/core";

import {
  createStubAgentCliAdapter,
  createStubDirectProviderAdapter
} from "../src/index.js";

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
    expect(result.status).toBe("failed");
    expect(result.failure?.message).toContain("not configured");
    expect(result.usage.actualUsd).toBe(0);
    expect(result.usage.provenance).toBe("unavailable");
  });
});

describe("createStubAgentCliAdapter", () => {
  it("supports injected responders while keeping CLI metadata visible", async () => {
    const adapter = createStubAgentCliAdapter({
      command: ["martin", "run"],
      profile: "sandbox",
      responder: async (request) => ({
        status: "completed",
        summary: `Simulated CLI run for ${request.task.title}.`,
        usage: {
          actualUsd: 0,
          tokensIn: 0,
          tokensOut: 0
        },
        verification: {
          passed: true,
          summary: "Simulated CLI verification passed"
        },
        artifacts: [
          {
            artifactId: "artifact_trace",
            kind: "trace",
            label: "CLI transcript",
            uri: "memory://cli-trace"
          }
        ]
      })
    });

    const result = await adapter.execute(createRequest());

    expect(adapter.kind).toBe("agent-cli");
    expect(adapter.metadata.command).toBe("martin run");
    expect(adapter.metadata.profile).toBe("sandbox");
    expect(adapter.metadata.transport).toBe("cli");
    expect(result.status).toBe("completed");
    expect(result.artifacts?.[0]?.kind).toBe("trace");
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
