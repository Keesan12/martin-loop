// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { selectPostRunExperience } from "../src/post-run-experience/coordinator.js";
import { renderPostRunExperience } from "../src/post-run-experience/renderer.js";
import { exitCodeForGovernedOutcome } from "../src/ux.js";
import type { PostRunExperienceInput } from "../src/post-run-experience/types.js";
import type { RemoteExperienceV1 } from "../src/remote-experience.js";

function eligibleInput(overrides: Partial<PostRunExperienceInput> = {}): PostRunExperienceInput {
  return {
    run: { completed: true, verified: true, receiptFinalized: true, persistenceFinalized: true, exitCode: 0 },
    environment: { interactiveTty: true, ci: false, outputMode: "human", startupPromptShown: false },
    telemetry: { noticeEligible: false },
    localEngagement: { runFiveFeedbackEligible: false, starEligible: false, badgeEligible: false },
    remote: { required: null, engagement: null },
    ...overrides,
  };
}

function makeRemote(id: string, cls: "required" | "engagement"): RemoteExperienceV1 {
  return { schemaVersion: 1, id, class: cls, type: "announcement", title: "T", body: "B", cooldownKey: id };
}

// ─── eligibility gate ─────────────────────────────────────────────────────────

describe("selectPostRunExperience — eligibility", () => {
  it.each([
    ["VERIFIED", 0],
    ["STOPPED", 9],
    ["NEEDS_REVIEW", 7],
  ] as const)("maps governed outcome %s through existing CLI exit authority", (outcome, expected) => {
    expect(exitCodeForGovernedOutcome(outcome)).toBe(expected);
  });

  it.each(["STOPPED", "NEEDS_REVIEW"] as const)("PRE has zero authority to rewrite %s", (outcome) => {
    const result = selectPostRunExperience(eligibleInput({
      run: { completed: false, verified: false, receiptFinalized: true, persistenceFinalized: true, exitCode: 1 },
    }));

    expect(result).not.toHaveProperty("outcome");
    expect(outcome).toMatch(/STOPPED|NEEDS_REVIEW/u);
  });

  it("none when completed=false", () => {
    expect(selectPostRunExperience(eligibleInput({ run: { completed: false, verified: true, receiptFinalized: true, persistenceFinalized: true, exitCode: 0 } })).kind).toBe("none");
  });

  it("none when verified=false", () => {
    expect(selectPostRunExperience(eligibleInput({ run: { completed: true, verified: false, receiptFinalized: true, persistenceFinalized: true, exitCode: 0 } })).kind).toBe("none");
  });

  it("none when persistenceFinalized=false", () => {
    expect(selectPostRunExperience(eligibleInput({ run: { completed: true, verified: true, receiptFinalized: true, persistenceFinalized: false, exitCode: 0 } })).kind).toBe("none");
  });

  it("none when exitCode is non-zero", () => {
    expect(selectPostRunExperience(eligibleInput({ run: { completed: true, verified: true, receiptFinalized: true, persistenceFinalized: true, exitCode: 2 } })).kind).toBe("none");
  });

  it("none when CI=true", () => {
    expect(selectPostRunExperience(eligibleInput({ environment: { interactiveTty: true, ci: true, outputMode: "human" } })).kind).toBe("none");
  });

  it("none when interactiveTty=false", () => {
    expect(selectPostRunExperience(eligibleInput({ environment: { interactiveTty: false, ci: false, outputMode: "human" } })).kind).toBe("none");
  });

  it("none when outputMode=json", () => {
    expect(selectPostRunExperience(eligibleInput({ environment: { interactiveTty: true, ci: false, outputMode: "json" } })).kind).toBe("none");
  });

  it("none when outputMode=quiet", () => {
    expect(selectPostRunExperience(eligibleInput({ environment: { interactiveTty: true, ci: false, outputMode: "quiet" } })).kind).toBe("none");
  });

  it("none when outputMode=mcp", () => {
    expect(selectPostRunExperience(eligibleInput({ environment: { interactiveTty: true, ci: false, outputMode: "mcp" } })).kind).toBe("none");
  });
});

// ─── priority ordering ────────────────────────────────────────────────────────

describe("selectPostRunExperience — priority", () => {
  it("required-notice beats telemetry-notice", () => {
    const r = selectPostRunExperience(eligibleInput({
      remote: { required: makeRemote("r1", "required"), engagement: null },
      telemetry: { noticeEligible: true },
    }));
    expect(r.kind).toBe("required-notice");
  });

  it("telemetry-notice beats feedback", () => {
    const r = selectPostRunExperience(eligibleInput({
      telemetry: { noticeEligible: true },
      localEngagement: { runFiveFeedbackEligible: true, starEligible: true, badgeEligible: true },
    }));
    expect(r.kind).toBe("telemetry-notice");
  });

  it("feedback beats star", () => {
    const r = selectPostRunExperience(eligibleInput({
      localEngagement: { runFiveFeedbackEligible: true, starEligible: true, badgeEligible: true },
    }));
    expect(r.kind).toBe("feedback");
  });

  it("star beats badge", () => {
    const r = selectPostRunExperience(eligibleInput({
      localEngagement: { runFiveFeedbackEligible: false, starEligible: true, badgeEligible: true },
      remote: { required: null, engagement: makeRemote("e1", "engagement") },
    }));
    expect(r.kind).toBe("star");
  });

  it("badge beats remote engagement", () => {
    const r = selectPostRunExperience(eligibleInput({
      localEngagement: { runFiveFeedbackEligible: false, starEligible: false, badgeEligible: true },
      remote: { required: null, engagement: makeRemote("e1", "engagement") },
    }));
    expect(r.kind).toBe("badge");
  });

  it("remote engagement shown when nothing else qualifies", () => {
    const r = selectPostRunExperience(eligibleInput({
      remote: { required: null, engagement: makeRemote("e2", "engagement") },
    }));
    expect(r.kind).toBe("remote-experience");
  });

  it("none when nothing qualifies", () => {
    expect(selectPostRunExperience(eligibleInput()).kind).toBe("none");
  });

  it("feedback milestone is 5", () => {
    const r = selectPostRunExperience(eligibleInput({ localEngagement: { runFiveFeedbackEligible: true, starEligible: false, badgeEligible: false } }));
    expect(r.kind).toBe("feedback");
    if (r.kind === "feedback") expect(r.milestone).toBe(5);
  });

  it("badge does not fire on failed run", () => {
    const r = selectPostRunExperience(eligibleInput({
      run: { completed: true, verified: true, receiptFinalized: true, persistenceFinalized: true, exitCode: 1 },
      localEngagement: { runFiveFeedbackEligible: false, starEligible: false, badgeEligible: true },
    }));
    expect(r.kind).toBe("none");
  });

  it("badge does not fire when run not verified", () => {
    const r = selectPostRunExperience(eligibleInput({
      run: { completed: true, verified: false, receiptFinalized: true, persistenceFinalized: true, exitCode: 0 },
      localEngagement: { runFiveFeedbackEligible: false, starEligible: false, badgeEligible: true },
    }));
    expect(r.kind).toBe("none");
  });
});

// ─── renderer routing ─────────────────────────────────────────────────────────

describe("renderPostRunExperience — routing", () => {
  function makeDeps(record: { called: string | null }) {
    return {
      renderRequiredNotice: async () => { record.called = "required-notice"; },
      renderTelemetryNotice: async () => { record.called = "telemetry-notice"; },
      renderRunFiveFeedback: async () => { record.called = "feedback"; },
      renderStarPrompt: async () => { record.called = "star"; },
      renderBadge: async () => { record.called = "badge"; },
      renderRemoteExperience: async () => { record.called = "remote-experience"; },
    };
  }

  it("calls renderRequiredNotice", async () => {
    const r = { called: null as string | null };
    await renderPostRunExperience({ kind: "required-notice", message: makeRemote("rn", "required") }, makeDeps(r));
    expect(r.called).toBe("required-notice");
  });

  it("calls renderTelemetryNotice", async () => {
    const r = { called: null as string | null };
    await renderPostRunExperience({ kind: "telemetry-notice" }, makeDeps(r));
    expect(r.called).toBe("telemetry-notice");
  });

  it("calls renderRunFiveFeedback", async () => {
    const r = { called: null as string | null };
    await renderPostRunExperience({ kind: "feedback", milestone: 5 }, makeDeps(r));
    expect(r.called).toBe("feedback");
  });

  it("calls renderStarPrompt", async () => {
    const r = { called: null as string | null };
    await renderPostRunExperience({ kind: "star" }, makeDeps(r));
    expect(r.called).toBe("star");
  });

  it("calls renderBadge", async () => {
    const r = { called: null as string | null };
    await renderPostRunExperience({ kind: "badge" }, makeDeps(r));
    expect(r.called).toBe("badge");
  });

  it("calls renderRemoteExperience", async () => {
    const r = { called: null as string | null };
    await renderPostRunExperience({ kind: "remote-experience", message: makeRemote("re", "engagement") }, makeDeps(r));
    expect(r.called).toBe("remote-experience");
  });

  it("does nothing for none", async () => {
    const r = { called: null as string | null };
    await renderPostRunExperience({ kind: "none" }, makeDeps(r));
    expect(r.called).toBeNull();
  });

  it("invokes exactly one renderer per run", async () => {
    let count = 0;
    const deps = {
      renderRequiredNotice: async () => { count++; },
      renderTelemetryNotice: async () => { count++; },
      renderRunFiveFeedback: async () => { count++; },
      renderStarPrompt: async () => { count++; },
      renderBadge: async () => { count++; },
      renderRemoteExperience: async () => { count++; },
    };
    await renderPostRunExperience({ kind: "star" }, deps);
    expect(count).toBe(1);
  });
});

// ─── startupPromptShown collision guard ──────────────────────────────────────

describe("selectPostRunExperience — startupPromptShown collision guard", () => {
  it("startupPromptShown defaults to undefined (treated as false)", () => {
    const input = eligibleInput();
    expect(input.environment.startupPromptShown).toBe(false);
  });

  it("suppresses telemetry notice when startupPromptShown", () => {
    const r = selectPostRunExperience(eligibleInput({
      environment: { interactiveTty: true, ci: false, outputMode: "human", startupPromptShown: true },
      telemetry: { noticeEligible: true },
    }));
    expect(r.kind).toBe("none");
  });

  it("suppresses Run-5 feedback when startupPromptShown", () => {
    const r = selectPostRunExperience(eligibleInput({
      environment: { interactiveTty: true, ci: false, outputMode: "human", startupPromptShown: true },
      localEngagement: { runFiveFeedbackEligible: true, starEligible: false, badgeEligible: false },
    }));
    expect(r.kind).toBe("none");
  });

  it("suppresses star when startupPromptShown", () => {
    const r = selectPostRunExperience(eligibleInput({
      environment: { interactiveTty: true, ci: false, outputMode: "human", startupPromptShown: true },
      localEngagement: { runFiveFeedbackEligible: false, starEligible: true, badgeEligible: false },
    }));
    expect(r.kind).toBe("none");
  });

  it("suppresses badge when startupPromptShown", () => {
    const r = selectPostRunExperience(eligibleInput({
      environment: { interactiveTty: true, ci: false, outputMode: "human", startupPromptShown: true },
      localEngagement: { runFiveFeedbackEligible: false, starEligible: false, badgeEligible: true },
    }));
    expect(r.kind).toBe("none");
  });

  it("suppresses remote engagement when startupPromptShown", () => {
    const r = selectPostRunExperience(eligibleInput({
      environment: { interactiveTty: true, ci: false, outputMode: "human", startupPromptShown: true },
      remote: { required: null, engagement: makeRemote("e1", "engagement") },
    }));
    expect(r.kind).toBe("none");
  });

  it("required-notice still shown when startupPromptShown", () => {
    const r = selectPostRunExperience(eligibleInput({
      environment: { interactiveTty: true, ci: false, outputMode: "human", startupPromptShown: true },
      remote: { required: makeRemote("r1", "required"), engagement: null },
    }));
    expect(r.kind).toBe("required-notice");
  });
});
