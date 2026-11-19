import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SWARM_CHILD_MAX_WALL_CLOCK_MS, createSwarmLivePlan, type SwarmLivePlan } from "@martin/contracts";
import type { MartinAdapter, MartinAdapterRequest } from "../src/index";
import {
  PROVIDER_FREE_DETERMINISTIC_ADAPTER_ID,
  PROVIDER_FREE_DETERMINISTIC_MODEL,
  PROVIDER_FREE_DETERMINISTIC_PROVIDER_ID,
  runProductionLiveSwarm,
  type RunProductionLiveSwarmInput,
} from "../src/swarm/live-runtime";

const execFileAsync = promisify(execFile);

let scratchRoot: string;
let previousIntegrityKeyDir: string | undefined;

beforeEach(async () => {
  scratchRoot = await mkdtemp(join(tmpdir(), "martin-provider-binding-"));
  previousIntegrityKeyDir = process.env.MARTIN_INTEGRITY_KEY_DIR;
  process.env.MARTIN_INTEGRITY_KEY_DIR = join(scratchRoot, "integrity");
});

afterEach(async () => {
  if (previousIntegrityKeyDir === undefined) delete process.env.MARTIN_INTEGRITY_KEY_DIR;
  else process.env.MARTIN_INTEGRITY_KEY_DIR = previousIntegrityKeyDir;
  await rm(scratchRoot, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, windowsHide: true })).stdout;
}

async function createRepository(): Promise<{ canonicalRoot: string; runsRoot: string; baselineCommit: string }> {
  const canonicalRoot = join(scratchRoot, "repo");
  const runsRoot = join(scratchRoot, "runs");
  await mkdir(canonicalRoot, { recursive: true });
  await mkdir(runsRoot, { recursive: true });
  await git(canonicalRoot, ["init"]);
  await git(canonicalRoot, ["config", "user.email", "binding@example.invalid"]);
  await git(canonicalRoot, ["config", "user.name", "Binding Test"]);
  await writeFile(join(canonicalRoot, "README.md"), "binding\n", "utf8");
  await git(canonicalRoot, ["add", "README.md"]);
  await git(canonicalRoot, ["commit", "-m", "fixture"]);
  return { canonicalRoot, runsRoot, baselineCommit: (await git(canonicalRoot, ["rev-parse", "HEAD"])).trim() };
}

function buildPlan(input: {
  baselineCommit: string;
  engine: { engine: "openai" | "codex"; model: string };
  parentUsd: number;
  childUsd: number;
}): SwarmLivePlan {
  const permissions = { networkDomains: [], commands: ["node --version"] };
  return createSwarmLivePlan({
    planId: "plan-binding",
    swarmId: "swarm-binding",
    workspaceId: "workspace-binding",
    projectId: "project-binding",
    baselineCommit: input.baselineCommit,
    parentContract: {
      policyVersion: "binding-test-v1",
      objective: "Exercise provider binding authority.",
      definitionOfDone: ["The child completes with bound verification."],
      budget: { maxUsd: input.parentUsd, softLimitUsd: 0, maxIterations: 1 },
      maxWallClockMs: 360_000,
      maxConcurrency: 1,
      scope: { allowedPaths: ["**/*"], deniedPaths: [".git/**"] },
      permissions,
      integrationStrategy: "parent_fan_in",
      globalVerifierStack: [{ command: "node --version", type: "test_full" }],
      stopPolicy: { budgetExhausted: "stop", blockingFailure: "needs_review", verifierFailure: "stop" },
      recoveryPolicy: { maxReassignmentsPerTask: 0, dependencyWaiversAllowed: false },
      approvalPolicy: {},
      orchestrationStrategy: "hierarchical_dag",
    },
    tasks: [{
      taskId: "task-1",
      title: "Binding task",
      objective: "Inspect the baseline without changing files.",
      required: true,
      dependsOn: [],
      assignedAgentId: "agent-1",
      status: "queued" as const,
      mutationMode: "read_only" as const,
      writeScope: [],
    }],
    agents: [{
      agentId: "agent-1",
      role: "worker",
      status: "queued" as const,
      contract: {
        agentId: "agent-1",
        taskIds: ["task-1"],
        scope: { allowedPaths: ["**/*"], deniedPaths: [".git/**"] },
        budget: { maxUsd: input.childUsd, softLimitUsd: 0, maxIterations: 1 },
        maxWallClockMs: SWARM_CHILD_MAX_WALL_CLOCK_MS,
        permissions,
        approvalPolicy: {},
        verifierAuthority: "child_only" as const,
      },
    }],
    engine: input.engine,
    childMaxIterations: 1,
    createdAt: new Date().toISOString(),
  });
}

type AdapterOverrides = {
  adapterId?: string;
  providerId?: string;
  model?: string;
  workspaceMutations?: boolean;
  usage?: Partial<MartinAdapter["metadata"]> & Record<string, unknown>;
};

function adapter(overrides: AdapterOverrides = {}, usage: Record<string, unknown> = {}): MartinAdapter {
  return {
    adapterId: overrides.adapterId ?? PROVIDER_FREE_DETERMINISTIC_ADAPTER_ID,
    kind: "agent-cli",
    label: "provider binding test adapter",
    metadata: {
      providerId: overrides.providerId ?? PROVIDER_FREE_DETERMINISTIC_PROVIDER_ID,
      model: overrides.model ?? PROVIDER_FREE_DETERMINISTIC_MODEL,
      capabilities: { workspaceMutations: overrides.workspaceMutations ?? false },
    },
    async execute(request: MartinAdapterRequest) {
      return {
        status: "completed" as const,
        summary: "Binding test child completed.",
        usage: { actualUsd: 0, tokensIn: 0, tokensOut: 0, ...usage },
        verification: {
          passed: true,
          summary: "passed",
          binding: {
            runId: request.loopId,
            attemptId: request.attemptId,
            ...(request.context.runsRoot ? { runsRoot: request.context.runsRoot } : {}),
            ...(request.context.executionProfile ? { executionProfile: request.context.executionProfile } : {}),
            workspaceId: request.workspaceId,
            cwd: request.context.repoRoot ?? process.cwd(),
            commands: request.context.verificationPlan,
          },
          steps: request.context.verificationPlan.map((command) => ({
            command,
            launched: true,
            completed: true,
            crashed: false,
            exitCode: 0,
            timedOut: false,
          })),
        },
      };
    },
  };
}

function passingVerifier() {
  return {
    async execute(request: any) {
      return {
        passed: true,
        processCloseState: "closed" as const,
        binding: {
          swarmId: request.swarmId,
          workspaceId: request.workspaceId,
          cwd: request.cwd,
          parentPolicyVersion: request.parentPolicyVersion,
          baselineCommit: request.baselineCommit,
          integratedTreeHash: request.integratedTreeHash,
          commands: request.commands.map((step: any) => step.command),
        },
        subprocessResults: request.commands.map((step: any) => ({
          command: step.command,
          launched: true,
          completed: true,
          timedOut: false,
          exitCode: 0,
          startedAt: "2026-10-03T00:00:00.000Z",
          completedAt: "2026-10-03T00:00:01.000Z",
        })),
      };
    },
  } as any;
}

let lastRunsRoot = "";

async function readJsonDocuments(root: string): Promise<unknown[]> {
  const documents: unknown[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      const text = await readFile(path, "utf8");
      const lines = entry.name.endsWith(".jsonl") ? text.split("\n") : entry.name.endsWith(".json") ? [text] : [];
      for (const line of lines) {
        try { documents.push(JSON.parse(line)); } catch { /* not a JSON document */ }
      }
    }
  };
  await walk(root);
  return documents;
}

function collectNumbers(documents: readonly unknown[], keys: readonly string[]): Map<string, number[]> {
  const found = new Map<string, number[]>(keys.map((key) => [key, []]));
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (typeof child === "number" && found.has(key)) found.get(key)!.push(child);
      else visit(child);
    }
  };
  documents.forEach(visit);
  return found;
}

async function run(
  childAdapter: MartinAdapter,
  options: {
    mode?: RunProductionLiveSwarmInput["providerBindingMode"];
    engine?: { engine: "openai" | "codex"; model: string };
    parentUsd?: number;
    childUsd?: number;
  } = {},
) {
  const repo = await createRepository();
  lastRunsRoot = repo.runsRoot;
  const plan = buildPlan({
    baselineCommit: repo.baselineCommit,
    engine: options.engine ?? { engine: "openai", model: PROVIDER_FREE_DETERMINISTIC_MODEL },
    parentUsd: options.parentUsd ?? 0,
    childUsd: options.childUsd ?? 0,
  });
  return runProductionLiveSwarm({
    ...(options.mode ? { providerBindingMode: options.mode } : {}),
    plan,
    canonicalRoot: repo.canonicalRoot,
    ownedRoot: join(repo.runsRoot, "_swarms", plan.swarmId, "worktrees"),
    storeRoot: repo.runsRoot,
    runsRoot: repo.runsRoot,
    workspaceIsolationMode: "independent_clone",
    adapterFactory: () => childAdapter,
    verifierExecutor: passingVerifier(),
  });
}

const eventText = (result: Awaited<ReturnType<typeof run>>) => JSON.stringify([result.outcome, result.record.events]);

describe("provider binding authority", () => {
  it("accepts the compliant local deterministic adapter only under the explicit provider-free mode", async () => {
    const result = await run(adapter(), { mode: "provider_free_deterministic" });
    expect(result.outcome.state).toBe("verified");
    expect(eventText(result)).toContain("provider_free_deterministic");
  }, 120_000);

  it("keeps strict binding the default: the same adapter is rejected without the explicit mode", async () => {
    const result = await run(adapter());
    expect(result.outcome.state).not.toBe("verified");
    expect(eventText(result)).toContain("LIVE_ENGINE_PROVIDER_MISMATCH");
  }, 120_000);

  it("keeps strict binding for live providers: a mismatched provider is rejected", async () => {
    const result = await run(adapter({ providerId: "something-else", model: "gpt-live" }), {
      mode: "strict",
      engine: { engine: "codex", model: "gpt-live" },
      parentUsd: 1,
      childUsd: 1,
    });
    expect(result.outcome.state).not.toBe("verified");
    expect(eventText(result)).toContain("LIVE_ENGINE_PROVIDER_MISMATCH");
  }, 120_000);

  it("rejects an arbitrary provider identity under provider-free mode", async () => {
    const result = await run(adapter({ providerId: "evil-provider" }), { mode: "provider_free_deterministic" });
    expect(result.outcome.state).not.toBe("verified");
    expect(eventText(result)).toContain("LIVE_ENGINE_PROVIDER_MISMATCH");
  }, 120_000);

  it("rejects a foreign adapter id under provider-free mode", async () => {
    const result = await run(adapter({ adapterId: "live-swarm:codex" }), { mode: "provider_free_deterministic" });
    expect(result.outcome.state).not.toBe("verified");
    expect(eventText(result)).toContain("LIVE_ENGINE_PROVIDER_MISMATCH");
  }, 120_000);

  it("rejects a wrong adapter model under provider-free mode", async () => {
    const result = await run(adapter({ model: "gpt-6.1-sol" }), { mode: "provider_free_deterministic" });
    expect(result.outcome.state).not.toBe("verified");
    expect(eventText(result)).toContain("LIVE_ENGINE_PROVIDER_MISMATCH");
  }, 120_000);

  it("rejects provider-free mode on a plan with a different model", async () => {
    await expect(run(adapter({ model: "gpt-6.1-sol" }), {
      mode: "provider_free_deterministic",
      engine: { engine: "openai", model: "gpt-6.1-sol" },
    })).rejects.toThrow(/LIVE_ENGINE_PROVIDER_MISMATCH/u);
  }, 120_000);

  it.each([
    ["parent", { parentUsd: 1, childUsd: 0 }, /LIVE_ENGINE_PROVIDER_MISMATCH/u],
    ["parent and child", { parentUsd: 1, childUsd: 1 }, /LIVE_ENGINE_PROVIDER_MISMATCH/u],
    // Plan validation already refuses a child budget above its parent, so this never reaches the mode check.
    ["child above a zero parent", { parentUsd: 0, childUsd: 1 }, /Core rejected the live swarm plan/u],
  ] as const)("rejects provider-free mode when the %s budget is positive", async (_label, budgets, expected) => {
    await expect(run(adapter(), { mode: "provider_free_deterministic", ...budgets })).rejects.toThrow(expected);
  }, 120_000);

  it("rejects an adapter that declares workspace mutation under provider-free mode", async () => {
    const result = await run(adapter({ workspaceMutations: true }), { mode: "provider_free_deterministic" });
    expect(result.outcome.state).not.toBe("verified");
    expect(eventText(result)).toContain("LIVE_ENGINE_PROVIDER_MISMATCH");
  }, 120_000);

  it.each([
    ["positive spend", { actualUsd: 0.5 }],
    ["positive provider tokens", { tokensIn: 3, tokensOut: 2 }],
    ["a provider settlement", {
      providerSettlement: {
        providerId: "openai-compatible",
        model: "x",
        transport: "http",
        source: "openai_compatible_json",
        inputTokens: 0,
        outputTokens: 0,
        rawUsageAvailable: true,
        settledAt: "2026-10-03T00:00:00.000Z",
      },
    }],
  ] as const)("fails closed when a provider-free child reports %s", async (_label, usage) => {
    const result = await run(adapter({}, usage as Record<string, unknown>), { mode: "provider_free_deterministic" });
    expect(result.outcome.state).not.toBe("verified");
    expect(eventText(result)).toContain("PROVIDER_FREE_INVARIANT_VIOLATION");
  }, 120_000);

  it.each([
    ["an estimated cost", { usage: { estimatedUsd: 0.25 } }],
    ["cached input tokens", { usage: { cachedInputTokens: 4 } }],
    ["reasoning tokens", { usage: { reasoningTokensOut: 4 } }],
    ["changed files", { execution: { changedFiles: ["README.md"] } }],
    ["a patch", { execution: { patch: "diff --git a/x b/x\n" } }],
    ["nonzero diff stats", { execution: { diffStats: { filesChanged: 1, addedLines: 1, deletedLines: 0 } } }],
  ] as const)("fails closed when a provider-free child reports %s", async (_label, extra) => {
    const base = adapter();
    const result = await run({
      ...base,
      execute: async (request) => {
        const executed = await base.execute(request);
        return {
          ...executed,
          usage: { ...executed.usage, ...("usage" in extra ? extra.usage : {}) },
          ...("execution" in extra ? { execution: extra.execution as never } : {}),
        };
      },
    }, { mode: "provider_free_deterministic" });
    expect(result.outcome.state).not.toBe("verified");
    expect(eventText(result)).toContain("PROVIDER_FREE_INVARIANT_VIOLATION");
  }, 120_000);

  it("keeps every budget in the provider-free authority chain at exactly zero", async () => {
    const result = await run(adapter(), { mode: "provider_free_deterministic" });
    expect(result.outcome.state).toBe("verified");
    const numbers = collectNumbers(await readJsonDocuments(lastRunsRoot), [
      "maxUsd", "softLimitUsd", "actualUsd", "estimatedUsd", "preflightEstimateUsd",
      "estimatedAttemptCostUsd", "estimatedVerifierCostUsd", "tokensIn", "tokensOut",
    ]);
    for (const key of ["maxUsd", "actualUsd"]) expect(numbers.get(key)!.length, key).toBeGreaterThan(0);
    for (const [key, values] of numbers) {
      expect(values.filter((value) => value !== 0), `${key} must be exactly zero`).toEqual([]);
    }
  }, 120_000);

  it("keeps normal budget semantics: strict zero-budget execution is still rejected", async () => {
    const result = await run(adapter({ providerId: "codex", model: "gpt-live", adapterId: "live-swarm:codex" }), {
      mode: "strict",
      engine: { engine: "codex", model: "gpt-live" },
      parentUsd: 0,
      childUsd: 0,
    });
    expect(result.outcome.state).not.toBe("verified");
    expect(eventText(result)).toMatch(/budget\.maxUsd must be a finite number greater than zero/u);
  }, 120_000);

  it("records the real execution identity: local deterministic, never an OpenAI execution", async () => {
    const result = await run(adapter(), { mode: "provider_free_deterministic" });
    expect(result.outcome.state).toBe("verified");
    const text = (await readJsonDocuments(lastRunsRoot)).map((document) => JSON.stringify(document)).join("\n");
    expect(text).toMatch(/"providerId":"local-deterministic"/u);
    expect(text).not.toMatch(/"providerId":"openai/u);
    expect(text).not.toMatch(/"providerExecuted":true/u);
    expect(text).toMatch(/"executionProviderId":"local-deterministic"/u);
    expect(text).toMatch(/"providerExecuted":false/u);
  }, 120_000);

  it.each([
    ["modifies a tracked file", "README.md", async (cwd: string) => { await appendFile(join(cwd, "README.md"), "hidden tracked edit\n", "utf8"); }],
    ["creates an untracked file", "hidden-untracked.txt", async (cwd: string) => { await writeFile(join(cwd, "hidden-untracked.txt"), "hidden\n", "utf8"); }],
  ] as const)("fails closed when a non-mutating-declared child secretly %s and reports nothing", async (_label, file, mutate) => {
    const base = adapter();
    const result = await run({
      ...base,
      execute: async (request) => {
        await mutate(request.context.repoRoot ?? process.cwd());
        return base.execute(request);
      },
    }, { mode: "provider_free_deterministic" });
    expect(result.outcome.state).not.toBe("verified");
    // The host's own observation caught it (not some unrelated failure), and named the file.
    const evidence = [eventText(result), ...(await readJsonDocuments(lastRunsRoot)).map((document) => JSON.stringify(document))].join("\n");
    expect(evidence).toContain(`Read-only execution changed a file: ${file}`);
  }, 120_000);


  it("rejects an unknown binding mode", async () => {
    await expect(run(adapter(), { mode: "anything" as never })).rejects.toThrow(/LIVE_ENGINE_PROVIDER_MISMATCH/u);
  }, 120_000);
});
