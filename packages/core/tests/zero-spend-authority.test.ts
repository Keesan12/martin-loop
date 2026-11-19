import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { runMartin, type MartinAdapter } from "../src/index";
import { evaluateCostGovernor } from "../src/policy";

const execFileAsync = promisify(execFile);

const adapter: MartinAdapter = {
  adapterId: "zero-spend-test",
  kind: "agent-cli",
  label: "zero spend authority test adapter",
  metadata: { providerId: "local-deterministic", model: "deterministic-governed", capabilities: { workspaceMutations: false } },
  async execute() {
    throw new Error("the adapter must never run when the authority guard rejects the input");
  },
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "workspace-zero-spend",
    projectId: "project-zero-spend",
    task: { title: "t", objective: "o", verificationPlan: ["node --version"], repoRoot: process.cwd() },
    budget: { maxUsd: 0, softLimitUsd: 0, maxIterations: 1 },
    adapter,
    spendAuthority: "provider_free_zero_spend" as const,
    forceWorkspaceMutationTracking: true,
    ...overrides,
  } as Parameters<typeof runMartin>[0];
}

describe("provider-free zero-spend authority guard", () => {
  it("requires an exactly zero USD budget", async () => {
    await expect(runMartin(input({ budget: { maxUsd: 1, softLimitUsd: 0, maxIterations: 1 } })))
      .rejects.toThrow(/exactly zero USD budget/u);
  });

  it("requires forced workspace mutation tracking", async () => {
    await expect(runMartin(input({ forceWorkspaceMutationTracking: undefined })))
      .rejects.toThrow(/forced workspace mutation tracking/u);
  });

  it("requires a workspace repoRoot to observe", async () => {
    await expect(runMartin(input({ task: { title: "t", objective: "o", verificationPlan: ["node --version"] } })))
      .rejects.toThrow(/repoRoot/u);
  });

  it("rejects an unknown spend authority", async () => {
    await expect(runMartin(input({ spendAuthority: "anything" }))).rejects.toThrow(/Unknown spend authority/u);
  });

  it("does not let a public exit policy grant zero-spend semantics", async () => {
    await expect(runMartin(input({
      spendAuthority: undefined,
      forceWorkspaceMutationTracking: undefined,
      budget: { maxUsd: 1, softLimitUsd: 1, maxIterations: 1 },
      exitPolicy: { budget: { maxUsd: 0, zeroSpendAuthority: true } },
    }))).rejects.toThrow(/zeroSpendAuthority can only be granted/u);
  });
});

describe("cost governor under zero-spend authority", () => {
  const cost = (actualUsd: number) => ({ actualUsd, tokensIn: 0, tokensOut: 0 });
  const budget = { maxUsd: 0, softLimitUsd: 0, maxIterations: 3 };

  it("reports healthy for a zero budget with zero spend", () => {
    const state = evaluateCostGovernor({ budget, cost: cost(0) as never, attemptsUsed: 0, zeroSpendAuthority: true });
    expect(state).toMatchObject({ pressure: "healthy", shouldStop: false });
  });

  it("treats any positive spend as a hard limit", () => {
    const state = evaluateCostGovernor({ budget, cost: cost(0.000001) as never, attemptsUsed: 0, zeroSpendAuthority: true });
    expect(state).toMatchObject({ pressure: "hard_limit", shouldStop: true });
  });

  it("keeps standard semantics: a zero budget is a hard limit and a budget at the cap is exhausted", () => {
    expect(evaluateCostGovernor({ budget, cost: cost(0) as never, attemptsUsed: 0 }))
      .toMatchObject({ pressure: "hard_limit", shouldStop: true });
    expect(evaluateCostGovernor({ budget: { maxUsd: 5, softLimitUsd: 4, maxIterations: 3 }, cost: cost(5) as never, attemptsUsed: 0 }))
      .toMatchObject({ pressure: "hard_limit" });
    expect(evaluateCostGovernor({ budget: { maxUsd: 5, softLimitUsd: 4, maxIterations: 3 }, cost: cost(4.5) as never, attemptsUsed: 0 }))
      .toMatchObject({ pressure: "soft_limit" });
  });
});

describe("runMartin wiring under zero-spend authority", () => {
  async function runZeroSpend(spendAuthority: "provider_free_zero_spend" | undefined) {
    const root = await mkdtemp(join(tmpdir(), "martin-zero-spend-run-"));
    try {
      await execFileAsync("git", ["init"], { cwd: root });
      await execFileAsync("git", ["config", "user.email", "zero@example.invalid"], { cwd: root });
      await execFileAsync("git", ["config", "user.name", "Zero Spend"], { cwd: root });
      await writeFile(join(root, "README.md"), "zero\n", "utf8");
      await execFileAsync("git", ["add", "."], { cwd: root });
      await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });
      const passing: MartinAdapter = {
        ...adapter,
        async execute(request) {
          return {
            status: "completed",
            summary: "done",
            usage: { actualUsd: 0, tokensIn: 0, tokensOut: 0 },
            verification: {
              passed: true,
              summary: "pass",
              binding: {
                runId: request.loopId,
                attemptId: request.attemptId,
                ...(request.context.runsRoot ? { runsRoot: request.context.runsRoot } : {}),
                ...(request.context.executionProfile ? { executionProfile: request.context.executionProfile } : {}),
                workspaceId: request.workspaceId,
                cwd: request.context.repoRoot ?? root,
                commands: request.context.verificationPlan,
              },
              steps: request.context.verificationPlan.map((command) => ({
                command, launched: true, completed: true, crashed: false, exitCode: 0, timedOut: false,
              })),
            },
          };
        },
      };
      return await runMartin({
        workspaceId: "workspace-zero-spend-run",
        projectId: "project-zero-spend-run",
        task: { title: "t", objective: "o", verificationPlan: ["node --version"], repoRoot: root, mutationMode: "read_only" },
        budget: { maxUsd: 0, softLimitUsd: 0, maxIterations: 3 },
        adapter: passing,
        ...(spendAuthority ? { spendAuthority, forceWorkspaceMutationTracking: true } : {}),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("records healthy budget pressure and no budget_exit for a verified zero-spend child", async () => {
    const result = await runZeroSpend("provider_free_zero_spend");
    expect(result.loop.status).toBe("completed");
    const budgetEvents = result.loop.events.filter((event) => event.type === "budget.updated");
    expect(budgetEvents.length).toBeGreaterThan(0);
    for (const event of budgetEvents) {
      expect(event.payload).toMatchObject({ pressure: "healthy", actualUsd: 0 });
      expect(event.lifecycleState).not.toBe("budget_exit");
    }
  });

  it("keeps standard behavior: the same zero budget without the authority is exhausted immediately", async () => {
    await expect(runZeroSpend(undefined)).rejects.toThrow(/greater than zero/u);
  });
});
