// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSwarmLivePlan, type SwarmLivePlan } from "@martin/contracts";
import { createSwarmLiveStore } from "../../core/src/swarm/live-store.js";
import { markCodexAutonomyResolutionVerifiedByLaunchProbe } from "../../adapters/src/codex-capabilities.js";

import {
  executeSwarmCancelCommand,
  executeSwarmInspectCommand,
  executeSwarmPlanCommand,
  executeSwarmRunCommand,
  executeSwarmStatusCommand,
  type SwarmCommandDependencies,
} from "../src/swarm-command-private.js";
import { createExplicitSwarmAdapterFactory } from "../src/swarm-engine.js";
import { executeCli, parseCliArguments, renderCliHelp } from "../src/index.js";
import { CliCommandError } from "../src/ux.js";
import { recordCliWorkflowStep } from "../src/swarm-workflow-state.js";

const scratch: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("default CLI swarm surface", () => {
  it("advertises the deterministic demo and the complete governed live command set", () => {
    const help = renderCliHelp();

    expect(help).toContain("martin-loop demo --swarm");
    for (const command of ["swarm plan", "swarm run", "swarm status", "swarm inspect", "swarm cancel", "swarm dossier", "swarm verify", "swarm share"]) {
      expect(help).toContain(command);
    }
  });

  it("dispatches live operational commands through the default CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-swarm-live-cli-"));
    scratch.push(root);

    const result = await executeCli(["swarm", "status", "--latest", "--runs-dir", root, "--json"]);

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ category: "not_found" });
  });
});

describe("swarm plan", () => {
  it("persists a stable inspectable plan and reports graph, scope, verifier, engine, and budget before spend", async () => {
    const fixture = await createPlanFixture();
    await recordPrerequisites(fixture);
    const launch = vi.fn();

    const first = await executeSwarmPlanCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "json",
      dependencies(fixture.plan.baselineCommit, launch),
    );
    const second = await executeSwarmPlanCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "json",
      dependencies(fixture.plan.baselineCommit, launch),
    );

    expect(first.exitCode).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(launch).not.toHaveBeenCalled();
    const payload = JSON.parse(first.stdout) as Record<string, any>;
    expect(payload).toMatchObject({
      command: "swarm plan",
      planHash: fixture.plan.planHash,
      baselineCommit: fixture.plan.baselineCommit,
      engine: { engine: "codex", model: "gpt-test" },
      budget: { capUsd: 4, reservedUsd: 2, maxConcurrency: 1, childMaxIterations: 2 },
      verifier: ["npm test"],
      scope: { allowedPaths: ["src/**"], deniedPaths: [".git/**"] },
      tasks: [{ taskId: "task-a", dependsOn: [], assignedAgentId: "agent-a" }],
    });
    const persisted = JSON.parse(await readFile(payload.planPath, "utf8")) as SwarmLivePlan;
    expect(persisted).toEqual(fixture.plan);

    const human = await executeSwarmPlanCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "human",
      dependencies(fixture.plan.baselineCommit, launch),
    );
    expect(human.stdout).toContain("Objective: Implement task A");
    expect(human.stdout).toContain("task-a <- none -> agent-a");
    expect(human.stdout).toContain("Allowed scope: src/**");
    expect(human.stdout).toContain("Denied scope: .git/**");
    expect(human.stdout).toContain("Verifier: npm test");
    expect(human.stdout).toContain("2,000 tokens reserved of 4,000");
  });

  it("rejects traversal IDs and pre-created approval symlink escapes before writing", async () => {
    const traversal = await createPlanFixture({ swarmId: "../../escape" });
    await recordPrerequisites(traversal);
    await expect(executeSwarmPlanCommand(
      { file: traversal.file, cwd: traversal.cwd, runsDir: traversal.runsRoot },
      "human",
      dependencies(traversal.plan.baselineCommit),
    )).rejects.toThrow(/filename-safe|identifier/iu);

    const fixture = await createPlanFixture();
    await recordPrerequisites(fixture);
    const approvalRoot = join(fixture.runsRoot, "_martin", "swarm-plans");
    const outside = join(fixture.root, "outside-approval");
    await mkdir(approvalRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(approvalRoot, fixture.plan.swarmId), process.platform === "win32" ? "junction" : "dir");
    await expect(executeSwarmPlanCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "human",
      dependencies(fixture.plan.baselineCommit),
    )).rejects.toThrow(/escape|contained|symlink/iu);
    await expect(access(join(outside, `${fixture.plan.planHash}.json`))).rejects.toThrow();
  });

  it.each([
    ["doctor"],
    ["estimate"],
    ["preflight"],
  ] as const)("fails closed when %s readiness is missing", async (missing) => {
    const fixture = await createPlanFixture();
    await recordPrerequisites(fixture, missing);

    await expect(executeSwarmPlanCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "human",
      dependencies(fixture.plan.baselineCommit),
    )).rejects.toThrow(new RegExp(missing, "iu"));
  });

  it("rejects a changed Git baseline before persisting readiness", async () => {
    const fixture = await createPlanFixture();
    await recordPrerequisites(fixture);

    await expect(executeSwarmPlanCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "human",
      dependencies("b".repeat(40)),
    )).rejects.toThrow(/baseline/iu);
  });

  it("fails closed on plan or worktree TOCTOU before persistence or runtime construction", async () => {
    const fixture = await createPlanFixture();
    await recordPrerequisites(fixture);
    const launch = vi.fn();
    const baselineReads = [fixture.plan.baselineCommit, "b".repeat(40)];
    const cleanReads = [true, true];
    const deps: SwarmCommandDependencies = {
      readBaselineCommit: vi.fn(async () => baselineReads.shift() ?? fixture.plan.baselineCommit),
      readWorktreeClean: vi.fn(async () => cleanReads.shift() ?? true),
      runLiveSwarm: launch as SwarmCommandDependencies["runLiveSwarm"],
      resolveCodexLaunch: vi.fn(() => testCodexLaunchBinding()),
    };

    await expect(executeSwarmPlanCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "human",
      deps,
    )).rejects.toThrow(/baseline changed/iu);
    expect(launch).not.toHaveBeenCalled();

    const dirtyDeps = dependencies(fixture.plan.baselineCommit, launch);
    vi.mocked(dirtyDeps.readWorktreeClean)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await expect(executeSwarmPlanCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "human",
      dirtyDeps,
    )).rejects.toThrow(/became dirty/iu);
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects secret-bearing or schema-expanded manifests before persistence", async () => {
    const fixture = await createPlanFixture();
    const secret = createSwarmLivePlan({
      ...fixture.plan,
      parentContract: {
        ...fixture.plan.parentContract,
        objective: "Use authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      },
    });
    await writeFile(fixture.file, JSON.stringify(secret, null, 2), "utf8");
    await expect(executeSwarmPlanCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "human",
      dependencies(secret.baselineCommit),
    )).rejects.toThrow(/secret/iu);

    await writeFile(fixture.file, JSON.stringify({ ...fixture.plan, fallbackEngine: "claude" }, null, 2), "utf8");
    await expect(executeSwarmPlanCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "human",
      dependencies(fixture.plan.baselineCommit),
    )).rejects.toThrow(/unknown swarm plan field/iu);
  });

  it.each([
    "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    "AKIAABCDEFGHIJKLMNOP",
  ])("uses the Core secret leash and never echoes secret material: %s", async (secret) => {
    const fixture = await createPlanFixture();
    const plan = createSwarmLivePlan({
      ...fixture.plan,
      parentContract: { ...fixture.plan.parentContract, objective: `Do work with ${secret}` },
    });
    await writeFile(fixture.file, JSON.stringify(plan, null, 2), "utf8");
    try {
      await executeSwarmPlanCommand(
        { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
        "human",
        dependencies(plan.baselineCommit),
      );
      throw new Error("expected secret rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CliCommandError);
      expect(String((error as Error).message)).toMatch(/secret/iu);
      expect(String((error as Error).message)).not.toContain(secret);
    }
  });

  it.each(["auto", "proof", "stub", "fallback", "simulation"])(
    "rejects the non-live engine mode %s without launching an adapter",
    async (engine) => {
      const fixture = await createPlanFixture({ engine });
      const launch = vi.fn();
      await expect(executeSwarmPlanCommand(
        { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
        "human",
        dependencies(fixture.plan.baselineCommit, launch),
      )).rejects.toThrow(/concrete live engine/iu);
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it.each(["auto", "proof", "stub", "fallback", "simulation"])(
    "rejects the non-concrete model sentinel %s",
    async (model) => {
      const fixture = await createPlanFixture({ model });
      await expect(executeSwarmPlanCommand(
        { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
        "human",
        dependencies(fixture.plan.baselineCommit),
      )).rejects.toThrow(/concrete model/iu);
    },
  );

  it("requires non-empty tasks/agents and exact task-to-agent contract coverage", async () => {
    const fixture = await createPlanFixture();
    for (const plan of [
      createSwarmLivePlan({ ...fixture.plan, tasks: [], agents: [] }),
      createSwarmLivePlan({
        ...fixture.plan,
        agents: fixture.plan.agents.map((agent) => ({
          ...agent,
          contract: { ...agent.contract, taskIds: [] },
        })),
      }),
    ]) {
      await writeFile(fixture.file, JSON.stringify(plan, null, 2), "utf8");
      await expect(executeSwarmPlanCommand(
        { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
        "human",
        dependencies(plan.baselineCommit),
      )).rejects.toThrow(/task|agent|assignment|coverage/iu);
    }
  });
});

describe("swarm parser and live run", () => {
  it("routes live plan/run through strict parsing and help aliases", async () => {
    expect(parseCliArguments(["swarm", "plan", "--file", "plan.json", "--cwd", "."])).toEqual({
      command: "swarm_plan", request: { file: "plan.json", cwd: "." },
    });
    expect(parseCliArguments(["swarm", "run", "--file", "plan.json", "--runs-dir", "runs"])).toEqual({
      command: "swarm_run", request: { file: "plan.json", runsDir: "runs" },
    });
    expect(() => parseCliArguments(["swarm", "run"])).toThrow(/requires --file/iu);
    expect(() => parseCliArguments(["swarm", "run", "--file", "a", "--file", "b"])).toThrow(/duplicate/iu);
    expect(() => parseCliArguments(["swarm", "run", "--file", "a", "extra"])).toThrow(/unsupported/iu);
    const help = await executeCli(["swarm", "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("swarm plan");
    expect(help.stdout).toContain("swarm run");
    expect(parseCliArguments(["swarm", "plan", "--help"])).toEqual({ command: "help" });
    expect(parseCliArguments(["swarm", "run", "-h"])).toEqual({ command: "help" });
    const nonsenseHelp = await executeCli(["swarm", "nonsense", "--help", "--json"]);
    expect(nonsenseHelp.exitCode).toBe(2);
    expect(JSON.parse(nonsenseHelp.stdout)).toMatchObject({ category: "invalid_input" });
  });

  it("resolves one engine/model once, creates a fresh adapter per isolated cwd, and renders only the parent outcome", async () => {
    const fixture = await createPlanFixture();
    await recordPrerequisites(fixture);
    const seenInputs: RunProductionInput[] = [];
    const deps = dependencies(fixture.plan.baselineCommit);
    deps.runLiveSwarm = vi.fn(async (input) => {
      seenInputs.push(input as RunProductionInput);
      const first = input.adapterFactory(adapterInput("one", join(fixture.root, "worktree-one"), fixture.plan));
      const second = input.adapterFactory(adapterInput("two", join(fixture.root, "worktree-two"), fixture.plan));
      const firstAdapter = "adapter" in first ? first.adapter : first;
      const secondAdapter = "adapter" in second ? second.adapter : second;
      expect(firstAdapter).not.toBe(secondAdapter);
      expect(firstAdapter.metadata?.model).toBe("gpt-test");
      expect(secondAdapter.metadata?.model).toBe("gpt-test");
      return {
        record: { swarmId: fixture.plan.swarmId } as any,
        outcome: { state: "needs_review" as const, reason: "parent verifier did not pass" },
        candidateIds: [],
      };
    });

    await executeSwarmPlanCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "json",
      deps,
    );
    const sigintListeners = process.listenerCount("SIGINT");
    const sigtermListeners = process.listenerCount("SIGTERM");
    const result = await executeSwarmRunCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "json",
      deps,
    );

    expect(seenInputs).toHaveLength(1);
    expect(seenInputs[0]?.storeRoot).toBe(fixture.runsRoot);
    expect(seenInputs[0]?.ownedRoot).toBe(join(fixture.runsRoot, "_swarms", fixture.plan.swarmId, "worktrees"));
    expect(seenInputs[0]?.workspaceIsolationMode).toBe(
      process.platform === "win32" ? "independent_clone" : "worktree",
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("SWARM_VERIFIED");
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "swarm run",
      swarmId: fixture.plan.swarmId,
      planHash: fixture.plan.planHash,
      outcome: { state: "needs_review" },
    });
  });

  it("normalizes a subdirectory invocation to the canonical repository root", async () => {
    const fixture = await createPlanFixture();
    const nested = join(fixture.cwd, "nested");
    await mkdir(nested, { recursive: true });
    const nestedFile = join(nested, "swarm-plan.json");
    await writeFile(nestedFile, JSON.stringify(fixture.plan, null, 2), "utf8");
    await recordPrerequisites(fixture);
    const deps = dependencies(fixture.plan.baselineCommit);
    deps.readRepositoryRoot = vi.fn(async () => fixture.cwd);

    await executeSwarmPlanCommand(
      { file: nestedFile, cwd: nested, runsDir: fixture.runsRoot },
      "human",
      deps,
    );

    expect(deps.readRepositoryRoot).toHaveBeenCalledWith(nested);
    expect(deps.readBaselineCommit).toHaveBeenCalledWith(fixture.cwd);
  });

  it("rejects an unapproved plan hash before constructing runtime resources", async () => {
    const fixture = await createPlanFixture();
    await recordPrerequisites(fixture);
    const deps = dependencies(fixture.plan.baselineCommit);
    await executeSwarmPlanCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "human",
      deps,
    );
    const changed = createSwarmLivePlan({
      ...fixture.plan,
      planId: "plan-changed",
      childMaxIterations: 1,
    });
    await writeFile(fixture.file, JSON.stringify(changed, null, 2), "utf8");

    await expect(executeSwarmRunCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "human",
      deps,
    )).rejects.toThrow(/exact receipts|swarm-plan/iu);
    expect(deps.runLiveSwarm).not.toHaveBeenCalled();
  });

  it("uses canonical plan approval bytes rather than caller JSON key order", async () => {
    const fixture = await createPlanFixture();
    await recordPrerequisites(fixture);
    const deps = dependencies(fixture.plan.baselineCommit);
    await executeSwarmPlanCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "human",
      deps,
    );
    const reordered = Object.fromEntries(Object.entries(fixture.plan).reverse());
    await writeFile(fixture.file, JSON.stringify(reordered, null, 4), "utf8");
    vi.mocked(deps.runLiveSwarm).mockResolvedValue({
      record: { swarmId: fixture.plan.swarmId } as any,
      outcome: { state: "needs_review", reason: "fixture" },
      candidateIds: [],
    });

    await expect(executeSwarmRunCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "json",
      deps,
    )).resolves.toMatchObject({ exitCode: 7 });
  });

  it("does not accept a structurally forged parent VERIFIED result from an injected seam", async () => {
    const fixture = await createPlanFixture();
    await recordPrerequisites(fixture);
    const deps = dependencies(fixture.plan.baselineCommit);
    await executeSwarmPlanCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "human",
      deps,
    );
    vi.mocked(deps.runLiveSwarm).mockResolvedValue({
      record: {
        swarmId: fixture.plan.swarmId,
        events: [{ type: "SWARM_VERIFIED", swarmId: fixture.plan.swarmId }],
        outcome: { state: "verified", reason: "forged" },
      } as any,
      outcome: { state: "verified", reason: "forged" },
      candidateIds: [],
      parent: {
        outcome: { state: "verified", reason: "forged" },
        disposition: "ready",
        blockingInvariants: [],
      } as any,
    });

    const result = await executeSwarmRunCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "json",
      deps,
    );
    expect(result.exitCode).toBe(7);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: { state: "needs_review" } });
  });

  it.each([
    ["CANONICAL_ROOT_NOT_TOP_LEVEL", "environment"],
    ["PLAN_CONFLICT", "policy_blocked"],
    ["MALFORMED_JSON", "store_unreadable"],
    ["MALFORMED_EVENT_LOG", "store_unreadable"],
    ["EVENT_CLAIM_GAP", "store_unreadable"],
    ["MISSING_EVENT_CLAIM", "store_unreadable"],
    ["INVALID_PLAN", "invalid_input"],
  ] as const)("maps Core composition failure %s to %s", async (code, category) => {
    const fixture = await createPlanFixture();
    await recordPrerequisites(fixture);
    const deps = dependencies(fixture.plan.baselineCommit);
    await executeSwarmPlanCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "human",
      deps,
    );
    vi.mocked(deps.runLiveSwarm).mockRejectedValue(Object.assign(
      new Error(`Core composition failed: ${code}`),
      { code },
    ));
    await expect(executeSwarmRunCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "human",
      deps,
    )).rejects.toMatchObject({ category });
  });

  it("does not mask unexpected Core defects as a governed failure", async () => {
    const fixture = await createPlanFixture();
    await recordPrerequisites(fixture);
    const deps = dependencies(fixture.plan.baselineCommit);
    await executeSwarmPlanCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "human",
      deps,
    );
    const defect = new Error("unexpected defect");
    vi.mocked(deps.runLiveSwarm).mockRejectedValue(defect);
    await expect(executeSwarmRunCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "human",
      deps,
    )).rejects.toBe(defect);
  });

  it("redacts secrets from unexpected runtime defects before they can reach CLI output", async () => {
    const fixture = await createPlanFixture();
    await recordPrerequisites(fixture);
    const deps = dependencies(fixture.plan.baselineCommit);
    await executeSwarmPlanCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "human",
      deps,
    );
    const secret = "sk-proj-cli-secret-123456789";
    vi.mocked(deps.runLiveSwarm).mockRejectedValue(new Error(`provider exploded with ${secret}`));

    const error = await executeSwarmRunCommand(
      { file: fixture.file, cwd: fixture.cwd, runsDir: fixture.runsRoot },
      "human",
      deps,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).toContain("[REDACTED");
  });

  it("rejects mismatched factory engine profiles without auto-selection or fallback", async () => {
    const factory = createExplicitSwarmAdapterFactory(
      { engine: "codex", model: "gpt-test" },
      undefined,
      testCodexLaunchBinding(),
    );
    const fixture = await createPlanFixture();
    expect(() => factory({
      ...adapterInput("one", join(fixture.root, "worktree"), fixture.plan),
      engine: { engine: "claude", model: "claude-test" },
    })).toThrow(/engine binding/iu);
  });

  it.each([
    ["claude", { readOnly: true }],
    ["codex", { sandbox: "read-only" }],
    ["gemini", { readOnly: true }],
    ["openai", { model: "openai-test" }],
  ] as const)("binds read-only swarm work to the %s provider no-edit mode", async (engine, expected) => {
    const fixture = await createPlanFixture({ engine, model: `${engine}-test` });
    const factories = {
      claude: vi.fn(() => ({} as any)),
      codex: vi.fn(() => ({} as any)),
      gemini: vi.fn(() => ({} as any)),
      openai: vi.fn(() => ({} as any)),
    };
    const factory = createExplicitSwarmAdapterFactory(
      fixture.plan.engine,
      factories,
      engine === "codex" ? testCodexLaunchBinding() : undefined,
    );

    factory(adapterInput(engine, join(fixture.root, "worktree"), fixture.plan));

    expect(factories[engine]).toHaveBeenCalledWith(expect.objectContaining(expected));
  });

  it.each(["claude", "codex", "gemini", "openai"] as const)(
    "binds writable swarm work through the %s adapter without changing the Core contract",
    async (engine) => {
      const fixture = await createPlanFixture({ engine, model: `${engine}-test` });
      const factories = {
        claude: vi.fn(() => ({} as any)),
        codex: vi.fn(() => ({} as any)),
        gemini: vi.fn(() => ({} as any)),
        openai: vi.fn(() => ({} as any)),
      };
      const factory = createExplicitSwarmAdapterFactory(
        fixture.plan.engine,
        factories,
        engine === "codex" ? testCodexLaunchBinding() : undefined,
      );
      const input = adapterInput(`${engine}-write`, join(fixture.root, `${engine}-workspace`), fixture.plan);
      input.task = { ...input.task, mutationMode: "write", writeScope: ["src/**"] };

      factory(input);

      const expected = engine === "claude"
        ? { readOnly: false }
        : engine === "codex"
          ? { sandbox: "workspace-write" }
          : engine === "gemini"
            ? { readOnly: false }
            : { model: "openai-test" };
      expect(factories[engine]).toHaveBeenCalledWith(expect.objectContaining(expected));
    },
  );

  it("creates the existing OpenAI-compatible adapter under the generic live engine identity", async () => {
    const fixture = await createPlanFixture({ engine: "openai", model: "llama3.3" });
    const factory = createExplicitSwarmAdapterFactory(fixture.plan.engine);
    const created = factory(adapterInput("openai-live", join(fixture.root, "openai-workspace"), fixture.plan));
    const adapter = "adapter" in created ? created.adapter : created;

    expect(adapter.metadata.providerId).toBe("openai");
    expect(adapter.metadata.model).toBe("llama3.3");
    expect(adapter.metadata.transport).toBe("http");
  });

  it("binds a negotiated Codex capability profile and autonomy resolution into each live child", async () => {
    const fixture = await createPlanFixture();
    const capabilityProfile = {
      binaryPath: "C:\\tools\\codex.exe",
      supportsExec: true,
      probeSucceeded: true,
      promptTransport: "stdin-dash" as const,
    };
    const autonomyResolution = {
      binaryPath: capabilityProfile.binaryPath,
      intent: "governed-autonomous" as const,
      strategy: "sandbox+approval" as const,
      sandboxValue: "workspace-write",
      approvalValue: "never",
    };
    const factories = {
      claude: vi.fn(() => ({} as any)),
      codex: vi.fn(() => ({} as any)),
      gemini: vi.fn(() => ({} as any)),
      openai: vi.fn(() => ({} as any)),
    };
    const createFactory = createExplicitSwarmAdapterFactory as unknown as (
      selected: SwarmLivePlan["engine"],
      injectedFactories: typeof factories,
      codexLaunch: { command: string; capabilityProfile: typeof capabilityProfile; autonomyResolution: typeof autonomyResolution },
    ) => ReturnType<typeof createExplicitSwarmAdapterFactory>;
    const factory = createFactory(fixture.plan.engine, factories, {
      command: capabilityProfile.binaryPath,
      capabilityProfile,
      autonomyResolution,
    });

    factory(adapterInput("codex-live", join(fixture.root, "worktree"), fixture.plan));

    expect(factories.codex).toHaveBeenCalledWith(expect.objectContaining({
      command: capabilityProfile.binaryPath,
      capabilityProfile: expect.objectContaining({
        binaryPath: capabilityProfile.binaryPath,
        supportsExec: true,
        probeSucceeded: true,
      }),
      autonomyResolution: expect.objectContaining({
        binaryPath: capabilityProfile.binaryPath,
        intent: "governed-autonomous",
      }),
    }));
  });

  it("probes Codex against the actual child worktree before creating a writable adapter", async () => {
    const fixture = await createPlanFixture();
    const childPath = join(fixture.root, "child-worktree");
    const factories = {
      claude: vi.fn(() => ({} as any)),
      codex: vi.fn(() => ({} as any)),
      gemini: vi.fn(() => ({} as any)),
      openai: vi.fn(() => ({} as any)),
    };
    const resolveLaunch = vi.fn(() => testCodexLaunchBinding());
    const factory = createExplicitSwarmAdapterFactory(
      fixture.plan.engine,
      factories,
      resolveLaunch,
    );
    const input = adapterInput("codex-write", childPath, fixture.plan);
    input.task = {
      ...input.task,
      mutationMode: "write",
      writeScope: ["src/**"],
    };

    factory(input);

    expect(resolveLaunch).toHaveBeenCalledTimes(1);
    expect(resolveLaunch).toHaveBeenCalledWith({
      workingDirectory: childPath,
      model: fixture.plan.engine.model,
    });
    expect(factories.codex).toHaveBeenCalledWith(expect.objectContaining({
      workingDirectory: childPath,
      sandbox: "workspace-write",
    }));
  });

  it("fails closed when a Codex adapter factory lacks the negotiated launch binding", () => {
    expect(() => createExplicitSwarmAdapterFactory({ engine: "codex", model: "gpt-6.1-sol" }))
      .toThrow(/launch binding is required/iu);
  });

  it.each(["auto", "proof", "stub", "fallback", "simulation", "default"])(
    "rejects model sentinel %s at the adapter-factory boundary",
    (model) => {
      expect(() => createExplicitSwarmAdapterFactory({ engine: "codex", model })).toThrow(/concrete model/iu);
    },
  );
});

describe("swarm status and inspect", () => {
  it("parses strict selectors and watch without accepting duplicates or extra arguments", () => {
    expect(parseCliArguments(["swarm", "status", "--swarm-id", "swarm-a", "--watch", "--runs-dir", "runs"]))
      .toEqual({ command: "swarm_status", request: { swarmId: "swarm-a", watch: true, runsDir: "runs" } });
    expect(parseCliArguments(["swarm", "inspect", "--latest"])).toEqual({
      command: "swarm_inspect", request: { latest: true },
    });
    expect(() => parseCliArguments(["swarm", "status"])).toThrow(/requires exactly one selector/iu);
    expect(() => parseCliArguments(["swarm", "inspect", "--latest", "--swarm-id", "swarm-a"])).toThrow(/exactly one|selector/iu);
    expect(() => parseCliArguments(["swarm", "status", "--latest", "--watch", "--watch"])).toThrow(/duplicate/iu);
    expect(() => parseCliArguments(["swarm", "inspect", "--latest", "extra"])).toThrow(/unsupported/iu);
  });

  it("renders deterministic durable JSON and full inspection history after restart", async () => {
    const fixture = await createPlanFixture();
    const store = await createSwarmLiveStore({ rootDir: fixture.runsRoot, plan: fixture.plan });
    await store.append({
      idempotencyKey: "task-a:ready", type: "TASK_READY",
      timestamp: "2026-10-03T12:01:00.000Z", taskId: "task-a", payload: { source: "test" },
    }, { expectedRevision: 0 });
    await store.append({
      idempotencyKey: "task-a:assigned", type: "TASK_ASSIGNED",
      timestamp: "2026-10-03T12:02:00.000Z", taskId: "task-a", agentId: "agent-a", payload: {},
    }, { expectedRevision: 1 });

    const request = { swarmId: fixture.plan.swarmId, runsDir: fixture.runsRoot };
    const first = await executeSwarmStatusCommand(request, "json");
    const second = await executeSwarmStatusCommand(request, "json");
    expect(first).toEqual(second);
    expect(JSON.parse(first.stdout)).toMatchObject({
      command: "swarm status", swarmId: fixture.plan.swarmId, revision: 2,
      state: "running", lastEventType: "TASK_ASSIGNED",
    });

    const inspected = await executeSwarmInspectCommand({ latest: true, runsDir: fixture.runsRoot }, "json");
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      command: "swarm inspect", swarmId: fixture.plan.swarmId,
      events: [
        { sequence: 1, type: "TASK_READY" },
        { sequence: 2, type: "TASK_ASSIGNED" },
      ],
    });
  });

  it("terminates --watch as a deterministic one-shot for non-TTY output", async () => {
    const fixture = await createPlanFixture();
    await createSwarmLiveStore({ rootDir: fixture.runsRoot, plan: fixture.plan });
    const result = await executeSwarmStatusCommand(
      { latest: true, watch: true, runsDir: fixture.runsRoot },
      "json",
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ command: "swarm status", watching: false, revision: 0 });
  });

  it("renders every durable wakeup during an interactive watch", async () => {
    const fixture = await createPlanFixture();
    const store = await createSwarmLiveStore({ rootDir: fixture.runsRoot, plan: fixture.plan });
    const frames: string[] = [];
    const watching = executeSwarmStatusCommand(
      { swarmId: fixture.plan.swarmId, watch: true, runsDir: fixture.runsRoot },
      "human",
      { interactive: true, writeFrame: (frame) => frames.push(frame) },
    );
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    await store.append({
      idempotencyKey: "parent:stopped", type: "SWARM_STOPPED",
      timestamp: "2026-10-03T12:04:00.000Z", payload: { reason: "done" },
    }, { expectedRevision: 0 });
    const result = await watching;

    expect(frames).toHaveLength(2);
    expect(frames[0]).toContain("Revision: 0");
    expect(frames[1]).toContain("Revision: 1");
    expect(frames[1]).toContain("STOPPED");
    expect(result.stdout).toBe("");
  });

  it("pins --latest watch to the initially selected swarm identity", async () => {
    const source = await readFile(new URL("../src/swarm-command-private.ts", import.meta.url), "utf8");
    expect(source).toContain("pinnedSelector = { runsRoot, swarmId: state.snapshot.swarmId }");
    expect(source).toContain("...pinnedSelector, afterRevision: state.snapshot.revision");
  });

  it("keeps direct private evidence readers fail-closed for malformed operational stores", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-swarm-status-errors-"));
    scratch.push(root);
    await expect(executeSwarmStatusCommand({ latest: true, runsDir: root }, "json"))
      .rejects.toMatchObject({ category: "not_found" });

    const directory = join(root, "_swarms", "swarm-bad");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "plan.json"), "{broken", "utf8");
    await expect(executeSwarmInspectCommand({ swarmId: "swarm-bad", runsDir: root }, "json"))
      .rejects.toMatchObject({ category: "store_unreadable" });

    await expect(executeSwarmStatusCommand({ swarmId: "../../escape", runsDir: root }, "json"))
      .rejects.toMatchObject({ category: "policy_blocked" });
  });

});

describe("swarm cancel", () => {
  it("parses a strict selector and reason without changing legacy cancel parsing", () => {
    expect(parseCliArguments(["swarm", "cancel", "--swarm-id", "swarm-a", "--reason", "operator stop"]))
      .toEqual({ command: "swarm_cancel", request: { swarmId: "swarm-a", reason: "operator stop" } });
    expect(parseCliArguments(["cancel", "loop-a"])).toMatchObject({ command: "cancel", runId: "loop-a" });
    expect(() => parseCliArguments(["swarm", "cancel", "--latest", "--latest"])).toThrow(/duplicate/iu);
    expect(() => parseCliArguments(["swarm", "cancel", "--latest", "extra"])).toThrow(/unsupported/iu);
  });

  it("is idempotent, preserves the first request, and returns one JSON value", async () => {
    const fixture = await createPlanFixture();
    const store = await createSwarmLiveStore({ rootDir: fixture.runsRoot, plan: fixture.plan });
    const first = await executeSwarmCancelCommand(
      { swarmId: fixture.plan.swarmId, reason: "operator stop", runsDir: fixture.runsRoot },
      "json",
    );
    const bytes = await readFile(store.paths().events, "utf8");
    const second = await executeSwarmCancelCommand(
      { latest: true, reason: "must not overwrite", runsDir: fixture.runsRoot },
      "json",
    );

    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ command: "swarm cancel", outcome: "created" });
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ command: "swarm cancel", outcome: "already_requested" });
    expect(await readFile(store.paths().events, "utf8")).toBe(bytes);
  });
});

type RunProductionInput = Parameters<SwarmCommandDependencies["runLiveSwarm"]>[0];

function adapterInput(id: string, path: string, plan: SwarmLivePlan) {
  return {
    engine: plan.engine,
    task: plan.tasks[0]!,
    agent: plan.agents[0]!,
    childRunId: `child-${id}`,
    workspace: {
      path,
      record: { workspaceId: `workspace-${id}` },
    } as any,
    budget: plan.agents[0]!.contract.budget,
  };
}

async function createPlanFixture(options: { engine?: string; model?: string; swarmId?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "martin-swarm-cli-"));
  scratch.push(root);
  const cwd = join(root, "repo");
  const runsRoot = join(root, "runs");
  const plan = createSwarmLivePlan({
    planId: "plan-a",
    swarmId: options.swarmId ?? "swarm-a",
    workspaceId: "workspace-a",
    projectId: "project-a",
    baselineCommit: "a".repeat(40),
    parentContract: {
      policyVersion: "swarm-policy-v1",
      objective: "Implement task A",
      definitionOfDone: ["Task A passes verification"],
      budget: { maxUsd: 4, softLimitUsd: 3, maxIterations: 4, maxTokens: 4_000 },
      maxWallClockMs: 120_000,
      maxConcurrency: 1,
      scope: { allowedPaths: ["src/**"], deniedPaths: [".git/**"] },
      permissions: { networkDomains: [], commands: ["npm test"] },
      integrationStrategy: "parent_fan_in",
      globalVerifierStack: [{ command: "npm test", type: "test_full" }],
      stopPolicy: { budgetExhausted: "stop", blockingFailure: "needs_review", verifierFailure: "stop" },
      recoveryPolicy: { maxReassignmentsPerTask: 0, dependencyWaiversAllowed: false },
      approvalPolicy: {},
      orchestrationStrategy: "hierarchical_dag",
    },
    tasks: [{
      taskId: "task-a",
      title: "Task A",
      objective: "Implement task A",
      required: true,
      dependsOn: [],
      assignedAgentId: "agent-a",
      status: "queued",
      mutationMode: "read_only",
      writeScope: [],
    }],
    agents: [{
      agentId: "agent-a",
      role: "worker",
      status: "queued",
      contract: {
        agentId: "agent-a",
        taskIds: ["task-a"],
        scope: { allowedPaths: ["src/**"], deniedPaths: [".git/**"] },
        budget: { maxUsd: 2, softLimitUsd: 1, maxIterations: 2, maxTokens: 2_000 },
        maxWallClockMs: 60_000,
        permissions: { networkDomains: [], commands: ["npm test"] },
        approvalPolicy: {},
        verifierAuthority: "child_only",
      },
    }],
    engine: { engine: (options.engine ?? "codex") as SwarmLivePlan["engine"]["engine"], model: options.model ?? "gpt-test" },
    childMaxIterations: 2,
    createdAt: "2026-10-03T12:00:00.000Z",
  });
  await mkdir(cwd, { recursive: true });
  const file = join(cwd, "swarm-plan.json");
  await writeFile(file, JSON.stringify(plan, null, 2), "utf8");
  return { root, cwd, runsRoot, file, plan };
}

async function recordPrerequisites(
  fixture: Awaited<ReturnType<typeof createPlanFixture>>,
  missing?: "doctor" | "estimate" | "preflight",
): Promise<void> {
  const receiptScope = {
    invocationRoot: fixture.cwd,
    workingDirectory: fixture.cwd,
    repoRoot: fixture.cwd,
    runsRoot: fixture.runsRoot,
  };
  if (missing !== "doctor") {
    await recordCliWorkflowStep({
      runsRoot: fixture.runsRoot,
      step: "doctor",
      workingDirectory: fixture.cwd,
      engine: fixture.plan.engine.engine,
      receiptScope,
    });
  }
  if (missing !== "estimate") {
    await recordCliWorkflowStep({
      runsRoot: fixture.runsRoot,
      step: "estimate",
      workingDirectory: fixture.cwd,
      objective: fixture.plan.parentContract.objective,
      receiptScope,
      budget: fixture.plan.parentContract.budget,
    });
  }
  if (missing !== "preflight") {
    await recordCliWorkflowStep({
      runsRoot: fixture.runsRoot,
      step: "preflight",
      workingDirectory: fixture.cwd,
      objective: fixture.plan.parentContract.objective,
      engine: fixture.plan.engine.engine,
      verificationPlan: fixture.plan.parentContract.globalVerifierStack.map((step) => step.command),
      receiptScope,
      allowedPaths: fixture.plan.parentContract.scope.allowedPaths,
      deniedPaths: fixture.plan.parentContract.scope.deniedPaths,
      budget: fixture.plan.parentContract.budget,
    });
  }
}

function dependencies(baselineCommit: string, launch = vi.fn()): SwarmCommandDependencies {
  return {
    readBaselineCommit: vi.fn(async () => baselineCommit),
    readWorktreeClean: vi.fn(async () => true),
    runLiveSwarm: launch as SwarmCommandDependencies["runLiveSwarm"],
    resolveCodexLaunch: vi.fn(() => testCodexLaunchBinding()),
  };
}

function testCodexLaunchBinding() {
  const binaryPath = "C:\\tools\\codex.exe";
  return {
    command: binaryPath,
    capabilityProfile: {
      binaryPath,
      supportsExec: true,
      probeSucceeded: true,
      promptTransport: "stdin-dash" as const,
    },
    autonomyResolution: markCodexAutonomyResolutionVerifiedByLaunchProbe({
      binaryPath,
      intent: "governed-autonomous",
      strategy: "sandbox+approval",
      sandboxValue: "workspace-write",
      approvalValue: "never",
    }),
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout;
}
