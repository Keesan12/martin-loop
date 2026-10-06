import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseCliArguments } from "../src/index.js";

import {
  SWARM_DEMO_AGENTS,
  assertSafeDeterministicSwarmDemoTarget,
  getDeterministicSwarmDemoExitCode,
  renderDeterministicSwarmDemoHuman,
  resolveDeterministicSwarmDemoFixtureDirectory,
  runDeterministicSwarmDemo,
  type DeterministicSwarmDemoResult,
} from "../src/swarm-demo.js";

const temporaryDirectories: string[] = [];

async function createTarget(): Promise<string> {
  const target = await mkdtemp(path.join(tmpdir(), "martin-swarm-demo-"));
  temporaryDirectories.push(target);
  return target;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("deterministic swarm demo graph", () => {
  it("preserves deterministic demo routing beside the new swarm evidence namespace", () => {
    expect(parseCliArguments(["demo", "--swarm", "--scenario", "launch-board"])).toMatchObject({
      command: "demo", swarm: true, scenario: "launch-board",
    });
    expect(parseCliArguments(["swarm", "share", "--latest", "--out-dir", "bundle"]))
      .toMatchObject({ command: "swarm_share", request: { latest: true, outputDir: "bundle" } });
  });

  it("declares exactly the locked 15 roles and hybrid graph edges", async () => {
    expect(SWARM_DEMO_AGENTS.map((agent) => `${agent.number} ${agent.role}`)).toEqual([
      "01 Planner",
      "02 Data",
      "03 API",
      "04 Validation",
      "05 UI",
      "06 State",
      "07 Unit Tests",
      "08 Integration Tests",
      "09 Accessibility",
      "10 Error Handling",
      "11 Docs",
      "12 Scope Reviewer",
      "13 Test Reviewer",
      "14 Integrator",
      "15 Final Verifier",
    ]);

    const targetDirectory = await createTarget();
    const result = await runDeterministicSwarmDemo({ targetDirectory });

    expect(result.orchestrationStrategy).toBe("hybrid");
    expect(result.graphEdges).toEqual(expect.arrayContaining([
      ["agent-01", "agent-06"],
      ["agent-02", "agent-03"],
      ["agent-03", "agent-08"],
      ["agent-05", "agent-09"],
      ["agent-03", "agent-12"],
      ["agent-07", "agent-13"],
      ["agent-08", "agent-13"],
      ["agent-14", "agent-15"],
    ]));
    expect(new Set(result.graphEdges.map((edge) => edge.join("->"))).size).toBe(result.graphEdges.length);
    expect(result.plannedGraphEdges).toContainEqual({
      dependencyTaskId: "task-06",
      dependencyAgentId: "agent-06",
      taskId: "task-14",
      agentId: "agent-14",
    });
    expect(result.executionAttribution).toContainEqual({
      taskId: "task-06",
      plannedAgentId: "agent-06",
      executedByAgentId: "agent-10",
      recovery: "reassigned",
    });
    expect(result.executionGraphEdges).toContainEqual({
      dependencyTaskId: "task-06",
      dependencyAgentId: "agent-10",
      taskId: "task-14",
      agentId: "agent-14",
    });
    expect(result.maxObservedConcurrency).toBeLessThanOrEqual(5);
    expect(new Set(result.events.map((event) => event.agentId).filter(Boolean))).toEqual(
      new Set(SWARM_DEMO_AGENTS.map((agent) => agent.id)),
    );
  });

  it("uses deterministic local workers and never invokes a provider", async () => {
    const targetDirectory = await createTarget();
    const provider = vi.fn(() => {
      throw new Error("provider must not be called by deterministic demo");
    });

    const result = await runDeterministicSwarmDemo({ targetDirectory, provider });

    expect(provider).not.toHaveBeenCalled();
    expect(result.providerMode).toBe("deterministic_local");
    expect(result.providerSpendUsd).toBe(0);
    expect(result.budget).toMatchObject({ settledUsd: 0, reservedUsd: 0 });
  });

  it("runs the integrated fixture verifier after parent-controlled integration", async () => {
    const fixture = resolveDeterministicSwarmDemoFixtureDirectory();
    expect(await readFile(path.join(fixture, "src", "state.js"), "utf8")).not.toContain("error: null");
    const beforeIntegration = spawnSync(process.execPath, ["--test"], {
      cwd: fixture,
      encoding: "utf8",
      windowsHide: true,
    });
    expect(beforeIntegration.status).toBe(1);
    expect(beforeIntegration.stdout).toMatch(/fail 1/iu);

    const targetDirectory = await createTarget();
    const result: DeterministicSwarmDemoResult = await runDeterministicSwarmDemo({ targetDirectory });

    expect(result.globalVerifier).toMatchObject({ launched: true, completed: true, crashed: false, exitCode: 0, passed: true });
    expect(result.integration.provenance.length).toBeGreaterThan(0);
    expect(await readFile(path.join(targetDirectory, "package.json"), "utf8")).toContain('"type": "module"');
    expect(await readFile(path.join(targetDirectory, "src", "api.js"), "utf8")).toContain("createLaunchBoard");
    expect(await readFile(path.join(targetDirectory, "src", "ui.js"), "utf8")).toContain("renderLaunchBoard");
  });

  it("packages a dependency-free multi-file fixture resolvable from source and installed layouts", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const fixture = path.join(repoRoot, "demo", "swarm-launch-board");
    const rootPackage = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as { files?: string[] };
    const fixturePackage = JSON.parse(await readFile(path.join(fixture, "package.json"), "utf8")) as { dependencies?: unknown };
    const sourceFiles = await readdir(path.join(fixture, "src"));

    expect(rootPackage.files).toContain("demo/swarm-launch-board");
    expect(fixturePackage.dependencies).toBeUndefined();
    expect(sourceFiles.sort()).toEqual(["api.js", "data.js", "state.js", "ui.js"]);
    expect(resolveDeterministicSwarmDemoFixtureDirectory()).toBe(fixture);

    const fakeInstallRoot = path.join(tmpdir(), "martin-loop-installed-layout");
    const packedModuleUrl = pathToFileURL(path.join(fakeInstallRoot, "dist", "vendor", "cli", "swarm-demo.js")).href;
    expect(resolveDeterministicSwarmDemoFixtureDirectory(packedModuleUrl)).toBe(
      path.join(fakeInstallRoot, "demo", "swarm-launch-board"),
    );
  });

  it("keeps equivalent JSON evidence stable outside the explicit target directory", async () => {
    const firstTarget = await createTarget();
    const secondTarget = await createTarget();
    const first = await runDeterministicSwarmDemo({ targetDirectory: firstTarget });
    const second = await runDeterministicSwarmDemo({ targetDirectory: secondTarget });
    const normalize = (result: DeterministicSwarmDemoResult) => ({ ...result, targetDirectory: "<target>" });

    expect(first.globalVerifier.command).toBe("node --test");
    expect(normalize(first)).toEqual(normalize(second));
  });

  it("rejects dangerous force targets before filesystem replacement", () => {
    const workingDirectory = path.resolve(process.cwd());
    const fixture = path.join(workingDirectory, "demo", "swarm-launch-board");
    expect(() => assertSafeDeterministicSwarmDemoTarget(workingDirectory, true, { workingDirectory, fixtureDirectory: fixture })).toThrow(/unsafe/iu);
    expect(() => assertSafeDeterministicSwarmDemoTarget(path.dirname(workingDirectory), true, { workingDirectory, fixtureDirectory: fixture })).toThrow(/unsafe/iu);
    expect(() => assertSafeDeterministicSwarmDemoTarget(path.parse(workingDirectory).root, true, { workingDirectory, fixtureDirectory: fixture })).toThrow(/unsafe/iu);
    expect(() => assertSafeDeterministicSwarmDemoTarget(fixture, true, { workingDirectory, fixtureDirectory: fixture })).toThrow(/unsafe/iu);
    expect(() => assertSafeDeterministicSwarmDemoTarget(path.join(fixture, "src"), true, { workingDirectory, fixtureDirectory: fixture })).toThrow(/unsafe/iu);
    expect(() => assertSafeDeterministicSwarmDemoTarget(path.join(workingDirectory, ".git"), true, { workingDirectory, fixtureDirectory: fixture })).toThrow(/unsafe/iu);
    expect(() => assertSafeDeterministicSwarmDemoTarget(path.join(tmpdir(), "safe-swarm-demo"), true, { workingDirectory, fixtureDirectory: fixture })).not.toThrow();
    expect(() => assertSafeDeterministicSwarmDemoTarget(path.join(workingDirectory, ".tmp", "safe-swarm-demo"), true, { workingDirectory, fixtureDirectory: fixture })).not.toThrow();
  });
});

describe("deterministic swarm demo intervention", () => {
  it("rejects Agent 06 before write and admits Agent 10's exact reassignment", async () => {
    const targetDirectory = await createTarget();
    const result = await runDeterministicSwarmDemo({ targetDirectory });

    const eventTypes = result.events.map((event) => event.type);
    const proposed = result.events.find((event) => event.type === "CHILD_PATCH_PROPOSED" && event.agentId === "agent-06");
    const rejectedIndex = result.events.findIndex((event) => event.type === "CHILD_PATCH_REJECTED" && event.agentId === "agent-06");
    const stoppedIndex = result.events.findIndex((event) => event.type === "CHILD_STOPPED" && event.agentId === "agent-06");
    const reassignedIndex = result.events.findIndex((event) => event.type === "TASK_REASSIGNED" && event.agentId === "agent-10");
    const admittedIndex = result.events.findIndex((event) => event.type === "CHILD_PATCH_ADMITTED" && event.agentId === "agent-10" && event.taskId === "task-06");
    const integratedIndex = eventTypes.indexOf("INTEGRATION_COMPLETED");
    const verifiedIndex = eventTypes.indexOf("GLOBAL_VERIFIER_PASSED");
    const finalVerifierReadyIndex = result.events.findIndex((event) => event.type === "TASK_READY" && event.agentId === "agent-15");
    const finalVerifierChildVerifiedIndex = result.events.findIndex((event) => event.type === "CHILD_VERIFIED" && event.agentId === "agent-15");

    expect(proposed?.payload).toMatchObject({ paths: ["private/agent-06-notes.md"] });
    expect([rejectedIndex, stoppedIndex, reassignedIndex, admittedIndex, integratedIndex, verifiedIndex]).toEqual(
      [...[rejectedIndex, stoppedIndex, reassignedIndex, admittedIndex, integratedIndex, verifiedIndex]].sort((a, b) => a - b),
    );
    expect(rejectedIndex).toBeGreaterThan(-1);
    expect(integratedIndex).toBeLessThan(finalVerifierReadyIndex);
    expect(finalVerifierChildVerifiedIndex).toBe(-1);
    expect(result.events[rejectedIndex]?.payload).toMatchObject({ reason: "scope_creep", bytesAdmitted: 0 });
    expect(result.events.filter((event) => event.type === "TASK_REASSIGNED" && event.taskId === "task-06")).toHaveLength(1);
    expect(result.integration.provenance).toContainEqual({ path: "src/state.js", agentId: "agent-10", taskId: "task-06" });
    expect(result.deniedChangesAdmitted).toBe(0);
    expect(result).toMatchObject({ completed: 14, stopped: 1, reassignedTasks: 1 });
    await expect(access(path.join(targetDirectory, "private", "agent-06-notes.md"))).rejects.toThrow();
    expect(await readFile(path.join(targetDirectory, "src", "state.js"), "utf8")).toContain("createLaunchState");
  });

  it.each([
    ["failed", { launched: true, completed: true, crashed: false, exitCode: 1 }, { completed: 13, stopped: 2, needsReview: 0 }],
    ["unknown", { launched: false, completed: false, crashed: false, exitCode: null }, { completed: 13, stopped: 1, needsReview: 1 }],
  ] as const)("blocks the parent outcome when the global verifier is %s", async (_label, verifierResult, counts) => {
    const targetDirectory = await createTarget();
    const result = await runDeterministicSwarmDemo({
      targetDirectory,
      parentVerifier: () => verifierResult,
    });

    expect(result.status).not.toBe("verified");
    expect(result.globalVerifier).toMatchObject(verifierResult);
    expect(result).toMatchObject(counts);
    expect(renderDeterministicSwarmDemoHuman(result)).toContain(`${counts.completed} completed · ${counts.stopped} stopped`);
    if (counts.needsReview > 0) {
      expect(renderDeterministicSwarmDemoHuman(result)).toContain(`${counts.needsReview} needs review`);
    }
    expect(result.events.some((event) => event.type === "SWARM_VERIFIED")).toBe(false);
    expect(result.parentOutcome.state).not.toBe("verified");
    expect(getDeterministicSwarmDemoExitCode(result)).toBe(1);
    expect(renderDeterministicSwarmDemoHuman(result)).not.toContain("SWARM VERIFIED");
  });

  it("allows only the parent evaluator to append SWARM_VERIFIED after actual integrated verification", async () => {
    const targetDirectory = await createTarget();
    const result = await runDeterministicSwarmDemo({ targetDirectory });

    expect(result.status).toBe("verified");
    expect(result.events.at(-1)?.type).toBe("SWARM_VERIFIED");
    expect(result.parentOutcome.state).toBe("verified");
    expect(result.receiptEvidence).toHaveLength(15);
    expect(result.receiptEvidence.every((receipt) => (
      receipt.evidenceKind === "deterministic_demo"
      && receipt.swarmId === result.swarmId
      && receipt.referentialBinding === "passed"
      && receipt.signedIntegrity === "not_evaluated"
    ))).toBe(true);
  });
});
