import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SWARM_CHILD_MAX_WALL_CLOCK_MS,
  type SwarmLivePlan,
} from "@martin/contracts";

import { parseCliArguments } from "../src/index.js";
import {
  executePersistedSwarmDemoCommand,
  hasCanonicalLiveProviderEvidence,
} from "../src/swarm-command-private.js";
import {
  executePersistedSwarmDemoRoute,
  type PersistedSwarmDemoRouteDependencies,
} from "../src/swarm-demo.js";

describe("persisted swarm demo routing", () => {
  it("parses governed deterministic mode without changing default simulation", () => {
    expect(parseCliArguments(["demo", "--swarm"])).toMatchObject({
      command: "demo",
      swarm: true,
      mode: "simulation",
    });
    expect(parseCliArguments([
      "demo", "--swarm", "--governed", "--runs-dir", "runs",
    ])).toMatchObject({
      command: "demo",
      swarm: true,
      mode: "governed",
      agents: 15,
      maxConcurrency: 5,
      budgetUsd: 0,
      runsDir: "runs",
    });
  });

  it("translates the exact live qualification values without reinterpretation", () => {
    expect(parseCliArguments([
      "demo", "--swarm", "--live", "--engine", "codex", "--agents", "15",
      "--max-concurrency", "5", "--budget-usd", "12",
    ])).toMatchObject({
      command: "demo",
      swarm: true,
      mode: "live",
      engine: "codex",
      agents: 15,
      maxConcurrency: 5,
      budgetUsd: 12,
    });
  });

  it.each([
    ["agents", ["--max-concurrency", "5", "--budget-usd", "12"]],
    ["max-concurrency", ["--agents", "15", "--budget-usd", "12"]],
    ["budget-usd", ["--agents", "15", "--max-concurrency", "5"]],
  ] as const)("requires an explicit positive live --%s value", (name, values) => {
    expect(() => parseCliArguments(["demo", "--swarm", "--live", ...values]))
      .toThrow(new RegExp(name, "iu"));
  });

  it.each([
    ["--agents", ["--agents", "15", "--agents", "10", "--max-concurrency", "5", "--budget-usd", "12"]],
    ["--max-concurrency", ["--agents", "15", "--max-concurrency", "5", "--max-concurrency", "4", "--budget-usd", "12"]],
    ["--budget-usd", ["--agents", "15", "--max-concurrency", "5", "--budget-usd", "12", "--budget-usd", "10"]],
    ["--engine", ["--agents", "15", "--max-concurrency", "5", "--budget-usd", "12", "--engine", "codex", "--engine", "codex"]],
    ["--cwd", ["--agents", "15", "--max-concurrency", "5", "--budget-usd", "12", "--cwd", "one", "--cwd", "two"]],
    ["--runs-dir", ["--agents", "15", "--max-concurrency", "5", "--budget-usd", "12", "--runs-dir", "one", "--runs-dir", "two"]],
  ] as const)("fails closed on duplicate live %s options", (_name, values) => {
    expect(() => parseCliArguments(["demo", "--swarm", "--live", ...values]))
      .toThrow(/duplicate|only be provided once/iu);
  });

  it.each([
    ["--scenario", ["--scenario", "launch-board", "--scenario", "launch-board"]],
    ["--dir", ["--dir", "one", "--dir", "two"]],
  ] as const)("fails closed on duplicate deterministic %s options", (_name, values) => {
    expect(() => parseCliArguments(["demo", "--swarm", ...values]))
      .toThrow(/duplicate|only be provided once/iu);
  });

  it("rejects ambiguous or weakened live qualification arguments", () => {
    expect(() => parseCliArguments(["demo", "--swarm", "--governed", "--live"]))
      .toThrow(/mutually exclusive|exactly one/iu);
    expect(() => parseCliArguments([
      "demo", "--swarm", "--live", "--engine", "claude", "--agents", "15",
      "--max-concurrency", "5", "--budget-usd", "12",
    ])).toThrow(/codex/iu);
    expect(() => parseCliArguments([
      "demo", "--swarm", "--live", "--engine", "codex", "--agents", "15.5",
      "--max-concurrency", "5", "--budget-usd", "12",
    ])).toThrow(/agents|integer/iu);
    expect(() => parseCliArguments([
      "demo", "--swarm", "--live", "--engine", "codex", "--agents", "3",
      "--max-concurrency", "5", "--budget-usd", "3",
    ])).toThrow(/concurrency/iu);
    expect(() => parseCliArguments([
      "demo", "--swarm", "--live", "--agents", "16", "--max-concurrency", "5", "--budget-usd", "12",
    ])).toThrow(/agents|15/iu);
    expect(() => parseCliArguments([
      "demo", "--swarm", "--live", "--agents", "9007199254740992", "--max-concurrency", "5", "--budget-usd", "12",
    ])).toThrow(/agents|safe|15/iu);
    expect(() => parseCliArguments(["demo", "--swarm", "--live", "--dir", "ignored", "--budget-usd", "12"]))
      .toThrow(/--dir|persisted/iu);
    expect(() => parseCliArguments(["demo", "--swarm", "--governed", "--force"]))
      .toThrow(/--force|persisted/iu);
  });

  it("does not create a runs root before repository admission passes", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-live-swarm-admission-"));
    const runsDir = join(root, "must-not-exist");
    try {
      await expect(executePersistedSwarmDemoCommand({
        mode: "governed",
        cwd: root,
        runsDir,
        agents: 3,
        maxConcurrency: 3,
        budgetUsd: 0,
        engine: "codex",
      }, "json", {
        readRepositoryRoot: async () => root,
        readBaselineCommit: async () => "a".repeat(40),
        readWorktreeClean: async () => false,
        runLiveSwarm: vi.fn(),
        resolveCodexLaunch: vi.fn(),
      })).rejects.toThrow(/clean worktree/iu);
      await expect(stat(runsDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports provider execution only when runtime evidence observes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-live-swarm-provider-truth-"));
    const runsDir = join(root, "runs");
    try {
      const result = await executePersistedSwarmDemoCommand({
        mode: "live",
        cwd: root,
        runsDir,
        agents: 3,
        maxConcurrency: 3,
        budgetUsd: 3,
        engine: "codex",
      }, "json", {
        readRepositoryRoot: async () => root,
        readBaselineCommit: async () => "a".repeat(40),
        readWorktreeClean: async () => true,
        runLiveSwarm: vi.fn(async () => ({
          record: {
            swarmId: "blocked-before-provider",
            events: [],
            budgetLedger: { capUsd: 3, settledUsd: 0, settledTokens: 0, leases: [] },
            parentContract: { policyVersion: "test" },
          },
          outcome: { state: "needs_review", reason: "Provider was not launched." },
          candidateIds: [],
        }) as never),
        resolveCodexLaunch: vi.fn(),
      });
      const payload = JSON.parse(result.stdout) as { providerExecuted?: boolean };
      expect(payload.providerExecuted).toBe(false);
      expect(result.exitCode).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not impose a static token cap on live Codex swarm capacity", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-live-swarm-token-capacity-"));
    const runsDir = join(root, "runs");
    let capturedPlan: SwarmLivePlan | undefined;
    try {
      await executePersistedSwarmDemoCommand({
        mode: "live",
        cwd: root,
        runsDir,
        agents: 3,
        maxConcurrency: 3,
        budgetUsd: 3,
        engine: "codex",
      }, "json", {
        readRepositoryRoot: async () => root,
        readBaselineCommit: async () => "a".repeat(40),
        readWorktreeClean: async () => true,
        runLiveSwarm: vi.fn(async (input) => {
          capturedPlan = input.plan;
          return {
            record: {
              swarmId: input.plan.swarmId,
              events: [],
              budgetLedger: { capUsd: 3, settledUsd: 0, settledTokens: 0, leases: [] },
              parentContract: { policyVersion: "test" },
            },
            outcome: { state: "needs_review", reason: "Provider was not launched." },
            candidateIds: [],
          } as never;
        }),
        resolveCodexLaunch: vi.fn(),
      });

      if (!capturedPlan) throw new Error("Expected the live swarm plan to reach the runtime boundary.");
      expect(capturedPlan.parentContract.budget.maxTokens).toBeUndefined();
      expect(capturedPlan.parentContract.budget.maxUsd).toBe(3);
      expect(capturedPlan.agents).toHaveLength(3);
      for (const agent of capturedPlan.agents) {
        expect(agent.contract.budget.maxTokens).toBeUndefined();
        expect(agent.contract.hardMaxTokens).toBeUndefined();
        expect(agent.contract.budget.maxUsd).toBe(1);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [{ agents: 3, maxConcurrency: 3, budgetUsd: 3 }, 360_000],
    [{ agents: 15, maxConcurrency: 5, budgetUsd: 12 }, 840_000],
  ])("derives one parent and abort deadline from swarm execution waves for %o", async (shape, expectedDeadlineMs) => {
    const root = await mkdtemp(join(tmpdir(), "martin-live-swarm-wave-deadline-"));
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    let capturedPlan: SwarmLivePlan | undefined;
    try {
      await executePersistedSwarmDemoCommand({
        mode: "live",
        cwd: root,
        runsDir: join(root, "runs"),
        ...shape,
        engine: "codex",
      }, "json", {
        readRepositoryRoot: async () => root,
        readBaselineCommit: async () => "a".repeat(40),
        readWorktreeClean: async () => true,
        runLiveSwarm: vi.fn(async (input) => {
          capturedPlan = input.plan;
          return {
            record: {
              swarmId: input.plan.swarmId,
              events: [],
              budgetLedger: { capUsd: shape.budgetUsd, settledUsd: 0, settledTokens: 0, leases: [] },
              parentContract: input.plan.parentContract,
            },
            outcome: { state: "needs_review", reason: "Timing inspection only." },
            candidateIds: [],
          } as never;
        }),
        resolveCodexLaunch: vi.fn(),
      });

      if (!capturedPlan) throw new Error("Expected the live swarm plan to reach the runtime boundary.");
      expect(capturedPlan.parentContract.maxWallClockMs).toBe(expectedDeadlineMs);
      expect(capturedPlan.agents.every(
        (agent) => agent.contract.maxWallClockMs === SWARM_CHILD_MAX_WALL_CLOCK_MS,
      )).toBe(true);
      expect(timeoutSpy.mock.calls.some((call) => call[1] === expectedDeadlineMs)).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires closed process, raw provider usage, and a matching settled lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-live-swarm-provider-evidence-"));
    const childRunId = "child-live-1";
    const childDir = join(root, childRunId);
    const baseResult = {
      record: {
        events: [{
          type: "CHILD_VERIFIED",
          childRunId,
          agentId: "agent-1",
          taskId: "task-1",
          payload: {
            processCloseState: "closed",
            leaseId: "lease-1",
            agentId: "agent-1",
            taskId: "task-1",
            leaseState: "settled",
            actualUsd: 0.25,
            actualTokens: 30,
          },
        }],
        budgetLedger: {
          settledUsd: 0.25,
          settledTokens: 30,
          leases: [{
            leaseId: "lease-1",
            agentId: "agent-1",
            taskId: "task-1",
            status: "settled",
            actualUsage: { usd: 0.25, tokens: 30, provenance: "provider_reported" },
          }],
        },
      },
    } as never;
    try {
      await mkdir(childDir, { recursive: true });
      await writeFile(join(childDir, "loop-record.json"), JSON.stringify({
        cost: {
          actualUsd: 0.25,
          tokensIn: 20,
          tokensOut: 10,
          providerSettlement: {
            providerId: "codex",
            model: "gpt-6.1-sol",
            transport: "cli",
            source: "codex_jsonl",
            inputTokens: 20,
            outputTokens: 10,
            rawUsageAvailable: true,
            settledAt: "2026-11-01T00:00:00.000Z",
          },
        },
      }), "utf8");

      await expect(hasCanonicalLiveProviderEvidence(baseResult, root, "codex", "gpt-6.1-sol")).resolves.toBe(true);

      const childOnly = structuredClone(baseResult) as any;
      childOnly.record.budgetLedger.leases = [];
      await expect(hasCanonicalLiveProviderEvidence(childOnly, root, "codex", "gpt-6.1-sol")).resolves.toBe(false);

      for (const settlementMutation of [
        { source: "fabricated_provider_log" },
        { inputTokens: 19, outputTokens: 11 },
        { model: "gpt-forged" },
        { transport: "http" },
        { settledAt: "not-a-timestamp" },
      ]) {
        await writeFile(join(childDir, "loop-record.json"), JSON.stringify({
          cost: {
            actualUsd: 0.25,
            tokensIn: 20,
            tokensOut: 10,
            providerSettlement: {
              providerId: "codex",
              model: "gpt-6.1-sol",
              transport: "cli",
              source: "codex_jsonl",
              inputTokens: 20,
              outputTokens: 10,
              rawUsageAvailable: true,
              settledAt: "2026-11-01T00:00:00.000Z",
              ...settlementMutation,
            },
          },
        }), "utf8");
        await expect(
          hasCanonicalLiveProviderEvidence(baseResult, root, "codex", "gpt-6.1-sol"),
        ).resolves.toBe(false);
      }

      await writeFile(join(childDir, "loop-record.json"), JSON.stringify({
        cost: {
          actualUsd: 0.25,
          tokensIn: 20,
          tokensOut: 10,
          providerSettlement: {
            providerId: "codex",
            model: "gpt-6.1-sol",
            transport: "cli",
            source: "estimated_fallback",
            inputTokens: 20,
            outputTokens: 10,
            rawUsageAvailable: false,
            settledAt: "2026-11-01T00:00:00.000Z",
          },
        },
      }), "utf8");
      await expect(
        hasCanonicalLiveProviderEvidence(baseResult, root, "codex", "gpt-6.1-sol"),
      ).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("brands governed provider-free execution as local deterministic, separate from its engine", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-live-swarm-local-identity-"));
    try {
      await executePersistedSwarmDemoCommand({
        mode: "governed",
        cwd: root,
        runsDir: join(root, "runs"),
        agents: 1,
        maxConcurrency: 1,
        budgetUsd: 0,
        engine: "codex",
      }, "json", {
        readRepositoryRoot: async () => root,
        readBaselineCommit: async () => "a".repeat(40),
        readWorktreeClean: async () => true,
        runLiveSwarm: vi.fn(async (input) => {
          expect(input.plan.engine).toEqual({ engine: "openai", model: "deterministic-governed" });
          const created = input.adapterFactory({
            engine: input.plan.engine,
            task: input.plan.tasks[0]!,
            agent: input.plan.agents[0]!,
            childRunId: "local-child",
            workspace: { path: root, record: { workspaceId: "local-workspace" } } as never,
            budget: input.plan.agents[0]!.contract.budget,
          });
          const adapter = "adapter" in created ? created.adapter : created;
          expect(adapter.metadata).toMatchObject({
            providerId: "local-deterministic",
            model: "deterministic-governed",
          });
          expect(`${adapter.adapterId} ${adapter.label} ${JSON.stringify(adapter.metadata)}`)
            .not.toMatch(/codex|gpt/iu);
          return {
            record: {
              swarmId: input.plan.swarmId,
              events: [],
              budgetLedger: { capUsd: 0, settledUsd: 0, settledTokens: 0, leases: [] },
              parentContract: { policyVersion: "test" },
            },
            outcome: { state: "needs_review", reason: "Identity inspection only." },
            candidateIds: [],
          } as never;
        }),
        resolveCodexLaunch: vi.fn(),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["governed", "live"] as const)(
    "never falls back to simulation when %s persisted execution fails",
    async (mode) => {
      const simulation = vi.fn();
      const governed = vi.fn(async () => {
        throw new Error("persisted governed failure");
      });
      const live = vi.fn(async () => {
        throw new Error("provider or persistence failure");
      });
      const dependencies: PersistedSwarmDemoRouteDependencies = {
        runSimulation: simulation,
        runGoverned: governed,
        runLive: live,
      };
      const request = {
        mode,
        cwd: process.cwd(),
        agents: mode === "live" ? 15 : 15,
        maxConcurrency: 5,
        budgetUsd: mode === "live" ? 12 : 0,
        engine: "codex" as const,
      };

      await expect(executePersistedSwarmDemoRoute(request, dependencies)).rejects.toThrow(/failure/iu);
      expect(simulation).not.toHaveBeenCalled();
      expect(governed).toHaveBeenCalledTimes(mode === "governed" ? 1 : 0);
      expect(live).toHaveBeenCalledTimes(mode === "live" ? 1 : 0);
    },
  );
});
