// SPDX-FileCopyrightText: MartinLoop contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createLoopRecord } from "@martin/contracts";
import type { LoopRecord, ReceiptIntegritySummary } from "@martin/contracts";
import {
  buildVerifiedHandoff,
  resolveVerifiedHandoffOutcome,
  toTestIntegrityVerdict,
  verifierActuallyPassed,
} from "../src/verified-handoff.js";
import type { BuildVerifiedHandoffInput } from "../src/verified-handoff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLoop(
  overrides: Partial<LoopRecord> = {}
): LoopRecord {
  const base = createLoopRecord({
    workspaceId: "ws_test",
    projectId: "proj_test",
    task: {
      title: "Test task",
      objective: "Verify something",
      verificationPlan: ["pnpm test"],
      acceptanceCriteria: ["All tests pass"],
    },
  });
  return {
    ...base,
    attempts: [
      {
        attemptId: "attempt_real",
        index: 1,
        adapterId: "agent-cli:codex",
        model: "gpt-5.4",
        startedAt: "2026-08-18T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function makeIntegrity(
  state: ReceiptIntegritySummary["state"] = "verified"
): ReceiptIntegritySummary {
  return { state };
}

function makeInput(
  overrides: Partial<BuildVerifiedHandoffInput> = {}
): BuildVerifiedHandoffInput {
  return {
    loop: makeLoop(),
    receiptIntegrity: makeIntegrity(),
    verification: {
      status: "passed",
      summary: "All verifier steps passed.",
      steps: [
        {
          command: "pnpm test",
          launched: true,
          completed: true,
          crashed: false,
          exitCode: 0,
          timedOut: false,
        },
      ],
      warnings: [],
    },
    nextAction: "Review and decide whether to merge.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveVerifiedHandoffOutcome
// ---------------------------------------------------------------------------

describe("resolveVerifiedHandoffOutcome", () => {
  it("returns VERIFIED when evidence passes and receipt is verified", () => {
    const outcome = resolveVerifiedHandoffOutcome({
      lifecycleState: "completed",
      verificationStatus: "passed",
      receiptIntegrity: "verified",
      unresolvedWorkCount: 0,
    });
    expect(outcome).toBe("VERIFIED");
  });

  it("returns NEEDS_REVIEW when the execution cannot make governance claims", () => {
    expect(
      resolveVerifiedHandoffOutcome({
        lifecycleState: "completed",
        verificationStatus: "passed",
        receiptIntegrity: "verified",
        governanceClaimEligible: false,
        unresolvedWorkCount: 0,
      })
    ).toBe("NEEDS_REVIEW");
  });

  it("returns STOPPED on budget_exit regardless of verifier", () => {
    const outcome = resolveVerifiedHandoffOutcome({
      lifecycleState: "budget_exit",
      verificationStatus: "passed",
      receiptIntegrity: "verified",
      unresolvedWorkCount: 0,
    });
    expect(outcome).toBe("STOPPED");
  });

  it("returns STOPPED on diminishing_returns", () => {
    expect(
      resolveVerifiedHandoffOutcome({
        lifecycleState: "diminishing_returns",
        verificationStatus: "passed",
        receiptIntegrity: "verified",
        unresolvedWorkCount: 0,
      })
    ).toBe("STOPPED");
  });

  it("returns STOPPED on stuck_exit", () => {
    expect(
      resolveVerifiedHandoffOutcome({
        lifecycleState: "stuck_exit",
        verificationStatus: "passed",
        receiptIntegrity: "verified",
        unresolvedWorkCount: 0,
      })
    ).toBe("STOPPED");
  });

  it("returns STOPPED on human_escalation", () => {
    expect(
      resolveVerifiedHandoffOutcome({
        lifecycleState: "human_escalation",
        verificationStatus: "passed",
        receiptIntegrity: "verified",
        unresolvedWorkCount: 0,
      })
    ).toBe("STOPPED");
  });

  it("returns NEEDS_REVIEW when verifier is contradicted", () => {
    const outcome = resolveVerifiedHandoffOutcome({
      lifecycleState: "completed",
      verificationStatus: "contradicted",
      receiptIntegrity: "verified",
      unresolvedWorkCount: 0,
    });
    expect(outcome).toBe("NEEDS_REVIEW");
  });

  it("returns NEEDS_REVIEW when verifier failed", () => {
    expect(
      resolveVerifiedHandoffOutcome({
        lifecycleState: "completed",
        verificationStatus: "failed",
        receiptIntegrity: "verified",
        unresolvedWorkCount: 0,
      })
    ).toBe("NEEDS_REVIEW");
  });

  it("returns NEEDS_REVIEW when receipt is tampered", () => {
    expect(
      resolveVerifiedHandoffOutcome({
        lifecycleState: "completed",
        verificationStatus: "passed",
        receiptIntegrity: "tamper_detected",
        unresolvedWorkCount: 0,
      })
    ).toBe("NEEDS_REVIEW");
  });

  it("returns NEEDS_REVIEW when receipt is unsigned", () => {
    expect(
      resolveVerifiedHandoffOutcome({
        lifecycleState: "completed",
        verificationStatus: "passed",
        receiptIntegrity: "unsigned",
        unresolvedWorkCount: 0,
      })
    ).toBe("NEEDS_REVIEW");
  });

  it("returns NEEDS_REVIEW when there is unresolved work", () => {
    expect(
      resolveVerifiedHandoffOutcome({
        lifecycleState: "completed",
        verificationStatus: "passed",
        receiptIntegrity: "verified",
        unresolvedWorkCount: 1,
      })
    ).toBe("NEEDS_REVIEW");
  });

  it("returns NEEDS_REVIEW when scope has a violation", () => {
    expect(
      resolveVerifiedHandoffOutcome({
        lifecycleState: "completed",
        verificationStatus: "passed",
        receiptIntegrity: "verified",
        scopeStatus: "VIOLATION_REJECTED",
        unresolvedWorkCount: 0,
      })
    ).toBe("NEEDS_REVIEW");
  });

  it("allows NOT_EVALUATED scope without blocking VERIFIED", () => {
    expect(
      resolveVerifiedHandoffOutcome({
        lifecycleState: "completed",
        verificationStatus: "passed",
        receiptIntegrity: "verified",
        scopeStatus: "NOT_EVALUATED",
        unresolvedWorkCount: 0,
      })
    ).toBe("VERIFIED");
  });

  it("returns STOPPED when a required write was blocked", () => {
    expect(
      resolveVerifiedHandoffOutcome({
        lifecycleState: "completed",
        executionStatus: "write_blocked",
        verificationStatus: "passed",
        receiptIntegrity: "verified",
        mutationRequired: true,
        changedFileCount: 0,
        definitionOfDonePreSatisfied: false,
        unresolvedWorkCount: 0,
      })
    ).toBe("STOPPED");
  });

  it("returns NEEDS_REVIEW when mutation was required but no change or pre-satisfied DoD evidence exists", () => {
    expect(
      resolveVerifiedHandoffOutcome({
        lifecycleState: "completed",
        executionStatus: "completed",
        verificationStatus: "passed",
        receiptIntegrity: "verified",
        mutationRequired: true,
        changedFileCount: 0,
        definitionOfDonePreSatisfied: false,
        unresolvedWorkCount: 0,
      })
    ).toBe("NEEDS_REVIEW");
  });

  it("permits an auditable pre-satisfied no-change task to verify", () => {
    expect(
      resolveVerifiedHandoffOutcome({
        lifecycleState: "completed",
        executionStatus: "completed",
        verificationStatus: "passed",
        receiptIntegrity: "verified",
        mutationRequired: true,
        changedFileCount: 0,
        definitionOfDonePreSatisfied: true,
        unresolvedWorkCount: 0,
      })
    ).toBe("VERIFIED");
  });

  it("returns NEEDS_REVIEW when evidence is contradicted", () => {
    expect(
      resolveVerifiedHandoffOutcome({
        lifecycleState: "completed",
        executionStatus: "completed",
        verificationStatus: "passed",
        receiptIntegrity: "verified",
        evidenceContradicted: true,
        unresolvedWorkCount: 0,
      })
    ).toBe("NEEDS_REVIEW");
  });
});

describe("verifierActuallyPassed", () => {
  const expected = {
    runId: "run-current",
    workspaceId: "workspace-A",
    cwd: "/repo-a",
    commands: ["npm test"],
  };

  const passing = {
    passed: true,
    summary: "passed",
    binding: expected,
    steps: [{ command: "npm test", launched: true, completed: true, crashed: false, exitCode: 0, timedOut: false }],
  };

  it("accepts only completed exit-zero evidence bound to the current run and workspace", () => {
    expect(verifierActuallyPassed(passing, expected)).toBe(true);
  });

  it.each([
    ["never launched", { steps: [{ command: "npm test", launched: false, exitCode: 1, timedOut: false }] }],
    ["incomplete", { steps: [{ command: "npm test", launched: true, completed: false, crashed: false, exitCode: 0, timedOut: false }] }],
    ["crashed", { steps: [{ command: "npm test", launched: true, completed: false, crashed: true, exitCode: 0, timedOut: false }] }],
    ["nonzero", { steps: [{ command: "npm test", launched: true, exitCode: 1, timedOut: false }] }],
    ["timeout", { steps: [{ command: "npm test", launched: true, exitCode: 1, timedOut: true }] }],
    ["prior run", { binding: { ...expected, runId: "run-old" } }],
    ["other workspace", { binding: { ...expected, workspaceId: "workspace-B" } }],
    ["wrong cwd", { binding: { ...expected, cwd: "/repo-b" } }],
    ["wrong command config", { binding: { ...expected, commands: ["npm run other"] } }],
  ])("rejects %s verifier evidence", (_label, override) => {
    expect(verifierActuallyPassed({ ...passing, ...override }, expected)).toBe(false);
  });

  it("rejects missing verifier evidence", () => {
    expect(verifierActuallyPassed(undefined, expected)).toBe(false);
  });

  it("rejects verifier-free evidence instead of passing vacuously", () => {
    const emptyBinding = { ...expected, commands: [] };
    expect(
      verifierActuallyPassed(
        { passed: true, binding: emptyBinding, steps: [] },
        emptyBinding
      )
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toTestIntegrityVerdict mapping
// ---------------------------------------------------------------------------

describe("toTestIntegrityVerdict", () => {
  it("maps UNCHANGED → VERIFIED", () => {
    expect(toTestIntegrityVerdict("UNCHANGED")).toBe("VERIFIED");
  });

  it("maps AUTHORIZED_CHANGE → VERIFIED", () => {
    expect(toTestIntegrityVerdict("AUTHORIZED_CHANGE")).toBe("VERIFIED");
  });

  it("maps PREVENTED → TAMPERING_DETECTED", () => {
    expect(toTestIntegrityVerdict("PREVENTED")).toBe("TAMPERING_DETECTED");
  });

  it("maps DETECTED_AND_ROLLED_BACK → TAMPERING_DETECTED", () => {
    expect(toTestIntegrityVerdict("DETECTED_AND_ROLLED_BACK")).toBe("TAMPERING_DETECTED");
  });

  it("maps DETECTED_NEEDS_REVIEW → TAMPERING_DETECTED", () => {
    expect(toTestIntegrityVerdict("DETECTED_NEEDS_REVIEW")).toBe("TAMPERING_DETECTED");
  });

  it("maps NOT_EVALUATED → NOT_EVALUATED", () => {
    expect(toTestIntegrityVerdict("NOT_EVALUATED")).toBe("NOT_EVALUATED");
  });
});

// ---------------------------------------------------------------------------
// buildVerifiedHandoff — full builder
// ---------------------------------------------------------------------------

describe("buildVerifiedHandoff", () => {
  it("produces VERIFIED for a clean passed run with verified receipt", () => {
    const handoff = buildVerifiedHandoff(makeInput());
    expect(handoff.outcome).toBe("VERIFIED");
    expect(handoff.schemaVersion).toBe("1.0.0");
    expect(handoff.handoffId).toMatch(/^vh_[0-9a-f]{16}$/);
  });

  it("does not produce VERIFIED when no verifier step ran", () => {
    const handoff = buildVerifiedHandoff(
      makeInput({
        verification: {
          status: "passed",
          summary: "No verification commands specified.",
          steps: [],
          warnings: [],
        },
      })
    );

    expect(handoff.outcome).not.toBe("VERIFIED");
    expect(handoff.verification.status).not.toBe("PASSED");
  });

  it("fails closed for legacy direct stub evidence", () => {
    const handoff = buildVerifiedHandoff(
      makeInput({
        loop: makeLoop({
          status: "completed",
          lifecycleState: "completed",
          attempts: [
            {
              attemptId: "attempt_stub",
              index: 1,
              adapterId: "direct:stub:stub",
              model: "stub",
              startedAt: "2026-08-18T00:00:00.000Z",
              completedAt: "2026-08-18T00:00:01.000Z",
            },
          ],
        }),
      })
    );

    expect(handoff.executionMode).toBe("simulated");
    expect(handoff.governanceClaimEligible).toBe(false);
    expect(handoff.outcome).toBe("NEEDS_REVIEW");
  });

  it("fails closed for deterministic fixture adapters", () => {
    const handoff = buildVerifiedHandoff(
      makeInput({
        loop: makeLoop({
          attempts: [
            {
              attemptId: "attempt_fixture",
              index: 1,
              adapterId: "direct:fixture:deterministic",
              model: "fixture",
              startedAt: "2026-08-18T00:00:00.000Z",
            },
          ],
        }),
      })
    );

    expect(handoff.executionMode).toBe("simulated");
    expect(handoff.governanceClaimEligible).toBe(false);
    expect(handoff.outcome).toBe("NEEDS_REVIEW");
  });

  it("fails closed for exported stub agent adapters", () => {
    const handoff = buildVerifiedHandoff(
      makeInput({
        loop: makeLoop({
          attempts: [
            {
              attemptId: "attempt_stub_agent",
              index: 1,
              adapterId: "agent-cli:stub:codex",
              model: "codex",
              startedAt: "2026-08-18T00:00:00.000Z",
            },
          ],
        }),
      })
    );

    expect(handoff.executionMode).toBe("simulated");
    expect(handoff.governanceClaimEligible).toBe(false);
    expect(handoff.outcome).toBe("NEEDS_REVIEW");
  });

  it("keeps a zero-cost real governed adapter eligible", () => {
    const handoff = buildVerifiedHandoff(
      makeInput({
        loop: makeLoop({
          status: "completed",
          lifecycleState: "completed",
          cost: {
            actualUsd: 0,
            avoidedUsd: 0,
            tokensIn: 0,
            tokensOut: 0,
          },
          attempts: [
            {
              attemptId: "attempt_codex",
              index: 1,
              adapterId: "agent-cli:codex",
              model: "gpt-5.4",
              startedAt: "2026-08-18T00:00:00.000Z",
              completedAt: "2026-08-18T00:00:01.000Z",
            },
          ],
        }),
      })
    );

    expect(handoff.executionMode).toBe("governed");
    expect(handoff.governanceClaimEligible).toBe(true);
    expect(handoff.outcome).toBe("VERIFIED");
  });

  it("marks verifier-only evidence as ineligible for governed VERIFIED", () => {
    const handoff = buildVerifiedHandoff(
      makeInput({
        loop: makeLoop({
          status: "completed",
          lifecycleState: "completed",
          attempts: [
            {
              attemptId: "attempt_verifier",
              index: 1,
              adapterId: "direct:verifier:verify-only",
              model: "verify-only",
              startedAt: "2026-08-18T00:00:00.000Z",
              completedAt: "2026-08-18T00:00:01.000Z",
            },
          ],
        }),
      })
    );

    expect(handoff.executionMode).toBe("verification_only");
    expect(handoff.governanceClaimEligible).toBe(false);
    expect(handoff.outcome).toBe("NEEDS_REVIEW");
  });

  it("produces STOPPED when lifecycle state is budget_exit", () => {
    const handoff = buildVerifiedHandoff(
      makeInput({ loop: makeLoop({ lifecycleState: "budget_exit" }) })
    );
    expect(handoff.outcome).toBe("STOPPED");
  });

  it("produces NEEDS_REVIEW when verifier is failed", () => {
    const handoff = buildVerifiedHandoff(
      makeInput({
        verification: {
          status: "failed",
          summary: "Tests failed.",
          steps: [{ command: "pnpm test", launched: true, exitCode: 1 }],
          warnings: [],
        },
      })
    );
    expect(handoff.outcome).toBe("NEEDS_REVIEW");
  });

  it("stops before test-integrity runs → testIntegrity shows NOT_EVALUATED", () => {
    const handoff = buildVerifiedHandoff(
      makeInput({ loop: makeLoop({ lifecycleState: "budget_exit" }) })
    );
    expect(handoff.testIntegrity.status).toBe("NOT_EVALUATED");
    expect(handoff.testIntegrity.verdict).toBe("NOT_EVALUATED");
  });

  it("missing testIntegrity input renders NOT_EVALUATED, never UNCHANGED", () => {
    const input = makeInput();
    delete (input as Partial<BuildVerifiedHandoffInput>).testIntegrity;
    const handoff = buildVerifiedHandoff(input);
    expect(handoff.testIntegrity.status).toBe("NOT_EVALUATED");
    expect(handoff.testIntegrity.verdict).toBe("NOT_EVALUATED");
  });

  it("check with exitCode 0 shows PASSED", () => {
    const handoff = buildVerifiedHandoff(makeInput());
    expect(handoff.verification.checks[0]?.status).toBe("PASSED");
  });

  it("check with exitCode non-zero shows FAILED", () => {
    const handoff = buildVerifiedHandoff(
      makeInput({
        verification: {
          status: "failed",
          summary: "fail",
          steps: [{ command: "pnpm test", launched: true, exitCode: 1 }],
          warnings: [],
        },
      })
    );
    expect(handoff.verification.checks[0]?.status).toBe("FAILED");
  });

  it("unlaunched step shows NOT_RUN", () => {
    const handoff = buildVerifiedHandoff(
      makeInput({
        verification: {
          status: "not_run",
          summary: "not launched",
          steps: [{ command: "pnpm test", launched: false }],
          warnings: [],
        },
      })
    );
    expect(handoff.verification.checks[0]?.status).toBe("NOT_RUN");
  });

  it("preserves task title and objective from loop record", () => {
    const handoff = buildVerifiedHandoff(makeInput());
    expect(handoff.task.title).toBe("Test task");
    expect(handoff.task.objective).toBe("Verify something");
  });

  it("handoffId is deterministic for same loopId + generatedAt", () => {
    const at = "2026-07-31T00:00:00.000Z";
    const loop = makeLoop({ loopId: "loop_abc123" });
    const a = buildVerifiedHandoff(makeInput({ loop, generatedAt: at }));
    const b = buildVerifiedHandoff(makeInput({ loop, generatedAt: at }));
    expect(a.handoffId).toBe(b.handoffId);
  });

  it("stopReason is omitted when not provided", () => {
    const handoff = buildVerifiedHandoff(makeInput());
    expect(handoff).not.toHaveProperty("stopReason");
  });

  it("stopReason is present when provided", () => {
    const handoff = buildVerifiedHandoff(makeInput({ stopReason: "budget_exceeded" }));
    expect(handoff.stopReason).toBe("budget_exceeded");
  });
});
