// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { compileExecutionPolicy } from "../src/index.js";

describe("compileExecutionPolicy", () => {
  it("resolves governance, budget, and task scope with request-over-config precedence", () => {
    const policy = compileExecutionPolicy({
      configPath: "C:/repo/martin.config.yaml",
      defaults: {
        budget: {
          maxUsd: 10,
          softLimitUsd: 7,
          maxIterations: 3,
          maxTokens: 20_000
        },
        policyProfile: "balanced",
        telemetryDestination: "local-only",
        destructiveActionPolicy: "approval",
        verifierRules: ["pnpm test"]
      },
      config: {
        policyProfile: "strict",
        budget: {
          maxUsd: 12,
          softLimitUsd: 7,
          maxIterations: 6,
          maxTokens: 45_000
        },
        governance: {
          destructiveActionPolicy: "approval",
          telemetryDestination: "control-plane",
          verifierRules: ["pnpm test", "pnpm lint"]
        }
      },
      request: {
        budget: {
          maxUsd: 8,
          softLimitUsd: 5,
          maxIterations: 4,
          maxTokens: 25_000
        },
        budgetOverrides: {
          maxUsd: true,
          softLimitUsd: true,
          maxIterations: true,
          maxTokens: true
        },
        policyProfile: "balanced",
        telemetryDestination: "control-plane",
        repoRoot: "C:/repo",
        mutationMode: "edit",
        allowedPaths: ["src/**"],
        deniedPaths: ["docs/**"],
        acceptanceCriteria: ["Verifier stays green."],
        verificationPlan: []
      }
    });

    expect(policy.configPath).toBe("C:/repo/martin.config.yaml");
    expect(policy.budget).toEqual({
      maxUsd: 8,
      softLimitUsd: 5,
      maxIterations: 4,
      maxTokens: 25_000
    });
    expect(policy.governance).toEqual({
      policyProfile: "balanced",
      telemetryDestination: "control-plane",
      destructiveActionPolicy: "approval"
    });
    expect(policy.task).toEqual({
      verificationPlan: ["pnpm test", "pnpm lint"],
      mutationMode: "edit",
      repoRoot: "C:/repo",
      allowedPaths: ["src/**"],
      deniedPaths: ["docs/**"],
      acceptanceCriteria: ["Verifier stays green."]
    });
    expect(policy.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "budget.maxUsd", source: "request", value: "8" }),
        expect.objectContaining({
          field: "task.verificationPlan",
          source: "config",
          value: "pnpm test, pnpm lint"
        }),
        expect.objectContaining({
          field: "governance.policyProfile",
          source: "request",
          value: "balanced"
        })
      ])
    );
  });

  it("applies defaults when config and request omit values and normalizes invalid soft limits", () => {
    const policy = compileExecutionPolicy({
      configPath: "C:/repo/martin.config.yaml",
      defaults: {
        budget: {
          maxUsd: 10,
          softLimitUsd: 8,
          maxIterations: 3,
          maxTokens: 20_000
        },
        policyProfile: "balanced",
        telemetryDestination: "local-only",
        destructiveActionPolicy: "approval",
        verifierRules: ["pnpm test"]
      },
      config: {
        budget: {
          maxUsd: 6,
          softLimitUsd: 9
        }
      },
      request: {
        budget: {
          maxUsd: 10,
          softLimitUsd: 8,
          maxIterations: 3,
          maxTokens: 20_000
        },
        verificationPlan: []
      }
    });

    expect(policy.budget.maxUsd).toBe(6);
    expect(policy.budget.softLimitUsd).toBe(4.5);
    expect(policy.task.verificationPlan).toEqual(["pnpm test"]);
    expect(policy.governance).toEqual({
      policyProfile: "balanced",
      telemetryDestination: "local-only",
      destructiveActionPolicy: "approval"
    });
  });
});
