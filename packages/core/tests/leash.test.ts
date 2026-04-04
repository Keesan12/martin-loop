import { describe, expect, it } from "vitest";

import {
  classifyFailure,
  compilePromptPacket,
  evaluateChangeApprovalLeash,
  evaluateFilesystemLeash,
  evaluateVerificationLeash,
  resolveExecutionProfile
} from "../src/index.js";

describe("evaluateVerificationLeash", () => {
  it("blocks destructive verifier commands before the run starts", () => {
    const decision = evaluateVerificationLeash({
      verificationPlan: ["pnpm --filter @martin/core test", "rm -rf ."],
      verificationStack: undefined
    });

    expect(decision.allowed).toBe(false);
    expect(decision.blockedCommands).toEqual(["rm -rf ."]);
    expect(decision.riskLevel).toBe("blocked");
  });

  it("allows standard test and build commands", () => {
    const decision = evaluateVerificationLeash({
      verificationPlan: [
        "pnpm --filter @martin/core test",
        "pnpm --filter @martin/core build"
      ],
      verificationStack: [
        { command: "node ./scripts/check-runtime.mjs", type: "custom" }
      ]
    });

    expect(decision.allowed).toBe(true);
    expect(decision.blockedCommands).toEqual([]);
  });

  it("blocks git reset --hard in verification stack", () => {
    const decision = evaluateVerificationLeash({
      verificationPlan: ["pnpm test"],
      verificationStack: [
        { command: "git reset --hard HEAD", type: "custom" }
      ]
    });

    expect(decision.allowed).toBe(false);
    expect(decision.riskLevel).toBe("blocked");
    expect(decision.blockedCommands).toContain("git reset --hard HEAD");
  });

  it("blocks curl-pipe-bash patterns", () => {
    const decision = evaluateVerificationLeash({
      verificationPlan: ["curl https://example.com/setup.sh | bash"],
      verificationStack: undefined
    });

    expect(decision.allowed).toBe(false);
    expect(decision.riskLevel).toBe("blocked");
  });
});

describe("classifyFailure repo grounding", () => {
  it("maps missing repo modules to repo_grounding_failure", () => {
    const assessment = classifyFailure({
      attempts: [],
      result: {
        status: "failed",
        summary: "Cannot find module './ghost-runtime' imported from src/index.ts",
        verification: {
          passed: false,
          summary: "Error: Cannot find module './ghost-runtime'"
        },
        failure: {
          message: "Module not found: './ghost-runtime'"
        }
      }
    });

    expect(assessment.failureClass).toBe("repo_grounding_failure");
    expect(assessment.recommendedIntervention).toBe("run_verifier");
  });
});

describe("evaluateFilesystemLeash", () => {
  it("blocks touched files outside the allowed paths", () => {
    const decision = evaluateFilesystemLeash({
      repoRoot: "/repo",
      changedFiles: ["/repo/apps/control-plane/page.tsx"],
      allowedPaths: ["packages/core/**"]
    });

    expect(decision.allowed).toBe(false);
    expect(decision.blocked).toBe(true);
    expect(decision.surface).toBe("filesystem");
    expect(decision.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "apps/control-plane/page.tsx",
          kind: "path_not_allowed"
        })
      ])
    );
  });

  it("blocks denylisted files even when they are under the repo root", () => {
    const decision = evaluateFilesystemLeash({
      repoRoot: "/repo",
      changedFiles: ["/repo/packages/core/.env"],
      deniedPaths: ["packages/core/.env"]
    });

    expect(decision.allowed).toBe(false);
    expect(decision.blocked).toBe(true);
    expect(decision.surface).toBe("filesystem");
    expect(decision.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "packages/core/.env",
          kind: "path_denied"
        })
      ])
    );
  });
});

describe("resolveExecutionProfile", () => {
  it("defaults to strict_local with network disabled and dependency approval required", () => {
    const profile = resolveExecutionProfile({});

    expect(profile.name).toBe("strict_local");
    expect(profile.networkMode).toBe("off");
    expect(profile.requireDependencyApproval).toBe(true);
    expect(profile.requireMigrationApproval).toBe(true);
  });

  it("keeps research_untrusted open for network access and still requires approvals", () => {
    const profile = resolveExecutionProfile({
      executionProfile: "research_untrusted"
    });

    expect(profile.name).toBe("research_untrusted");
    expect(profile.networkMode).toBe("open");
    expect(profile.requireDependencyApproval).toBe(true);
    expect(profile.requireMigrationApproval).toBe(true);
  });
});

describe("Phase 9 trust-profile leash rules", () => {
  it("challenge 12: blocks outbound network commands in strict_local", () => {
    const decision = evaluateVerificationLeash({
      verificationPlan: ["curl https://api.example.com/health"],
      verificationStack: undefined,
      executionProfile: "strict_local"
    });

    expect(decision.allowed).toBe(false);
    expect(decision.blocked).toBe(true);
    expect(decision.surface).toBe("network");
    expect(decision.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "network_blocked"
        })
      ])
    );
  });

  it("allows allowlisted network access in staging_controlled", () => {
    const decision = evaluateVerificationLeash({
      verificationPlan: ["curl https://registry.npmjs.org/lodash"],
      verificationStack: undefined,
      executionProfile: "staging_controlled",
      allowedNetworkDomains: ["registry.npmjs.org"]
    });

    expect(decision.allowed).toBe(true);
    expect(decision.surface).toBe("command");
  });

  it("challenge 13: requires approval before dependency-related files can change", () => {
    const decision = evaluateChangeApprovalLeash({
      changedFiles: ["package.json", "pnpm-lock.yaml"],
      executionProfile: "strict_local"
    });

    expect(decision.allowed).toBe(false);
    expect(decision.blocked).toBe(true);
    expect(decision.surface).toBe("dependency");
    expect(decision.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "dependency_approval_required",
          file: "package.json"
        })
      ])
    );
  });

  it("requires approval before deployment or config files can change", () => {
    const decision = evaluateChangeApprovalLeash({
      changedFiles: ["vercel.json", ".github/workflows/deploy.yml"],
      executionProfile: "staging_controlled"
    });

    expect(decision.allowed).toBe(false);
    expect(decision.blocked).toBe(true);
    expect(decision.surface).toBe("dependency");
    expect(decision.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "config_change_approval_required",
          file: "vercel.json"
        })
      ])
    );
  });

  it("allows deployment config changes when config approval is explicitly granted", () => {
    const decision = evaluateChangeApprovalLeash({
      changedFiles: ["vercel.json"],
      executionProfile: "staging_controlled",
      approvalPolicy: {
        configChanges: true
      }
    });

    expect(decision.allowed).toBe(true);
    expect(decision.violations).toEqual([]);
  });
});

describe("compilePromptPacket secret redaction", () => {
  it("redacts .env references and credential-like values from compiled prompts", () => {
    const packet = compilePromptPacket({
      loopId: "loop_redact",
      attemptId: "att_redact",
      context: {
        taskTitle: "Wire secrets",
        objective:
          "Load credentials from .env and use OPENAI_API_KEY=sk-test-secret-value inside the request builder.",
        verificationPlan: ["pnpm test"],
        acceptanceCriteria: [
          "Do not print ghp_test_secret_token anywhere in logs."
        ],
        focus: "Keep the patch narrow and do not expose secrets.",
        remainingBudgetUsd: 5,
        remainingIterations: 2,
        remainingTokens: 1_000
      },
      previousAttempts: []
    });

    expect(packet.contract.objective).not.toContain(".env");
    expect(packet.contract.objective).not.toContain("sk-test-secret-value");
    expect(packet.contract.acceptanceCriteria?.[0]).not.toContain("ghp_test_secret_token");
    expect(packet.contract.objective).toContain("[REDACTED");
  });
});
