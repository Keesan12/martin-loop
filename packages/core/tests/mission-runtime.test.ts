import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifyMissionMemoryRecords,
  createMissionRuntime,
  readMissionRuntimeControlIntent,
  readMissionRuntimeState,
  writeMissionRuntimeControlIntent,
  type MissionChildRunInput,
  type MissionChildRunAdapter,
  type MissionIntegrationAdapter,
  type MissionVerificationAdapter
} from "../src/mission/runtime.js";
import { createMissionSupervisor } from "../src/mission/supervisor.js";
import { MemoryStoreV2, memoryApprovalActionSourceHashV2, type MemoryRecordV2 } from "../src/persistence/memory-store-v2.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "martin-mission-runtime-"));
  roots.push(value);
  return value;
}

const hash = (digit: string): string => digit.repeat(64);
const stableTestId = (prefix: string, ...values: string[]): string =>
  `${prefix}-${createHash("sha256").update(values.join("\u0000"), "utf8").digest("hex").slice(0, 32)}`;

describe("durable mission runtime", () => {
  it("rejects traversal mission ids at every runtime filesystem entrypoint", async () => {
    const missionRoot = await root();
    for (const missionId of ["../escape", "/absolute", "nested/child", "nested\\child", "C:\\escape"]) {
      expect(() => createMissionRuntime({ root: missionRoot, missionId, bindingAuthority: trustedBindings(),
        childRuns: unusedChildAdapter(), verifier: unusedVerifier(), integrator: unusedIntegrator() })).toThrow(/missionId/u);
    }
    await expect(readMissionRuntimeState(missionRoot, "../escape")).rejects.toThrow(/missionId/u);
    await expect(readMissionRuntimeControlIntent(missionRoot, "../escape")).rejects.toThrow(/missionId/u);
  });

  it("rejects an existing junction redirect before mission reads or writes", async (context) => {
    const missionRoot = await root();
    const outside = await root();
    await mkdir(join(missionRoot, "missions"), { recursive: true });
    try {
      await symlink(outside, join(missionRoot, "missions", "redirect"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip(); return;
      }
      throw error;
    }
    const runtimeOptions = { root: missionRoot, missionId: "redirect", bindingAuthority: trustedBindings(),
      childRuns: unusedChildAdapter(), verifier: unusedVerifier(), integrator: unusedIntegrator() };
    expect(() => createMissionRuntime(runtimeOptions)).toThrow(/junction|symbolic|unsafe/u);
    expect(() => createMissionSupervisor({ root: missionRoot, missionId: "redirect" })).toThrow(/junction|symbolic|unsafe/u);
    await expect(readMissionRuntimeState(missionRoot, "redirect")).rejects.toThrow(/junction|symbolic|unsafe/u);
    await expect(readMissionRuntimeControlIntent(missionRoot, "redirect")).rejects.toThrow(/junction|symbolic|unsafe/u);
    await expect(writeMissionRuntimeControlIntent(missionRoot, "redirect", {
      intentId: "junction-intent", action: "pause", reason: "must not escape", requestedAt: "2026-11-03T01:00:00.000Z",
      approval: { schemaVersion: "martin.host-approval.v1", approvalId: "junction-approval", missionId: "redirect",
        action: "pause", actorId: "human:k", issuedAt: "2026-11-03T00:00:00.000Z",
        expiresAt: "2026-11-04T00:00:00.000Z", signature: "signed" }
    }, { authorityId: "host", verify: () => true })).rejects.toThrow(/junction|symbolic|unsafe/u);

    const lateRoot = await root();
    const lateRuntime = createMissionRuntime({ ...runtimeOptions, root: lateRoot, missionId: "late-redirect" });
    const lateSupervisor = createMissionSupervisor({ root: lateRoot, missionId: "late-redirect" });
    await mkdir(join(lateRoot, "missions"), { recursive: true });
    await symlink(outside, join(lateRoot, "missions", "late-redirect"), process.platform === "win32" ? "junction" : "dir");
    await expect(lateRuntime.load()).rejects.toThrow(/junction|symbolic|unsafe/u);
    await expect(lateSupervisor.load()).rejects.toThrow(/junction|symbolic|unsafe/u);
  });

  it("binds source, workspace, queue, context, memory, ledger, and budget authority", async () => {
    const missionRoot = await root();
    const runtime = createMissionRuntime({
      root: missionRoot,
      missionId: "mission-bindings",
      bindingAuthority: trustedBindings(),
      childRuns: unusedChildAdapter(),
      verifier: unusedVerifier(),
      integrator: unusedIntegrator()
    });

    const initialized = await runtime.initialize({
      objective: "ship a verified change",
      sourceSha: hash("a"),
      workspace: { workspaceId: "workspace-1", identityHash: hash("b") },
      context: { manifestHash: hash("c"), tokenCount: 10, compactAtTokens: 100 },
      memory: { ledgerHeadHash: null, snapshotHash: null },
      budget: {
        maxUsd: 5,
        spentUsd: 0,
        maxRuns: 3,
        runsUsed: 0,
        maxTokens: 2_000,
        tokensUsed: 0,
        maxConcurrency: 1,
        activeConcurrency: 0,
        maxNoProgressIntervals: 2,
        noProgressIntervals: 0,
        startedAt: "2026-11-03T00:00:00.000Z",
        wallClockDeadline: "2026-11-04T00:00:00.000Z"
      },
      workItems: [
        { id: "build", title: "Build", dependsOn: [], maxAttempts: 2 },
        { id: "test", title: "Test", dependsOn: ["build"], maxAttempts: 1 }
      ],
      writerId: "runtime-test",
      now: "2026-11-03T00:00:00.000Z"
    });

    expect(initialized.bindings).toMatchObject({
      sourceSha: hash("a"),
      workspaceIdentityHash: hash("b"),
      contextManifestHash: hash("c"),
      memoryLedgerHeadHash: null,
      memorySnapshotHash: null
    });
    expect(initialized.bindings.missionLedgerHeadHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(initialized.bindings.workQueueHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(initialized.settlement.budget).toMatchObject({ maxUsd: 5, maxRuns: 3, maxTokens: 2_000 });
    expect(initialized.queue.map((item) => [item.workItemId, item.phase])).toEqual([
      ["build", "ready"],
      ["test", "waiting"]
    ]);
  });

  it("recovers persisted external-call intents without duplicate launch, settlement, or integration", async () => {
    const missionRoot = await root();
    const calls = { launch: 0, recover: 0, verify: 0, integrate: 0, recoverIntegration: 0 };
    const childRuns: MissionChildRunAdapter = {
      async launch(input) {
        calls.launch += 1;
        return {
          kind: "candidate",
          runId: input.runId,
          receiptHash: hash("1"),
          candidateHash: hash("2"),
          actualUsd: 1,
          tokens: 100,
          handoff: verifiedHandoff(input.missionId, input.runId, hash("1"), "verified child output", 20)
        };
      },
      async recover(input) {
        calls.recover += 1;
        return {
          kind: "candidate",
          runId: input.runId,
          receiptHash: hash("1"),
          candidateHash: hash("2"),
          actualUsd: 1,
          tokens: 100,
          handoff: verifiedHandoff(input.missionId, input.runId, hash("1"), "verified child output", 20)
        };
      }
    };
    const verifier: MissionVerificationAdapter = {
      async verify() {
        calls.verify += 1;
        return { passed: true, verifierId: "verifier-1", evidenceHash: hash("4"), source: "tests" };
      }
    };
    const integrator: MissionIntegrationAdapter = {
      async integrate(input) {
        calls.integrate += 1;
        return { integrationId: input.integrationId, integratedHash: hash("5") };
      },
      async recover(input) {
        calls.recoverIntegration += 1;
        return { integrationId: input.integrationId, integratedHash: hash("5") };
      }
    };
    const options = { root: missionRoot, missionId: "mission-restart", childRuns, verifier, integrator, bindingAuthority: trustedBindings() };
    let runtime = createMissionRuntime(options);
    await runtime.initialize(baseMissionInput());

    const afterLaunchIntent = await runtime.step({ stopAfter: "launch-intent" });
    expect(afterLaunchIntent.queue[0]?.phase).toBe("launching");
    expect(calls.launch).toBe(0);

    runtime = createMissionRuntime(options);
    const finished = await runtime.runUntilBlocked();
    expect(finished.queue[0]?.phase).toBe("integrated");
    expect(calls.launch).toBe(0);
    expect(calls.recover).toBe(1);
    expect(calls.verify).toBe(1);
    expect(calls.integrate).toBe(1);
    expect(finished.failedCandidates).toEqual([]);

    runtime = createMissionRuntime(options);
    const restarted = await runtime.runUntilBlocked();
    expect(restarted.queue[0]?.phase).toBe("integrated");
    expect(calls).toEqual({ launch: 0, recover: 1, verify: 1, integrate: 1, recoverIntegration: 0 });
  });

  it("retains verifier failures separately and never integrates them", async () => {
    const missionRoot = await root();
    let integrations = 0;
    const runtime = createMissionRuntime({
      root: missionRoot,
      missionId: "mission-rejected",
      bindingAuthority: trustedBindings(),
      childRuns: candidateAdapter(),
      verifier: {
        async verify() {
          return { passed: false, verifierId: "verifier-1", evidenceHash: hash("8"), source: "tests", reason: "tests failed" };
        }
      },
      integrator: {
        async integrate(input) {
          integrations += 1;
          return { integrationId: input.integrationId, integratedHash: hash("9") };
        },
        async recover() { return null; }
      }
    });
    await runtime.initialize(baseMissionInput());

    const state = await runtime.runUntilBlocked();
    expect(integrations).toBe(0);
    expect(state.queue[0]?.phase).toBe("failed");
    expect(state.failedCandidates).toEqual([
      expect.objectContaining({ workItemId: "build", candidateHash: hash("2"), reason: "tests failed" })
    ]);
    expect(state.blockers[0]?.code).toBe("verifier_rejected");
  });

  it("recovers a persisted integration intent instead of integrating twice", async () => {
    const missionRoot = await root();
    const calls = { integrate: 0, recover: 0 };
    const options = {
      root: missionRoot, missionId: "mission-integration-restart", childRuns: candidateAdapter(), bindingAuthority: trustedBindings(),
      verifier: { async verify() { return { passed: true, verifierId: "v", evidenceHash: hash("4"), source: "tests" }; } },
      integrator: {
        async integrate(input: { integrationId: string }) { calls.integrate += 1; return { integrationId: input.integrationId, integratedHash: hash("5") }; },
        async recover(input: { integrationId: string }) { calls.recover += 1; return { integrationId: input.integrationId, integratedHash: hash("5") }; }
      }
    };
    let runtime = createMissionRuntime(options);
    await runtime.initialize(baseMissionInput());
    const intent = await runtime.step({ stopAfter: "integration-intent" });
    expect(intent.queue[0]?.phase).toBe("integrating");
    expect(calls).toEqual({ integrate: 0, recover: 0 });

    runtime = createMissionRuntime(options);
    const recovered = await runtime.runUntilBlocked();
    expect(recovered.queue[0]?.phase).toBe("integrated");
    expect(calls).toEqual({ integrate: 0, recover: 1 });
  });

  it("reconciles an already-settled verifier result after a crash window", async () => {
    const missionRoot = await root();
    let verifications = 0;
    const options = {
      root: missionRoot, missionId: "mission-settlement-restart", childRuns: candidateAdapter(), bindingAuthority: trustedBindings(),
      verifier: { async verify() { verifications += 1; return { passed: true, verifierId: "v", evidenceHash: hash("4"), source: "tests" }; } },
      integrator: { async integrate(input: { integrationId: string }) { return { integrationId: input.integrationId, integratedHash: hash("5") }; }, async recover() { return null; } }
    };
    let runtime = createMissionRuntime(options);
    await runtime.initialize(baseMissionInput());
    const staleRuntime = await runtime.step({ stopAfter: "settlement" });
    expect(staleRuntime.queue[0]?.phase).toBe("verifying");

    runtime = createMissionRuntime(options);
    const recovered = await runtime.runUntilBlocked();
    expect(recovered.queue[0]?.phase).toBe("integrated");
    expect(recovered.settlement.settlementIds).toHaveLength(1);
    expect(verifications).toBe(1);
  });

  it("uses fallback providers only when policy explicitly permits them", async () => {
    const missionRoot = await root();
    const providers: string[] = [];
    const childRuns: MissionChildRunAdapter = {
      async launch(input) {
        providers.push(input.provider);
        return input.provider === "backup"
          ? { kind: "candidate", runId: input.runId, receiptHash: hash("1"), candidateHash: hash("2"), actualUsd: 1, tokens: 100,
              handoff: verifiedHandoff(input.missionId, input.runId, hash("1"), "fallback output", 120) }
          : { kind: "failed", runId: input.runId, receiptHash: hash("6"), actualUsd: 0.25, tokens: 10,
              code: "provider_failure", message: "primary unavailable" };
      },
      async recover(input) {
        providers.push(input.provider);
        return null;
      }
    };
    const runtime = createMissionRuntime({
      root: missionRoot, missionId: "mission-fallback", childRuns, bindingAuthority: trustedBindings(),
      verifier: { async verify() { return { passed: true, verifierId: "v", evidenceHash: hash("4"), source: "tests" }; } },
      integrator: { async integrate(input) { return { integrationId: input.integrationId, integratedHash: hash("5") }; }, async recover() { return null; } }
    });
    await runtime.initialize({ ...baseMissionInput(), context: { manifestHash: hash("c"), tokenCount: 10, compactAtTokens: 100 },
      providerPolicy: { primary: "primary", fallback: "backup", allowFallback: true } });

    const state = await runtime.runUntilBlocked();
    expect(providers).toEqual(["primary", "backup"]);
    expect(state.queue[0]?.phase).toBe("integrated");
    expect(state.context.summary).toContain("fallback output");
    expect(state.context.tokenCount).toBe(120);
    expect(state.bindings.contextManifestHash).not.toBe(hash("3"));
    expect(state.settlement.budget).toMatchObject({ spentUsd: 1.25, runsUsed: 2, tokensUsed: 110 });
  });

  it.each([
    ["work-item attempts", { maxAttempts: 1, maxRuns: 3 }],
    ["mission runs", { maxAttempts: 2, maxRuns: 1 }]
  ])("does not launch fallback beyond %s", async (_label, limits) => {
    const missionRoot = await root();
    const providers: string[] = [];
    const runtime = createMissionRuntime({ root: missionRoot, missionId: `mission-fallback-${limits.maxAttempts}-${limits.maxRuns}`,
      bindingAuthority: trustedBindings(),
      childRuns: { async launch(input) { providers.push(input.provider); return { kind: "failed" as const, runId: input.runId,
        receiptHash: hash("6"), actualUsd: 0.25, tokens: 10, code: "provider_failure" as const, message: "unavailable" }; },
        async recover() { return null; } }, verifier: unusedVerifier(), integrator: unusedIntegrator(),
      now: () => "2026-11-03T01:00:00.000Z" });
    const base = baseMissionInput();
    await runtime.initialize({ ...base, budget: { ...base.budget, maxRuns: limits.maxRuns },
      workItems: [{ ...base.workItems[0]!, maxAttempts: limits.maxAttempts }],
      providerPolicy: { primary: "primary", fallback: "backup", allowFallback: true } });
    const state = await runtime.runUntilBlocked();
    expect(providers).toEqual(["primary"]);
    expect(state.blockers[0]?.code).toBe("policy_blocked");
    expect(state.settlement.budget).toMatchObject({ spentUsd: 0.25, runsUsed: 1, tokensUsed: 10 });
  });

  it("rejects an unverified context handoff before verifier or integration", async () => {
    const missionRoot = await root();
    let verifications = 0;
    const runtime = createMissionRuntime({ root: missionRoot, missionId: "mission-handoff-rejected", bindingAuthority: trustedBindings(),
      childRuns: { async launch(input) { const handoff = verifiedHandoff(input.missionId, input.runId, hash("1"), "unsafe", 5);
        return { kind: "candidate", runId: input.runId, receiptHash: hash("1"), candidateHash: hash("2"), actualUsd: 0.5, tokens: 25,
          handoff: { ...handoff, producerReceiptVerified: false } }; }, async recover() { return null; } },
      verifier: { async verify() { verifications += 1; throw new Error("must not verify"); } }, integrator: unusedIntegrator(),
      now: () => "2026-11-03T01:00:00.000Z" });
    await runtime.initialize(baseMissionInput());
    const state = await runtime.runUntilBlocked();
    expect(verifications).toBe(0);
    expect(state.blockers[0]?.code).toBe("scope_violation");
    expect(state.settlement.budget).toMatchObject({ spentUsd: 0.5, runsUsed: 1, tokensUsed: 25 });
  });

  it("does not launch when the supervisor budget is already exhausted", async () => {
    const missionRoot = await root();
    let launches = 0;
    const runtime = createMissionRuntime({
      root: missionRoot, missionId: "mission-budget-gate",
      bindingAuthority: trustedBindings(),
      childRuns: { async launch() { launches += 1; throw new Error("must not launch"); }, async recover() { return null; } },
      verifier: unusedVerifier(), integrator: unusedIntegrator(), now: () => "2026-11-03T01:00:00.000Z"
    });
    await runtime.initialize({ ...baseMissionInput(), budget: { ...baseMissionInput().budget, maxUsd: 1, spentUsd: 1 } });
    const state = await runtime.step();
    expect(launches).toBe(0);
    expect(state.blockers[0]?.code).toBe("budget_exhausted");
  });

  it("passes only remaining budget to a child and never verifies aggregate overspend", async () => {
    const missionRoot = await root();
    const observedBudgets: Array<{ maxUsd: number; maxTokens: number }> = [];
    let verifications = 0;
    const runtime = createMissionRuntime({
      root: missionRoot,
      missionId: "mission-remaining-budget",
      bindingAuthority: trustedBindings(),
      childRuns: {
        async launch(input: MissionChildRunInput) {
          observedBudgets.push(input.budget);
          return {
            kind: "candidate" as const,
            runId: input.runId,
            receiptHash: hash("1"),
            candidateHash: hash("2"),
            actualUsd: 0.6,
            tokens: 101,
            handoff: verifiedHandoff(input.missionId, input.runId, hash("1"), "over budget", 5)
          };
        },
        async recover() { return null; }
      },
      verifier: {
        async verify() {
          verifications += 1;
          return { passed: true, verifierId: "v", evidenceHash: hash("4"), source: "tests" };
        }
      },
      integrator: unusedIntegrator(),
      now: () => "2026-11-03T01:00:00.000Z"
    });
    const base = baseMissionInput();
    await runtime.initialize({
      ...base,
      budget: { ...base.budget, maxUsd: 5, spentUsd: 4.5, maxTokens: 2_000, tokensUsed: 1_900 }
    });

    const state = await runtime.runUntilBlocked();

    expect(observedBudgets).toEqual([{ maxUsd: 0.5, maxTokens: 100 }]);
    expect(verifications).toBe(0);
    expect(state.blockers[0]?.code).toBe("budget_exhausted");
    expect(state.queue[0]?.phase).toBe("blocked");
    expect(state.settlement.budget).toMatchObject({ spentUsd: 5.1, tokensUsed: 2_001, runsUsed: 1 });
  });

  it("reduces the child cap after each sequential settlement", async () => {
    const missionRoot = await root();
    const observedBudgets: Array<{ maxUsd: number; maxTokens: number }> = [];
    const runtime = createMissionRuntime({
      root: missionRoot,
      missionId: "mission-sequential-remaining-budget",
      bindingAuthority: trustedBindings(),
      childRuns: {
        async launch(input) {
          observedBudgets.push(input.budget);
          return { kind: "candidate" as const, runId: input.runId, receiptHash: hash("1"), candidateHash: hash("2"),
            actualUsd: 1, tokens: 10,
            handoff: verifiedHandoff(input.missionId, input.runId, hash("1"), "sequential output", 1) };
        },
        async recover() { return null; }
      },
      verifier: { async verify() { return { passed: true, verifierId: "v", evidenceHash: hash("4"), source: "tests" }; } },
      integrator: { async integrate(input) { return { integrationId: input.integrationId, integratedHash: hash("5") }; }, async recover() { return null; } },
      now: () => "2026-11-03T01:00:00.000Z"
    });
    const base = baseMissionInput();
    await runtime.initialize({ ...base, workItems: [
      { id: "first", title: "first", dependsOn: [], maxAttempts: 1 },
      { id: "second", title: "second", dependsOn: [], maxAttempts: 1 }
    ] });

    const state = await runtime.runUntilBlocked();

    expect(observedBudgets).toEqual([
      { maxUsd: 5, maxTokens: 2_000 },
      { maxUsd: 4, maxTokens: 1_990 }
    ]);
    expect(state.queue.every((item) => item.phase === "integrated")).toBe(true);
  });

  it("gives a fallback provider only the budget left after the failed primary", async () => {
    const missionRoot = await root();
    const observed: Array<{ provider: string; maxUsd: number; maxTokens: number }> = [];
    const runtime = createMissionRuntime({
      root: missionRoot,
      missionId: "mission-fallback-remaining-budget",
      bindingAuthority: trustedBindings(),
      childRuns: {
        async launch(input) {
          observed.push({ provider: input.provider, ...input.budget });
          if (input.provider === "primary") {
            return { kind: "failed" as const, runId: input.runId, receiptHash: hash("6"), actualUsd: 1, tokens: 100,
              code: "provider_failure" as const, message: "primary unavailable" };
          }
          return { kind: "candidate" as const, runId: input.runId, receiptHash: hash("1"), candidateHash: hash("2"),
            actualUsd: 0.5, tokens: 20,
            handoff: verifiedHandoff(input.missionId, input.runId, hash("1"), "fallback output", 1) };
        },
        async recover() { return null; }
      },
      verifier: { async verify() { return { passed: true, verifierId: "v", evidenceHash: hash("4"), source: "tests" }; } },
      integrator: { async integrate(input) { return { integrationId: input.integrationId, integratedHash: hash("5") }; }, async recover() { return null; } },
      now: () => "2026-11-03T01:00:00.000Z"
    });
    await runtime.initialize({ ...baseMissionInput(), providerPolicy: { primary: "primary", fallback: "backup", allowFallback: true } });

    const state = await runtime.runUntilBlocked();

    expect(observed).toEqual([
      { provider: "primary", maxUsd: 5, maxTokens: 2_000 },
      { provider: "backup", maxUsd: 4, maxTokens: 1_900 }
    ]);
    expect(state.queue[0]?.phase).toBe("integrated");
  });

  it("reconciles a supervisor running transition that committed before the launch intent", async () => {
    const missionRoot = await root();
    const missionId = "mission-start-crash-window";
    let recovered = 0;
    const runtime = createMissionRuntime({
      root: missionRoot,
      missionId,
      bindingAuthority: trustedBindings(),
      childRuns: {
        async launch() { throw new Error("must recover the durable launch"); },
        async recover(input: MissionChildRunInput) {
          recovered += 1;
          return { kind: "failed" as const, runId: input.runId, receiptHash: hash("6"),
            actualUsd: 0, tokens: 0, code: "provider_failure" as const, message: "recovered failure" };
        }
      },
      verifier: unusedVerifier(),
      integrator: unusedIntegrator(),
      now: () => "2026-11-03T01:00:00.000Z"
    });
    const initialized = await runtime.initialize(baseMissionInput());
    const supervisor = createMissionSupervisor({ root: missionRoot, missionId });
    const lease = await supervisor.acquireLease({ holderId: "mission-runtime", ttlMs: 60_000, now: "2026-11-03T01:00:00.000Z" });
    await supervisor.transitionWorkItem({
      workItemId: "build",
      to: "running",
      actor: { id: "mission-runtime", role: "supervisor" },
      at: "2026-11-03T01:00:00.000Z"
    }, {
      checkpointId: stableTestId("supervisor-start", initialized.bindings.missionLedgerHeadHash, "build",
        stableTestId("run", missionId, "build", "1")),
      expectedHeadHash: initialized.bindings.missionLedgerHeadHash,
      leaseToken: lease.token,
      now: "2026-11-03T01:00:00.000Z"
    });
    await supervisor.releaseLease(lease.token);

    const state = await runtime.runUntilBlocked();

    expect(recovered).toBe(1);
    expect(state.blockers[0]?.code).toBe("provider_failure");
    expect(state.blockers.some((blocker) => blocker.code === "corrupt_state")).toBe(false);
  });

  it("reconciles a supervisor candidate transition that committed before candidate persistence", async () => {
    const missionRoot = await root();
    const missionId = "mission-candidate-crash-window";
    const options = {
      root: missionRoot,
      missionId,
      bindingAuthority: trustedBindings(),
      childRuns: {
        async launch(input: MissionChildRunInput) {
          return { kind: "candidate" as const, runId: input.runId, receiptHash: hash("1"), candidateHash: hash("2"),
            actualUsd: 0.5, tokens: 20,
            handoff: verifiedHandoff(input.missionId, input.runId, hash("1"), "child output", 20) };
        },
        async recover(input: MissionChildRunInput) {
          return { kind: "candidate" as const, runId: input.runId, receiptHash: hash("1"), candidateHash: hash("2"),
            actualUsd: 0.5, tokens: 20,
            handoff: verifiedHandoff(input.missionId, input.runId, hash("1"), "child output", 20) };
        }
      },
      verifier: { async verify() { return { passed: true, verifierId: "v", evidenceHash: hash("4"), source: "tests" }; } },
      integrator: { async integrate(input: { integrationId: string }) { return { integrationId: input.integrationId, integratedHash: hash("5") }; }, async recover() { return null; } },
      now: () => "2026-11-03T01:00:00.000Z"
    };
    let runtime = createMissionRuntime(options);
    await runtime.initialize(baseMissionInput());
    const launching = await runtime.step({ stopAfter: "launch-intent" });
    const entry = launching.queue[0]!;
    const supervisor = createMissionSupervisor({ root: missionRoot, missionId });
    const supervisorState = await supervisor.load();
    const lease = await supervisor.acquireLease({ holderId: "mission-runtime", ttlMs: 60_000, now: "2026-11-03T01:00:00.000Z" });
    await supervisor.transitionWorkItem({
      workItemId: entry.workItemId,
      to: "succeeded",
      actor: { id: "child-run-adapter", role: "executor" },
      evidence: { hash: hash("1"), source: `child:${entry.childRunId!}`, observedAt: "2026-11-03T01:00:00.000Z" }
    }, {
      checkpointId: stableTestId("supervisor-candidate", launching.bindings.missionLedgerHeadHash,
        entry.workItemId, entry.childRunId!),
      expectedHeadHash: launching.bindings.missionLedgerHeadHash,
      leaseToken: lease.token,
      now: "2026-11-03T01:00:00.000Z"
    });
    await supervisor.releaseLease(lease.token);
    expect(supervisorState?.workItems[0]?.status).toBe("running");

    runtime = createMissionRuntime(options);
    const state = await runtime.runUntilBlocked();

    expect(state.blockers.some((blocker) => blocker.code === "corrupt_state")).toBe(false);
    expect(state.blockers).toEqual([]);
    expect(state.queue[0]?.phase).toBe("integrated");
    expect(state.queue[0]).not.toHaveProperty("recoveryAuthority");
  });

  it("does not rebind across two supervisor commits", async () => {
    const missionRoot = await root();
    const missionId = "mission-multi-commit-ahead";
    const options = {
      root: missionRoot,
      missionId,
      bindingAuthority: trustedBindings(),
      childRuns: {
        async launch() { throw new Error("must not relaunch"); },
        async recover(input: MissionChildRunInput) {
          return { kind: "candidate" as const, runId: input.runId, receiptHash: hash("1"), candidateHash: hash("2"),
            actualUsd: 0.5, tokens: 20,
            handoff: verifiedHandoff(input.missionId, input.runId, hash("1"), "child output", 20) };
        }
      },
      verifier: unusedVerifier(),
      integrator: unusedIntegrator(),
      now: () => "2026-11-03T01:00:00.000Z"
    };
    let runtime = createMissionRuntime(options);
    await runtime.initialize(baseMissionInput());
    const launching = await runtime.step({ stopAfter: "launch-intent" });
    const entry = launching.queue[0]!;
    const supervisor = createMissionSupervisor({ root: missionRoot, missionId });
    const lease = await supervisor.acquireLease({ holderId: "mission-runtime", ttlMs: 60_000, now: "2026-11-03T01:00:00.000Z" });
    const succeeded = await supervisor.transitionWorkItem({
      workItemId: entry.workItemId,
      to: "succeeded",
      actor: { id: "child-run-adapter", role: "executor" },
      evidence: { hash: hash("1"), source: `child:${entry.childRunId!}`, observedAt: "2026-11-03T01:00:00.000Z" }
    }, {
      checkpointId: stableTestId("supervisor-candidate", launching.bindings.missionLedgerHeadHash,
        entry.workItemId, entry.childRunId!),
      expectedHeadHash: launching.bindings.missionLedgerHeadHash,
      leaseToken: lease.token,
      now: "2026-11-03T01:00:00.000Z"
    });
    await supervisor.recordSettlement({
      settlementId: "unrelated-second-ahead-commit",
      runId: "unrelated-run",
      workItemId: entry.workItemId,
      receiptHash: hash("9"),
      actualUsd: 0,
      tokens: 0,
      settledAt: "2026-11-03T01:00:00.000Z",
      verifier: { passed: false, verifierId: "other", evidenceHash: hash("9"), source: "other" }
    }, {
      checkpointId: "second-ahead-commit",
      expectedHeadHash: succeeded.checkpointHash,
      leaseToken: lease.token,
      now: "2026-11-03T01:00:00.000Z"
    });
    await supervisor.releaseLease(lease.token);

    const state = await runtime.step();

    expect(state.blockers[0]?.code).toBe("corrupt_state");
    expect(state.queue[0]?.phase).toBe("blocked");
  });

  it("downgrades a supervisor-ahead success when recovered handoff evidence fails", async () => {
    const missionRoot = await root();
    const missionId = "mission-candidate-recovery-invalid";
    const options = {
      root: missionRoot,
      missionId,
      bindingAuthority: trustedBindings(),
      childRuns: {
        async launch() { throw new Error("must recover the candidate"); },
        async recover(input: MissionChildRunInput) {
          const handoff = verifiedHandoff(input.missionId, input.runId, hash("1"), "invalid recovered handoff", 20);
          return { kind: "candidate" as const, runId: input.runId, receiptHash: hash("1"), candidateHash: hash("2"),
            actualUsd: 0.5, tokens: 20, handoff: { ...handoff, producerReceiptVerified: false } };
        }
      },
      verifier: unusedVerifier(),
      integrator: unusedIntegrator(),
      now: () => "2026-11-03T01:00:00.000Z"
    };
    const runtime = createMissionRuntime(options);
    await runtime.initialize(baseMissionInput());
    const launching = await runtime.step({ stopAfter: "launch-intent" });
    const entry = launching.queue[0]!;
    const supervisor = createMissionSupervisor({ root: missionRoot, missionId });
    const lease = await supervisor.acquireLease({ holderId: "mission-runtime", ttlMs: 60_000, now: "2026-11-03T01:00:00.000Z" });
    await supervisor.transitionWorkItem({
      workItemId: entry.workItemId,
      to: "succeeded",
      actor: { id: "child-run-adapter", role: "executor" },
      evidence: { hash: hash("1"), source: `child:${entry.childRunId!}`, observedAt: "2026-11-03T01:00:00.000Z" }
    }, {
      checkpointId: stableTestId("supervisor-candidate", launching.bindings.missionLedgerHeadHash,
        entry.workItemId, entry.childRunId!),
      expectedHeadHash: launching.bindings.missionLedgerHeadHash,
      leaseToken: lease.token,
      now: "2026-11-03T01:00:00.000Z"
    });
    await supervisor.releaseLease(lease.token);

    const state = await runtime.runUntilBlocked();
    const supervisorState = await supervisor.load();

    expect(state.blockers[0]?.code).toBe("scope_violation");
    expect(state.queue[0]?.phase).toBe("blocked");
    expect(state.queue[0]).not.toHaveProperty("recoveryAuthority");
    expect(supervisorState?.workItems[0]?.status).toBe("blocked");
  });

  it("durably blocks candidate-ahead recovery whose receipt does not match the succeeded transition", async () => {
    const missionRoot = await root();
    const missionId = "mission-candidate-recovery-mismatch";
    let recoveries = 0;
    const options = {
      root: missionRoot, missionId, bindingAuthority: trustedBindings(),
      childRuns: {
        async launch() { throw new Error("must recover"); },
        async recover(input: MissionChildRunInput) {
          recoveries += 1;
          return { kind: "candidate" as const, runId: input.runId, receiptHash: hash("9"), candidateHash: hash("2"),
            actualUsd: 0.5, tokens: 20,
            handoff: verifiedHandoff(input.missionId, input.runId, hash("9"), "mismatched candidate", 20) };
        }
      },
      verifier: unusedVerifier(), integrator: unusedIntegrator(), now: () => "2026-11-03T01:00:00.000Z"
    };
    const runtime = createMissionRuntime(options);
    await runtime.initialize(baseMissionInput());
    const launching = await runtime.step({ stopAfter: "launch-intent" });
    const entry = launching.queue[0]!;
    const supervisor = createMissionSupervisor({ root: missionRoot, missionId });
    const lease = await supervisor.acquireLease({ holderId: "mission-runtime", ttlMs: 60_000, now: "2026-11-03T01:00:00.000Z" });
    await supervisor.transitionWorkItem({ workItemId: entry.workItemId, to: "succeeded",
      actor: { id: "child-run-adapter", role: "executor" },
      evidence: { hash: hash("1"), source: `child:${entry.childRunId!}`, observedAt: "2026-11-03T01:00:00.000Z" }
    }, { checkpointId: stableTestId("supervisor-candidate", launching.bindings.missionLedgerHeadHash,
      entry.workItemId, entry.childRunId!), expectedHeadHash: launching.bindings.missionLedgerHeadHash,
      leaseToken: lease.token, now: "2026-11-03T01:00:00.000Z" });
    await supervisor.releaseLease(lease.token);

    const state = await runtime.step();
    const supervisorState = await supervisor.load();

    expect(recoveries).toBe(1);
    expect(state.blockers[0]?.code).toBe("corrupt_state");
    expect(state.queue[0]?.phase).toBe("blocked");
    expect(supervisorState?.settlements).toEqual([]);
  });

  it("persists the failed settlement binding before the terminal supervisor transition", async () => {
    const missionRoot = await root();
    const missionId = "mission-failed-settlement-boundary";
    const options = {
      root: missionRoot, missionId, bindingAuthority: trustedBindings(),
      childRuns: {
        async launch(input: MissionChildRunInput) {
          return { kind: "failed" as const, runId: input.runId, receiptHash: hash("6"), actualUsd: 0.25, tokens: 10,
            code: "provider_failure" as const, message: "provider failed" };
        },
        async recover(input: MissionChildRunInput) {
          return { kind: "failed" as const, runId: input.runId, receiptHash: hash("6"), actualUsd: 0.25, tokens: 10,
            code: "provider_failure" as const, message: "provider failed" };
        }
      },
      verifier: unusedVerifier(), integrator: unusedIntegrator(), now: () => "2026-11-03T01:00:00.000Z"
    };
    let runtime = createMissionRuntime(options);
    await runtime.initialize(baseMissionInput());

    const afterSettlement = await runtime.step({ stopAfter: "failed-settlement" });
    const supervisor = createMissionSupervisor({ root: missionRoot, missionId });
    const supervisorAfterSettlement = await supervisor.load();

    expect(afterSettlement.queue[0]?.phase).toBe("launching");
    expect(afterSettlement.settlement.settlementIds).toHaveLength(1);
    expect(afterSettlement.bindings.missionLedgerHeadHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(supervisorAfterSettlement?.workItems[0]?.status).toBe("running");
    expect(supervisorAfterSettlement?.settlements).toHaveLength(1);

    runtime = createMissionRuntime(options);
    const finished = await runtime.runUntilBlocked();
    expect(finished.blockers[0]?.code).toBe("provider_failure");
    expect((await supervisor.load())?.workItems[0]?.status).toBe("failed");
  });

  it("reconciles a direct terminal transition committed after the runtime-bound failed settlement", async () => {
    const missionRoot = await root();
    const missionId = "mission-terminal-ahead-boundary";
    let recoveries = 0;
    let fallbackLaunches = 0;
    const options = {
      root: missionRoot, missionId, bindingAuthority: trustedBindings(),
      childRuns: {
        async launch(input: MissionChildRunInput) {
          fallbackLaunches += 1;
          return { kind: "failed" as const, runId: input.runId, receiptHash: hash("7"), actualUsd: 0.1, tokens: 5,
            code: "host_failure" as const, message: "fallback must not launch after terminal authority" };
        },
        async recover(input: MissionChildRunInput) {
          recoveries += 1;
          return { kind: "failed" as const, runId: input.runId, receiptHash: hash("6"), actualUsd: 0.25, tokens: 10,
            code: "provider_failure" as const, message: "recovered terminal failure" };
        }
      },
      verifier: unusedVerifier(), integrator: unusedIntegrator(), now: () => "2026-11-03T01:00:00.000Z"
    };
    let runtime = createMissionRuntime(options);
    await runtime.initialize({ ...baseMissionInput(),
      providerPolicy: { primary: "primary", fallback: "backup", allowFallback: true } });
    const launching = await runtime.step({ stopAfter: "launch-intent" });
    const entry = launching.queue[0]!;
    const settlementId = stableTestId("settlement-failed", missionId, entry.workItemId, entry.childRunId!);
    const supervisor = createMissionSupervisor({ root: missionRoot, missionId });
    let lease = await supervisor.acquireLease({ holderId: "mission-runtime", ttlMs: 60_000, now: "2026-11-03T01:00:00.000Z" });
    const settled = await supervisor.recordSettlement({ settlementId, runId: entry.childRunId!, workItemId: entry.workItemId,
      receiptHash: hash("6"), actualUsd: 0.25, tokens: 10, settledAt: "2026-11-03T01:00:00.000Z",
      verifier: { passed: false, verifierId: "child-run-adapter", evidenceHash: hash("6"), source: `child:${entry.childRunId!}` }
    }, { checkpointId: stableTestId("supervisor-failed-settlement", launching.bindings.missionLedgerHeadHash, settlementId),
      expectedHeadHash: launching.bindings.missionLedgerHeadHash,
      leaseToken: lease.token, now: "2026-11-03T01:00:00.000Z" });
    await supervisor.releaseLease(lease.token);
    const rebound = await runtime.step({ stopAfter: "failed-settlement" });
    expect(rebound.bindings.missionLedgerHeadHash).toBe(settled.checkpointHash);
    lease = await supervisor.acquireLease({ holderId: "mission-runtime", ttlMs: 60_000, now: "2026-11-03T01:00:00.000Z" });
    await supervisor.transitionWorkItem({ workItemId: entry.workItemId, to: "failed",
      actor: { id: "child-run-adapter", role: "executor" },
      evidence: { hash: hash("6"), source: `child:${entry.childRunId!}`, observedAt: "2026-11-03T01:00:00.000Z" }
    }, { checkpointId: stableTestId("supervisor-fail", settled.checkpointHash, entry.workItemId, entry.childRunId!),
      expectedHeadHash: settled.checkpointHash,
      leaseToken: lease.token, now: "2026-11-03T01:00:00.000Z" });
    await supervisor.releaseLease(lease.token);

    const terminalSettlementBoundary = await runtime.step({ stopAfter: "failed-settlement" });
    expect(terminalSettlementBoundary.queue[0]?.recoveryAuthority?.kind).toBe("terminal");
    runtime = createMissionRuntime(options);
    const finished = await runtime.runUntilBlocked();

    expect(recoveries).toBe(3);
    expect(fallbackLaunches).toBe(0);
    expect(finished.blockers[0]?.code).toBe("provider_failure");
    expect(finished.blockers.some((blocker) => blocker.code === "corrupt_state")).toBe(false);
    expect(finished.queue[0]).not.toHaveProperty("recoveryAuthority");
    expect((await supervisor.load())?.workItems[0]?.status).toBe("failed");
  });

  it("reconciles a failed settlement that committed before runtime persistence", async () => {
    const missionRoot = await root();
    const missionId = "mission-failed-settlement-crash-window";
    let recovered = 0;
    const options = {
      root: missionRoot,
      missionId,
      bindingAuthority: trustedBindings(),
      childRuns: {
        async launch() { throw new Error("must recover the failed run"); },
        async recover(input: MissionChildRunInput) {
          recovered += 1;
          return { kind: "failed" as const, runId: input.runId, receiptHash: hash("6"), actualUsd: 0.25, tokens: 10,
            code: "provider_failure" as const, message: "recovered provider failure" };
        }
      },
      verifier: unusedVerifier(),
      integrator: unusedIntegrator(),
      now: () => "2026-11-03T01:00:00.000Z"
    };
    let runtime = createMissionRuntime(options);
    await runtime.initialize(baseMissionInput());
    const launching = await runtime.step({ stopAfter: "launch-intent" });
    const entry = launching.queue[0]!;
    const settlementId = stableTestId("settlement-failed", missionId, entry.workItemId, entry.childRunId!);
    const supervisor = createMissionSupervisor({ root: missionRoot, missionId });
    const lease = await supervisor.acquireLease({ holderId: "mission-runtime", ttlMs: 60_000, now: "2026-11-03T01:00:00.000Z" });
    await supervisor.recordSettlement({
      settlementId,
      runId: entry.childRunId!,
      workItemId: entry.workItemId,
      receiptHash: hash("6"),
      actualUsd: 0.25,
      tokens: 10,
      settledAt: "2026-11-03T01:00:00.000Z",
      verifier: { passed: false, verifierId: "child-run-adapter", evidenceHash: hash("6"), source: `child:${entry.childRunId!}` }
    }, {
      checkpointId: stableTestId("supervisor-failed-settlement", launching.bindings.missionLedgerHeadHash, settlementId),
      expectedHeadHash: launching.bindings.missionLedgerHeadHash,
      leaseToken: lease.token,
      now: "2026-11-03T01:00:00.000Z"
    });
    await supervisor.releaseLease(lease.token);

    runtime = createMissionRuntime(options);
    const state = await runtime.runUntilBlocked();

    expect(recovered).toBe(1);
    expect(state.blockers[0]?.code).toBe("provider_failure");
    expect(state.blockers.some((blocker) => blocker.code === "corrupt_state")).toBe(false);
    expect(state.settlement.settlementIds).toEqual([settlementId]);
    expect(state.queue[0]).not.toHaveProperty("recoveryAuthority");
  });

  it("rejects a candidate recovery that conflicts with a direct failed-settlement outcome", async () => {
    const missionRoot = await root();
    const missionId = "mission-failed-settlement-candidate-conflict";
    let recoveries = 0;
    const options = {
      root: missionRoot, missionId, bindingAuthority: trustedBindings(),
      childRuns: {
        async launch() { throw new Error("must recover"); },
        async recover(input: MissionChildRunInput) {
          recoveries += 1;
          return { kind: "candidate" as const, runId: input.runId, receiptHash: hash("6"), candidateHash: hash("2"),
            actualUsd: 0.25, tokens: 10,
            handoff: verifiedHandoff(input.missionId, input.runId, hash("6"), "conflicting success", 1) };
        }
      },
      verifier: unusedVerifier(), integrator: unusedIntegrator(), now: () => "2026-11-03T01:00:00.000Z"
    };
    const runtime = createMissionRuntime(options);
    await runtime.initialize(baseMissionInput());
    const launching = await runtime.step({ stopAfter: "launch-intent" });
    const entry = launching.queue[0]!;
    const supervisor = createMissionSupervisor({ root: missionRoot, missionId });
    const lease = await supervisor.acquireLease({ holderId: "mission-runtime", ttlMs: 60_000, now: "2026-11-03T01:00:00.000Z" });
    await supervisor.recordSettlement({
      settlementId: stableTestId("settlement-failed", missionId, entry.workItemId, entry.childRunId!),
      runId: entry.childRunId!, workItemId: entry.workItemId, receiptHash: hash("6"), actualUsd: 0.25, tokens: 10,
      settledAt: "2026-11-03T01:00:00.000Z",
      verifier: { passed: false, verifierId: "child-run-adapter", evidenceHash: hash("6"), source: `child:${entry.childRunId!}` }
    }, { checkpointId: stableTestId("supervisor-failed-settlement", launching.bindings.missionLedgerHeadHash,
      stableTestId("settlement-failed", missionId, entry.workItemId, entry.childRunId!)),
      expectedHeadHash: launching.bindings.missionLedgerHeadHash,
      leaseToken: lease.token, now: "2026-11-03T01:00:00.000Z" });
    await supervisor.releaseLease(lease.token);

    const state = await runtime.step();
    const supervisorState = await supervisor.load();

    expect(recoveries).toBe(1);
    expect(state.blockers[0]?.code).toBe("corrupt_state");
    expect(state.settlement.settlementIds).toEqual([]);
    expect(supervisorState?.workItems[0]?.status).toBe("running");
  });

  it("keeps candidate-ahead recovery authority across a second restart", async () => {
    const missionRoot = await root();
    const missionId = "mission-candidate-double-restart";
    let conflicting = false;
    const options = {
      root: missionRoot, missionId, bindingAuthority: trustedBindings(),
      childRuns: { async launch() { throw new Error("must recover"); }, async recover(input: MissionChildRunInput) {
        return { kind: "candidate" as const, runId: input.runId, receiptHash: hash("1"), candidateHash: hash("2"),
          actualUsd: conflicting ? 0.75 : 0.5, tokens: 20,
          handoff: verifiedHandoff(input.missionId, input.runId, hash("1"), "candidate", 1) };
      } }, verifier: unusedVerifier(), integrator: unusedIntegrator(), now: () => "2026-11-03T01:00:00.000Z"
    };
    let runtime = createMissionRuntime(options);
    await runtime.initialize(baseMissionInput());
    const launching = await runtime.step({ stopAfter: "launch-intent" });
    const entry = launching.queue[0]!;
    const supervisor = createMissionSupervisor({ root: missionRoot, missionId });
    const lease = await supervisor.acquireLease({ holderId: "mission-runtime", ttlMs: 60_000, now: "2026-11-03T01:00:00.000Z" });
    await supervisor.transitionWorkItem({ workItemId: entry.workItemId, to: "succeeded", actor: { id: "child-run-adapter", role: "executor" },
      evidence: { hash: hash("1"), source: `child:${entry.childRunId!}`, observedAt: "2026-11-03T01:00:00.000Z" }
    }, { checkpointId: stableTestId("supervisor-candidate", launching.bindings.missionLedgerHeadHash, entry.workItemId, entry.childRunId!),
      expectedHeadHash: launching.bindings.missionLedgerHeadHash, leaseToken: lease.token, now: "2026-11-03T01:00:00.000Z" });
    await supervisor.releaseLease(lease.token);

    const rebound = await runtime.step({ stopAfter: "recovery-rebind" });
    expect(rebound.queue[0]?.phase).toBe("launching");
    expect(rebound.queue[0]?.recoveryAuthority?.kind).toBe("candidate");
    conflicting = true;
    runtime = createMissionRuntime(options);
    const blocked = await runtime.step();
    expect(blocked.blockers[0]?.code).toBe("corrupt_state");
    expect(blocked.queue[0]).not.toHaveProperty("recoveryAuthority");
    expect((await supervisor.load())?.settlements).toEqual([]);
  });

  it("keeps failed-settlement recovery authority across a second restart", async () => {
    const missionRoot = await root();
    const missionId = "mission-failed-settlement-double-restart";
    let conflicting = false;
    const options = {
      root: missionRoot, missionId, bindingAuthority: trustedBindings(),
      childRuns: { async launch() { throw new Error("must recover"); }, async recover(input: MissionChildRunInput) {
        return { kind: "failed" as const, runId: input.runId, receiptHash: hash("6"), actualUsd: 0.25, tokens: 10,
          code: conflicting ? "host_failure" as const : "provider_failure" as const,
          message: conflicting ? "changed failure" : "failed" };
      } }, verifier: unusedVerifier(), integrator: unusedIntegrator(), now: () => "2026-11-03T01:00:00.000Z"
    };
    let runtime = createMissionRuntime(options);
    await runtime.initialize(baseMissionInput());
    const launching = await runtime.step({ stopAfter: "launch-intent" });
    const entry = launching.queue[0]!;
    const settlementId = stableTestId("settlement-failed", missionId, entry.workItemId, entry.childRunId!);
    const supervisor = createMissionSupervisor({ root: missionRoot, missionId });
    const lease = await supervisor.acquireLease({ holderId: "mission-runtime", ttlMs: 60_000, now: "2026-11-03T01:00:00.000Z" });
    await supervisor.recordSettlement({ settlementId, runId: entry.childRunId!, workItemId: entry.workItemId, receiptHash: hash("6"),
      actualUsd: 0.25, tokens: 10, settledAt: "2026-11-03T01:00:00.000Z",
      verifier: { passed: false, verifierId: "child-run-adapter", evidenceHash: hash("6"), source: `child:${entry.childRunId!}` }
    }, { checkpointId: stableTestId("supervisor-failed-settlement", launching.bindings.missionLedgerHeadHash, settlementId),
      expectedHeadHash: launching.bindings.missionLedgerHeadHash, leaseToken: lease.token, now: "2026-11-03T01:00:00.000Z" });
    await supervisor.releaseLease(lease.token);

    const rebound = await runtime.step({ stopAfter: "recovery-rebind" });
    expect(rebound.queue[0]?.recoveryAuthority?.kind).toBe("failed_settlement");
    conflicting = true;
    runtime = createMissionRuntime(options);
    const blocked = await runtime.step();
    expect(blocked.blockers[0]?.code).toBe("corrupt_state");
    expect(blocked.queue[0]).not.toHaveProperty("recoveryAuthority");
    expect((await supervisor.load())?.workItems[0]?.status).toBe("running");
  });

  it("keeps terminal recovery authority across a second restart", async () => {
    const missionRoot = await root();
    const missionId = "mission-terminal-double-restart";
    let conflicting = false;
    const options = {
      root: missionRoot, missionId, bindingAuthority: trustedBindings(),
      childRuns: { async launch() { throw new Error("must recover"); }, async recover(input: MissionChildRunInput) {
        if (conflicting) return { kind: "candidate" as const, runId: input.runId, receiptHash: hash("6"), candidateHash: hash("2"),
          actualUsd: 0.25, tokens: 10, handoff: verifiedHandoff(input.missionId, input.runId, hash("6"), "conflict", 1) };
        return { kind: "failed" as const, runId: input.runId, receiptHash: hash("6"), actualUsd: 0.25, tokens: 10,
          code: "provider_failure" as const, message: "failed" };
      } }, verifier: unusedVerifier(), integrator: unusedIntegrator(), now: () => "2026-11-03T01:00:00.000Z"
    };
    let runtime = createMissionRuntime(options);
    await runtime.initialize(baseMissionInput());
    const launching = await runtime.step({ stopAfter: "launch-intent" });
    const entry = launching.queue[0]!;
    const settlementId = stableTestId("settlement-failed", missionId, entry.workItemId, entry.childRunId!);
    const supervisor = createMissionSupervisor({ root: missionRoot, missionId });
    let lease = await supervisor.acquireLease({ holderId: "mission-runtime", ttlMs: 60_000, now: "2026-11-03T01:00:00.000Z" });
    const settled = await supervisor.recordSettlement({ settlementId, runId: entry.childRunId!, workItemId: entry.workItemId,
      receiptHash: hash("6"), actualUsd: 0.25, tokens: 10, settledAt: "2026-11-03T01:00:00.000Z",
      verifier: { passed: false, verifierId: "child-run-adapter", evidenceHash: hash("6"), source: `child:${entry.childRunId!}` }
    }, { checkpointId: stableTestId("supervisor-failed-settlement", launching.bindings.missionLedgerHeadHash, settlementId),
      expectedHeadHash: launching.bindings.missionLedgerHeadHash, leaseToken: lease.token, now: "2026-11-03T01:00:00.000Z" });
    await supervisor.releaseLease(lease.token);
    const settlementRebound = await runtime.step({ stopAfter: "recovery-rebind" });
    expect(settlementRebound.queue[0]?.recoveryAuthority?.kind).toBe("failed_settlement");
    lease = await supervisor.acquireLease({ holderId: "mission-runtime", ttlMs: 60_000, now: "2026-11-03T01:00:00.000Z" });
    await supervisor.transitionWorkItem({ workItemId: entry.workItemId, to: "failed", actor: { id: "child-run-adapter", role: "executor" },
      evidence: { hash: hash("6"), source: `child:${entry.childRunId!}`, observedAt: "2026-11-03T01:00:00.000Z" }
    }, { checkpointId: stableTestId("supervisor-fail", settled.checkpointHash, entry.workItemId, entry.childRunId!),
      expectedHeadHash: settled.checkpointHash, leaseToken: lease.token, now: "2026-11-03T01:00:00.000Z" });
    await supervisor.releaseLease(lease.token);
    const terminalRebound = await runtime.step({ stopAfter: "recovery-rebind" });
    expect(terminalRebound.queue[0]?.recoveryAuthority?.kind).toBe("terminal");
    conflicting = true;
    runtime = createMissionRuntime(options);
    const blocked = await runtime.step();
    expect(blocked.blockers[0]?.code).toBe("corrupt_state");
    expect(blocked.queue[0]).not.toHaveProperty("recoveryAuthority");
    expect((await supervisor.load())?.workItems[0]?.status).toBe("failed");
  });

  it("rejects a failed-settlement replay with a different verifier identity", async () => {
    const missionRoot = await root();
    const missionId = "mission-failed-settlement-verifier-mismatch";
    let recoveries = 0;
    const options = {
      root: missionRoot,
      missionId,
      bindingAuthority: trustedBindings(),
      childRuns: {
        async launch() { throw new Error("must recover the failed run"); },
        async recover(input: MissionChildRunInput) {
          recoveries += 1;
          return { kind: "failed" as const, runId: input.runId, receiptHash: hash("6"), actualUsd: 0.25, tokens: 10,
            code: "provider_failure" as const, message: "recovered provider failure" };
        }
      },
      verifier: unusedVerifier(),
      integrator: unusedIntegrator(),
      now: () => "2026-11-03T01:00:00.000Z"
    };
    const runtime = createMissionRuntime(options);
    await runtime.initialize(baseMissionInput());
    const launching = await runtime.step({ stopAfter: "launch-intent" });
    const entry = launching.queue[0]!;
    const supervisor = createMissionSupervisor({ root: missionRoot, missionId });
    const lease = await supervisor.acquireLease({ holderId: "mission-runtime", ttlMs: 60_000, now: "2026-11-03T01:00:00.000Z" });
    await supervisor.recordSettlement({
      settlementId: stableTestId("settlement-failed", missionId, entry.workItemId, entry.childRunId!),
      runId: entry.childRunId!, workItemId: entry.workItemId, receiptHash: hash("6"), actualUsd: 0.25, tokens: 10,
      settledAt: "2026-11-03T01:00:00.000Z",
      verifier: { passed: false, verifierId: "forged-verifier", evidenceHash: hash("6"), source: `child:${entry.childRunId!}` }
    }, {
      checkpointId: stableTestId("supervisor-failed-settlement", launching.bindings.missionLedgerHeadHash,
        stableTestId("settlement-failed", missionId, entry.workItemId, entry.childRunId!)),
      expectedHeadHash: launching.bindings.missionLedgerHeadHash,
      leaseToken: lease.token,
      now: "2026-11-03T01:00:00.000Z"
    });
    await supervisor.releaseLease(lease.token);

    const state = await runtime.runUntilBlocked();
    expect(recoveries).toBe(0);
    expect(state.blockers[0]?.code).toBe("corrupt_state");
    expect(state.settlement.settlementIds).toEqual([]);

    const restarted = createMissionRuntime(options);
    const repeated = await restarted.step();
    expect(repeated.sequence).toBe(state.sequence);
    expect(repeated.blockers).toEqual(state.blockers);
  });

  it("revalidates source and workspace bindings before side effects", async () => {
    const missionRoot = await root();
    let trusted = true;
    let launches = 0;
    const runtime = createMissionRuntime({ root: missionRoot, missionId: "mission-binding-recheck",
      bindingAuthority: { authorityId: "workspace", async verify() { return trusted; } },
      childRuns: { async launch() { launches += 1; throw new Error("must not launch"); }, async recover() { return null; } },
      verifier: unusedVerifier(), integrator: unusedIntegrator(), now: () => "2026-11-03T01:00:00.000Z" });
    await runtime.initialize(baseMissionInput());
    trusted = false;
    const state = await runtime.step();
    expect(launches).toBe(0);
    expect(state.blockers[0]?.code).toBe("corrupt_state");
  });

  it("rejects a claimed memory head when no verified ledger exists", async () => {
    const missionRoot = await root();
    const runtime = createMissionRuntime({ root: missionRoot, missionId: "mission-memory-binding",
      bindingAuthority: trustedBindings(), childRuns: unusedChildAdapter(), verifier: unusedVerifier(), integrator: unusedIntegrator() });
    await expect(runtime.initialize({ ...baseMissionInput(), memory: { ledgerHeadHash: hash("d"), snapshotHash: null } }))
      .rejects.toThrow(/memory ledger head binding/u);
  });

  it("revalidates the current memory ledger head before each step", async () => {
    const missionRoot = await root();
    const memory = new MemoryStoreV2(missionRoot);
    const appendMemory = async (id: string) => await memory.append({ id, kind: "pattern",
      scope: { workspaceId: "workspace-1", subject: "runtime.binding" },
      provenance: { source: "tool", actorId: "tool:test", observedAt: "2026-11-03T00:00:00.000Z", sourceRefs: [`source:${id}`] },
      trust: { level: "trusted", confidence: 1 }, sensitivity: "internal", content: { id }, sourceState: "fresh" });
    const first = await appendMemory("memory-before-init");
    const runtime = createMissionRuntime({ root: missionRoot, missionId: "mission-memory-recheck", bindingAuthority: trustedBindings(),
      childRuns: unusedChildAdapter(), verifier: unusedVerifier(), integrator: unusedIntegrator(), now: () => "2026-11-03T01:00:00.000Z" });
    await runtime.initialize({ ...baseMissionInput(), memory: { ledgerHeadHash: first.entryHash, snapshotHash: null } });
    await appendMemory("memory-after-init");
    const state = await runtime.step();
    expect(state.blockers[0]?.code).toBe("corrupt_state");
  });

  it("classifies non-event memory records without hiding authority expiry or revocation", () => {
    const base = memoryRecord("candidate", "preference");
    const promoted = memoryRecord("active", "pattern");
    const revoked = memoryRecord("revoked", "feedback");
    const expired = memoryRecord("expired", "preference", { expiresAt: "2026-11-03T12:00:00.000Z" });
    const promotion = (target: MemoryRecordV2, id: string, expiresAt = "2026-12-01T00:00:00.000Z") =>
      memoryRecord(id, "promotion", {
        expiresAt,
        provenance: { source: "human", actorId: "human:k", observedAt: "2026-11-03T00:00:00.000Z", sourceRefs: [`ref:${id}`] },
        trust: { level: "trusted", confidence: 1 },
        content: { targetId: target.id, exactScope: target.scope.subject },
        authority: { verifierId: "host", receiptId: id, action: "promotion", actorId: "human:k",
          workspaceId: "workspace-1", subject: target.scope.subject, targetId: target.id,
          sourceHash: "placeholder", expiresAt }
      });
    const revocation = memoryRecord("revoke-event", "revocation", {
      provenance: { source: "human", actorId: "human:k", observedAt: "2026-11-03T00:00:00.000Z", sourceRefs: ["ref:revoke"] },
      trust: { level: "authoritative", confidence: 1 }, content: { targetId: revoked.id },
      authority: { verifierId: "host", receiptId: "r", action: "revocation", actorId: "human:k",
        workspaceId: "workspace-1", subject: revoked.scope.subject, targetId: revoked.id,
        sourceHash: hash("7"), expiresAt: "2026-12-01T00:00:00.000Z" }
    });
    const records = [base, promoted, revoked, expired, promotion(promoted, "promote-active"),
      promotion(expired, "promote-expired", "2026-11-03T12:00:00.000Z"), revocation];
    // The classifier consumes already integrity-verified records, so bind the synthetic promotion hash as the store does.
    for (const event of records.filter((record) => record.kind === "promotion")) {
      const target = records.find((record) => record.id === (event.content as { targetId: string }).targetId)!;
      event.authority!.sourceHash = memoryApprovalActionSourceHashV2(target.entryHash, event.provenance.sourceRefs[0]!);
    }
    expect(classifyMissionMemoryRecords(records, "2026-11-04T00:00:00.000Z").map(({ record, status }) => [record.id, status])).toEqual([
      ["candidate", "candidate"], ["active", "active"], ["revoked", "revoked"], ["expired", "expired"]
    ]);
  });

  it("accepts mission control only through an injected host approval authority", async () => {
    const missionRoot = await root();
    const approval = {
      schemaVersion: "martin.host-approval.v1" as const, approvalId: "approval-1", missionId: "mission-control",
      action: "pause" as const, actorId: "human:k", issuedAt: "2026-11-03T00:00:00.000Z",
      expiresAt: "2026-11-04T00:00:00.000Z", signature: "signed-host-receipt"
    };
    const input = { intentId: "intent-1", action: "pause" as const, reason: "operator review",
      requestedAt: "2026-11-03T01:00:00.000Z", approval };
    await expect(writeMissionRuntimeControlIntent(missionRoot, "mission-control", input,
      { authorityId: "host", verify: () => false })).rejects.toThrow(/host approval/u);
    await expect(writeMissionRuntimeControlIntent(missionRoot, "mission-control", { ...input, intentId: "../escape" },
      { authorityId: "host", verify: () => true })).rejects.toThrow(/intentId/u);
    await expect(writeMissionRuntimeControlIntent(missionRoot, "../escape", input,
      { authorityId: "host", verify: () => true })).rejects.toThrow(/missionId/u);
    await writeMissionRuntimeControlIntent(missionRoot, "mission-control", input,
      { authorityId: "host", verify: (receipt) => receipt.signature === "signed-host-receipt" });
    expect(await readMissionRuntimeControlIntent(missionRoot, "mission-control")).toMatchObject({
      intentId: "intent-1", action: "pause", verifiedBy: "host"
    });
  });

  it("revalidates a persisted control intent before applying it", async () => {
    const missionRoot = await root();
    let valid = true;
    const authority = { authorityId: "host", verify: () => valid };
    const approval = {
      schemaVersion: "martin.host-approval.v1" as const, approvalId: "approval-recheck", missionId: "mission-control-recheck",
      action: "pause" as const, actorId: "human:k", issuedAt: "2026-11-03T00:00:00.000Z",
      expiresAt: "2026-11-04T00:00:00.000Z", signature: "signed-host-receipt"
    };
    await writeMissionRuntimeControlIntent(missionRoot, "mission-control-recheck", {
      intentId: "intent-recheck", action: "pause", reason: "review", requestedAt: "2026-11-03T01:00:00.000Z", approval
    }, authority);
    valid = false;
    const runtime = createMissionRuntime({ root: missionRoot, missionId: "mission-control-recheck",
      bindingAuthority: trustedBindings(),
      childRuns: unusedChildAdapter(), verifier: unusedVerifier(), integrator: unusedIntegrator(),
      controlAuthority: authority, now: () => "2026-11-03T02:00:00.000Z" });
    await runtime.initialize(baseMissionInput());
    const state = await runtime.step();
    expect(state.blockers[0]?.code).toBe("corrupt_state");
    expect(state.queue[0]?.phase).toBe("blocked");
  });
});

function baseMissionInput() {
  return {
    objective: "ship a verified change",
    sourceSha: hash("a"),
    workspace: { workspaceId: "workspace-1", identityHash: hash("b") },
    context: { manifestHash: hash("c"), tokenCount: 10, compactAtTokens: 100 },
    memory: { ledgerHeadHash: null, snapshotHash: null },
    budget: {
      maxUsd: 5, spentUsd: 0, maxRuns: 3, runsUsed: 0, maxTokens: 2_000, tokensUsed: 0,
      maxConcurrency: 1, activeConcurrency: 0, maxNoProgressIntervals: 2, noProgressIntervals: 0,
      startedAt: "2026-11-03T00:00:00.000Z", wallClockDeadline: "2027-11-04T00:00:00.000Z"
    },
    workItems: [{ id: "build", title: "Build", dependsOn: [], maxAttempts: 2 }],
    writerId: "runtime-test",
    now: "2026-11-03T00:00:00.000Z"
  } as const;
}

function unusedChildAdapter(): MissionChildRunAdapter {
  return { async launch() { throw new Error("unused"); }, async recover() { return null; } };
}
function trustedBindings() {
  return { authorityId: "test-workspace", async verify() { return true; } };
}
function verifiedHandoff(missionId: string, runId: string, receiptHash: string, summary: string, tokenCount: number) {
  const manifestHash = hash("3");
  return {
    manifestHash, summary, tokenCount,
    receipt: {
      schemaVersion: "martin.handoff.v1" as const,
      handoffId: `handoff:${runId}`, chainId: `chain:${missionId}`, missionId,
      producerRunId: runId, producerReceiptHash: receiptHash,
      claims: [], artifacts: [{ sha256: manifestHash, required: true }], unresolvedAssumptions: [],
      upstreamIntegrity: "verified" as const, createdAt: "2026-11-03T01:00:00.000Z"
    },
    producerReceiptVerified: true,
    availableArtifactHashes: [manifestHash]
  };
}
function unusedVerifier(): MissionVerificationAdapter {
  return { async verify() { throw new Error("unused"); } };
}
function unusedIntegrator(): MissionIntegrationAdapter {
  return { async integrate() { throw new Error("unused"); }, async recover() { return null; } };
}
function candidateAdapter(): MissionChildRunAdapter {
  return {
    async launch(input) {
      return { kind: "candidate", runId: input.runId, receiptHash: hash("1"), candidateHash: hash("2"), actualUsd: 1, tokens: 100,
        handoff: verifiedHandoff(input.missionId, input.runId, hash("1"), "child output", 20) };
    },
    async recover() { return null; }
  };
}

function memoryRecord(id: string, kind: MemoryRecordV2["kind"], overrides: Partial<MemoryRecordV2> = {}): MemoryRecordV2 {
  return {
    schemaVersion: "2.0.0", id, kind, sequence: 1, createdAt: "2026-11-03T00:00:00.000Z",
    scope: { workspaceId: "workspace-1", subject: "subject" },
    provenance: { source: "tool", actorId: "tool:test", observedAt: "2026-11-03T00:00:00.000Z", sourceRefs: ["ref:test"] },
    trust: { level: "trusted", confidence: 1 }, sensitivity: "internal", content: {},
    contentHash: hash("a"), previousHash: null, entryHash: hash(id.length.toString(16).slice(-1)),
    ...overrides
  };
}
