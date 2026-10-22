/**
 * RED→GREEN tests for Stage B: provider prompt must receive exact verifier
 * failure context on repair attempts.
 *
 * The RED state: when intervention === "run_verifier" the prompt currently says
 * "mentally simulate running each verification command" — generic, not actionable.
 *
 * The GREEN state: when request.context.lastVerifierFailure is present, the prompt
 * must contain a concrete PREVIOUS ATTEMPT FAILED VERIFICATION section with the
 * exact command, exit code, and bounded failure excerpt.
 */

import { describe, expect, it } from "vitest";

import { __buildPromptForTests } from "../src/claude-cli.js";
import type { MartinAdapterRequest } from "@martin/core";

function makeBaseRequest(overrides: Partial<MartinAdapterRequest> = {}): MartinAdapterRequest {
  return {
    loopId: "loop_test",
    workspaceId: "ws_test",
    attemptId: "att_test",
    context: {
      taskTitle: "Add protocol-relative path rejection",
      objective: "In config.js make normalizePath throw for // paths.",
      verificationPlan: ["pnpm --dir apps/extension test"],
      mutationMode: "edit",
      repoRoot: "/repo",
      focus: "In config.js make normalizePath throw for // paths.",
      remainingBudgetUsd: 0.30,
      remainingIterations: 2,
      verificationExecutionOwner: "host_only",
    },
    previousAttempts: [],
    ...overrides,
  };
}

describe("Stage B — provider repair prompt", () => {
  // RED: before the fix, the run_verifier block only says "mentally simulate"
  it("RED: run_verifier intervention without lastVerifierFailure uses generic message", () => {
    const request = makeBaseRequest({
      previousAttempts: [{
        attemptId: "att_1",
        index: 1,
        adapterId: "agent-cli:claude",
        startedAt: "2026-10-20T00:00:00.000Z",
        completedAt: "2026-10-20T00:00:30.000Z",
        summary: "Added path check but wrong error type.",
        failureClass: "verification_failure",
        intervention: "run_verifier",
      }],
    });

    const prompt = __buildPromptForTests(request);

    // Without structured failure, the structured repair section must be absent.
    // Note: the command may still appear in the verification plan section — that is fine.
    // What must be absent is the structured PREVIOUS ATTEMPT FAILED VERIFICATION block.
    expect(prompt).not.toContain("PREVIOUS ATTEMPT FAILED VERIFICATION");
    expect(prompt).not.toContain("Native exit:");
    // AssertionError is failure-specific — must not appear without the failure context
    expect(prompt).not.toContain("AssertionError");
  });

  // GREEN: after the fix, lastVerifierFailure produces a concrete repair section
  it("GREEN: run_verifier + lastVerifierFailure produces exact failure section in prompt", () => {
    const request = makeBaseRequest({
      context: {
        taskTitle: "Add protocol-relative path rejection",
        objective: "In config.js make normalizePath throw for // paths.",
        verificationPlan: ["pnpm --dir apps/extension test"],
        mutationMode: "edit",
        repoRoot: "/repo",
        focus: "In config.js make normalizePath throw for // paths.",
        remainingBudgetUsd: 0.30,
        remainingIterations: 2,
        verificationExecutionOwner: "host_only",
        lastVerifierFailure: {
          command: "pnpm --dir apps/extension test",
          exitCode: 1,
          failureExcerpt: [
            "FAIL apps/extension/test/runtime-config.test.mjs",
            "  ✗ normalizePath rejects protocol-relative paths",
            "    AssertionError: expected function to throw Error",
            "    but it threw the wrong type",
          ].join("\n"),
          attemptId: "att_1",
          attemptIndex: 1,
        },
      },
      previousAttempts: [{
        attemptId: "att_1",
        index: 1,
        adapterId: "agent-cli:claude",
        startedAt: "2026-10-20T00:00:00.000Z",
        completedAt: "2026-10-20T00:00:30.000Z",
        summary: "Added path check but wrong error type.",
        failureClass: "verification_failure",
        intervention: "run_verifier",
      }],
    });

    const prompt = __buildPromptForTests(request);

    // Must contain the specific failing command
    expect(prompt).toContain("pnpm --dir apps/extension test");
    // Must contain the native exit code
    expect(prompt).toContain("1");
    // Must contain the specific assertion failure
    expect(prompt).toContain("AssertionError");
    expect(prompt).toContain("normalizePath rejects protocol-relative paths");
    // Must NOT fall back to "mentally simulate"
    expect(prompt).not.toContain("mentally simulate");
    // Must instruct repair, not retry
    expect(prompt.toLowerCase()).toMatch(/repair|fix|failure/);
  });

  it("fallback: run_verifier without lastVerifierFailure still gives actionable (not generic simulation) message", () => {
    const request = makeBaseRequest({
      previousAttempts: [{
        attemptId: "att_1",
        index: 1,
        adapterId: "agent-cli:claude",
        startedAt: "2026-10-20T00:00:00.000Z",
        completedAt: "2026-10-20T00:00:30.000Z",
        summary: "Implementation incomplete.",
        failureClass: "verification_failure",
        intervention: "run_verifier",
      }],
    });

    const prompt = __buildPromptForTests(request);
    // No "mentally simulate" even in the fallback case
    expect(prompt).not.toContain("mentally simulate");
  });

  it("first attempt (no previousAttempts) does not contain repair section", () => {
    const request = makeBaseRequest();
    const prompt = __buildPromptForTests(request);
    expect(prompt).not.toContain("PREVIOUS ATTEMPT FAILED VERIFICATION");
    expect(prompt).not.toContain("mentally simulate");
  });
});
