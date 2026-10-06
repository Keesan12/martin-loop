import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSwarmRunRecord,
  normalizeSwarmPathPattern,
  swarmPathPatternContains,
  type SwarmAgentRecord,
  type SwarmDeterministicDemoReceiptEvidence,
  type SwarmEvent,
  type SwarmOutcome,
  type SwarmParentContract,
  type SwarmRunRecord,
  type SwarmTaskNode,
} from "@martin/contracts";
import { completeDeterministicDemoSwarmRun, selectNextSwarmBatch } from "@martin/core";

export const SWARM_DEMO_AGENTS = [
  { id: "agent-01", number: "01", role: "Planner" },
  { id: "agent-02", number: "02", role: "Data" },
  { id: "agent-03", number: "03", role: "API" },
  { id: "agent-04", number: "04", role: "Validation" },
  { id: "agent-05", number: "05", role: "UI" },
  { id: "agent-06", number: "06", role: "State" },
  { id: "agent-07", number: "07", role: "Unit Tests" },
  { id: "agent-08", number: "08", role: "Integration Tests" },
  { id: "agent-09", number: "09", role: "Accessibility" },
  { id: "agent-10", number: "10", role: "Error Handling" },
  { id: "agent-11", number: "11", role: "Docs" },
  { id: "agent-12", number: "12", role: "Scope Reviewer" },
  { id: "agent-13", number: "13", role: "Test Reviewer" },
  { id: "agent-14", number: "14", role: "Integrator" },
  { id: "agent-15", number: "15", role: "Final Verifier" },
] as const;

interface DemoProposal {
  agentId: string;
  taskId: string;
  path: string;
  content: string;
}

export interface DeterministicSwarmDemoEvent {
  type: SwarmEvent["type"];
  timestamp: string;
  agentId?: string;
  taskId?: string;
  payload: Record<string, unknown>;
}

export interface DeterministicSwarmDemoGraphEdge {
  dependencyTaskId: string;
  dependencyAgentId: string;
  taskId: string;
  agentId: string;
}

export interface DeterministicSwarmDemoExecutionAttribution {
  taskId: string;
  plannedAgentId: string;
  executedByAgentId: string;
  recovery: "original" | "reassigned";
}

export interface DeterministicSwarmDemoResult {
  swarmId: string;
  status: "running" | "stopped" | "needs_review" | "verified";
  targetDirectory: string;
  orchestrationStrategy: "hybrid";
  graphEdges: Array<[string, string]>;
  plannedGraphEdges: DeterministicSwarmDemoGraphEdge[];
  executionGraphEdges: DeterministicSwarmDemoGraphEdge[];
  executionAttribution: DeterministicSwarmDemoExecutionAttribution[];
  agents: 15;
  completed: number;
  stopped: number;
  needsReview: number;
  reassignedTasks: number;
  deniedChangesAdmitted: number;
  maxObservedConcurrency: number;
  providerMode: "deterministic_local";
  providerSpendUsd: 0;
  budget: {
    capUsd: number;
    settledUsd: number;
    reservedUsd: number;
    remainingUsd: number;
  };
  globalVerifier: {
    command: string;
    launched: boolean;
    completed: boolean;
    crashed: boolean;
    exitCode: number | null;
    passed: boolean;
  };
  integration: { provenance: Array<{ path: string; agentId: string; taskId: string }> };
  agentStatuses: Array<{ agentId: string; number: string; role: string; status: "completed" | "stopped" | "needs_review" }>;
  parentOutcome: SwarmOutcome;
  receiptEvidence: SwarmDeterministicDemoReceiptEvidence[];
  events: DeterministicSwarmDemoEvent[];
  record: SwarmRunRecord;
}

interface InjectedParentVerifierResult {
  launched: boolean;
  completed: boolean;
  crashed: boolean;
  exitCode: number | null;
}

export interface RunDeterministicSwarmDemoOptions {
  targetDirectory: string;
  force?: boolean;
  provider?: () => unknown;
  parentVerifier?: (targetDirectory: string) => InjectedParentVerifierResult;
}

const DATA_SOURCE = `export const launchItems = [
  { id: "alpha", name: "Alpha" },
  { id: "beta", name: "Beta" },
];
`;

const API_SOURCE = `import { launchItems } from "./data.js";

export function createLaunchBoard() {
  return { items: launchItems.map((item) => ({ ...item })) };
}
`;

const UI_SOURCE = `export function renderLaunchBoard(board) {
  return \`LaunchBoard: \${board.items.map((item) => item.name).join(", ")}\`;
}
`;

const STATE_SOURCE = `export function createLaunchState() {
  return { selectedId: null, error: null };
}
`;

function makeParentContract(): SwarmParentContract {
  return {
    policyVersion: "demo-swarm-policy-v1",
    objective: "Build and verify the deterministic LaunchBoard fixture.",
    definitionOfDone: ["The integrated LaunchBoard passes the parent verifier."],
    budget: { maxUsd: 1, softLimitUsd: 0, maxIterations: 1, maxTokens: 15_000 },
    maxWallClockMs: 120_000,
    maxConcurrency: 5,
    scope: {
      allowedPaths: ["src/**", "test/**", "README.md", "package.json"],
      deniedPaths: [".env", ".git/**", "private/**"],
    },
    permissions: { networkDomains: [], commands: ["node --test"] },
    integrationStrategy: "parent_fan_in",
    globalVerifierStack: [{ command: "node --test", type: "test_full" }],
    stopPolicy: { budgetExhausted: "stop", blockingFailure: "needs_review", verifierFailure: "stop" },
    recoveryPolicy: { maxReassignmentsPerTask: 1, dependencyWaiversAllowed: false },
    approvalPolicy: { dependencyAdds: false, migrations: false, configChanges: false, externalWrites: false },
    orchestrationStrategy: "hybrid",
  };
}

const TASK_DEPENDENCIES: ReadonlyArray<readonly number[]> = [
  [],
  [1],
  [2],
  [1],
  [1],
  [1],
  [1],
  [3],
  [5],
  [1],
  [1],
  [3],
  [7, 8],
  [4, 6, 9, 10, 11, 12, 13],
  [14],
];

const WRITE_SCOPES: Readonly<Record<string, string[]>> = {
  "agent-02": ["src/data.js"],
  "agent-03": ["src/api.js"],
  "agent-05": ["src/ui.js"],
  "agent-06": ["src/state.js"],
  "agent-10": ["src/state.js"],
};

function makeTasks(): SwarmTaskNode[] {
  return SWARM_DEMO_AGENTS.map((agent, index) => {
    const writeScope = agent.id === "agent-10" ? [] : [...(WRITE_SCOPES[agent.id] ?? [])];
    return {
      taskId: `task-${agent.number}`,
      title: agent.role,
      objective: `Complete the bounded ${agent.role} assignment.`,
      required: true,
      dependsOn: TASK_DEPENDENCIES[index]!.map((number) => `task-${String(number).padStart(2, "0")}`),
      assignedAgentId: agent.id,
      status: "queued",
      mutationMode: writeScope.length > 0 ? "write" : "read_only",
      writeScope,
    };
  });
}

function makeAgents(parent: SwarmParentContract): SwarmAgentRecord[] {
  return SWARM_DEMO_AGENTS.map((agent) => {
    const allowedPaths = [...(WRITE_SCOPES[agent.id] ?? [])];
    return {
      agentId: agent.id,
      role: agent.role,
      status: "queued",
      childRunId: `demo-child-${agent.number}`,
      contract: {
        agentId: agent.id,
        taskIds: agent.id === "agent-10" ? ["task-10", "task-06"] : [`task-${agent.number}`],
        scope: { allowedPaths, deniedPaths: [...parent.scope.deniedPaths] },
        budget: { maxUsd: 0, softLimitUsd: 0, maxIterations: 1, maxTokens: 1_000 },
        maxWallClockMs: 30_000,
        permissions: { networkDomains: [], commands: [] },
        approvalPolicy: { dependencyAdds: false, migrations: false, configChanges: false, externalWrites: false },
        verifierAuthority: "child_only",
      },
    };
  });
}

function makeProposal(agentId: string, taskId: string): DemoProposal | undefined {
  if (agentId === "agent-06" && taskId === "task-06") {
    return {
      agentId,
      taskId,
      path: "private/agent-06-notes.md",
      content: "This denied proposal must never reach the filesystem.\n",
    };
  }
  if (agentId === "agent-10" && taskId === "task-06") {
    return { agentId, taskId, path: "src/state.js", content: STATE_SOURCE };
  }
  const sources: Record<string, [string, string]> = {
    "agent-02": ["src/data.js", DATA_SOURCE],
    "agent-03": ["src/api.js", API_SOURCE],
    "agent-05": ["src/ui.js", UI_SOURCE],
  };
  const source = sources[agentId];
  return source
    ? { agentId, taskId, path: source[0], content: source[1] }
    : undefined;
}

export function resolveDeterministicSwarmDemoFixtureDirectory(moduleUrl = import.meta.url): string {
  return path.resolve(fileURLToPath(new URL("../../../demo/swarm-launch-board/", moduleUrl)));
}

async function prepareTarget(targetDirectory: string, force: boolean): Promise<void> {
  const fixture = resolveDeterministicSwarmDemoFixtureDirectory();
  assertSafeDeterministicSwarmDemoTarget(targetDirectory, force, {
    workingDirectory: process.cwd(),
    fixtureDirectory: fixture,
  });
  await mkdir(targetDirectory, { recursive: true });
  const existing = await readdir(targetDirectory);
  if (existing.length > 0 && !force) {
    throw new Error(`Demo target already exists and is not empty: ${targetDirectory}. Pass --force to replace it.`);
  }
  if (existing.length > 0) {
    await rm(targetDirectory, { recursive: true, force: true });
    await mkdir(targetDirectory, { recursive: true });
  }
  await cp(fixture, targetDirectory, { recursive: true });
  const git = spawnSync("git", ["init", "--quiet"], { cwd: targetDirectory, encoding: "utf8" });
  if (git.error || git.status !== 0) {
    throw new Error(`Unable to initialize demo Git repository: ${git.error?.message ?? git.stderr.trim()}`);
  }
}

function proposalIsAuthorized(record: SwarmRunRecord, proposal: DemoProposal): boolean {
  const agent = record.agents.find((candidate) => candidate.agentId === proposal.agentId);
  const task = record.tasks.find((candidate) => candidate.taskId === proposal.taskId);
  const normalized = normalizeSwarmPathPattern(proposal.path);
  if (!agent || !task || !normalized.ok || task.mutationMode !== "write") return false;
  return task.writeScope.some((scope) => swarmPathPatternContains(scope, normalized.value))
    && agent.contract.scope.allowedPaths.some((scope) => swarmPathPatternContains(scope, normalized.value))
    && record.parentContract.scope.allowedPaths.some((scope) => swarmPathPatternContains(scope, normalized.value))
    && [...record.parentContract.scope.deniedPaths, ...agent.contract.scope.deniedPaths]
      .every((scope) => !swarmPathPatternContains(scope, normalized.value));
}

export async function runDeterministicSwarmDemo(
  options: RunDeterministicSwarmDemoOptions,
): Promise<DeterministicSwarmDemoResult> {
  await prepareTarget(options.targetDirectory, options.force ?? false);
  const parentContract = makeParentContract();
  const createdAt = "2026-01-01T00:00:00.000Z";
  const record = createSwarmRunRecord({
    swarmId: "swarm-demo-launch-board",
    workspaceId: "workspace-demo-launch-board",
    projectId: "project-demo-launch-board",
    parentContract,
    tasks: makeTasks(),
    agents: makeAgents(parentContract),
  }, { now: createdAt });
  const plannedAssignments = new Map(record.tasks.map((task) => [task.taskId, task.assignedAgentId!]));
  let tick = 1;
  const event = (
    type: SwarmEvent["type"],
    details: { agentId?: string; taskId?: string; payload?: Record<string, unknown> } = {},
  ): SwarmEvent => ({
    type,
    swarmId: record.swarmId,
    timestamp: new Date(Date.parse(createdAt) + tick++ * 1_000).toISOString(),
    parentPolicyVersion: parentContract.policyVersion,
    ...(details.agentId ? { agentId: details.agentId, childRunId: `demo-child-${details.agentId.slice(-2)}` } : {}),
    ...(details.taskId ? { taskId: details.taskId } : {}),
    payload: details.payload ?? {},
  });

  record.events.push(event("SWARM_PLAN_CREATED"), event("SWARM_PLAN_APPROVED"));
  const proposals: DemoProposal[] = [];
  const provenance: Array<{ path: string; agentId: string; taskId: string }> = [];
  let maxObservedConcurrency = 0;

  while (record.tasks.some((task) => task.status === "queued" || task.status === "ready")) {
    const batch = selectNextSwarmBatch({
      swarmId: record.swarmId,
      tasks: record.tasks,
      maxConcurrency: parentContract.maxConcurrency,
      parentContract,
    });
    if (!batch.ok) throw new Error(`Deterministic swarm graph rejected: ${batch.errors.map((error) => error.message).join("; ")}`);
    if (batch.tasks.length === 0) throw new Error("Deterministic swarm graph stalled before all tasks completed.");
    maxObservedConcurrency = Math.max(maxObservedConcurrency, batch.tasks.length);

    for (const selected of batch.tasks) {
      const task = record.tasks.find((candidate) => candidate.taskId === selected.taskId)!;
      const agent = record.agents.find((candidate) => candidate.agentId === task.assignedAgentId)!;
      task.status = "running";
      agent.status = "running";
      record.events.push(
        event("TASK_READY", { agentId: agent.agentId, taskId: task.taskId }),
        event("TASK_ASSIGNED", { agentId: agent.agentId, taskId: task.taskId }),
        event("CHILD_STARTED", { agentId: agent.agentId, taskId: task.taskId }),
      );
      const proposal = makeProposal(agent.agentId, task.taskId);
      if (proposal) {
        record.events.push(event("CHILD_PATCH_PROPOSED", {
          agentId: agent.agentId,
          taskId: task.taskId,
          payload: { paths: [proposal.path] },
        }));
        if (!proposalIsAuthorized(record, proposal)) {
          record.events.push(
            event("CHILD_PATCH_REJECTED", {
              agentId: agent.agentId,
              taskId: task.taskId,
              payload: { reason: "scope_creep", paths: [proposal.path], bytesAdmitted: 0 },
            }),
            event("CHILD_STOPPED", {
              agentId: agent.agentId,
              taskId: task.taskId,
              payload: { reason: "scope_creep" },
            }),
          );
          agent.status = "stopped";
          agent.failureClass = "scope_creep";
          task.status = "queued";
          task.assignedAgentId = "agent-10";
          record.events.push(event("TASK_REASSIGNED", {
            agentId: "agent-10",
            taskId: task.taskId,
            payload: { fromAgentId: agent.agentId, reason: "scope_creep" },
          }));
          continue;
        }
        proposals.push(proposal);
      }
      if (task.taskId === "task-14") {
        record.events.push(event("INTEGRATION_STARTED", { agentId: "agent-14", taskId: "task-14" }));
        for (const candidate of proposals) {
          if (!proposalIsAuthorized(record, candidate)) {
            throw new Error(`Proposal outside child scope: ${candidate.path}`);
          }
          await writeFile(path.join(options.targetDirectory, ...candidate.path.split("/")), candidate.content, "utf8");
          provenance.push({ path: candidate.path, agentId: candidate.agentId, taskId: candidate.taskId });
          record.events.push(event("CHILD_PATCH_ADMITTED", {
            agentId: candidate.agentId,
            taskId: candidate.taskId,
            payload: { paths: [candidate.path] },
          }));
        }
        record.events.push(event("INTEGRATION_COMPLETED", {
          agentId: "agent-14",
          taskId: "task-14",
          payload: { provenance },
        }));
      }
      if (task.taskId === "task-15") {
        continue;
      }
      task.status = "accepted";
      agent.status = "verified";
      record.events.push(event("CHILD_VERIFIED", { agentId: agent.agentId, taskId: task.taskId }));
    }
  }

  record.events.push(event("GLOBAL_VERIFIER_STARTED", { agentId: "agent-15", taskId: "task-15" }));
  const verifierProcess = options.parentVerifier
    ? undefined
    : spawnSync(process.execPath, ["--test"], {
        cwd: options.targetDirectory,
        encoding: "utf8",
        windowsHide: true,
      });
  const verifierResult: InjectedParentVerifierResult = options.parentVerifier
    ? options.parentVerifier(options.targetDirectory)
    : {
        launched: true,
        completed: true,
        crashed: verifierProcess?.error !== undefined,
        exitCode: verifierProcess?.status ?? null,
      };
  const verifierPassed = verifierResult.launched
    && verifierResult.completed
    && !verifierResult.crashed
    && verifierResult.exitCode === 0;
  const finalTask = record.tasks.find((task) => task.taskId === "task-15")!;
  const finalAgent = record.agents.find((agent) => agent.agentId === "agent-15")!;
  finalTask.status = verifierPassed ? "accepted" : verifierResult.completed ? "stopped" : "needs_review";
  finalAgent.status = verifierPassed ? "verified" : verifierResult.completed ? "stopped" : "needs_review";
  let verifierEvent: SwarmEvent | undefined;
  if (verifierPassed || verifierResult.completed) {
    verifierEvent = event(verifierPassed ? "GLOBAL_VERIFIER_PASSED" : "GLOBAL_VERIFIER_FAILED", {
      agentId: "agent-15",
      taskId: "task-15",
      payload: { verifierId: "demo-parent-verifier", exitCode: verifierResult.exitCode },
    });
    record.events.push(verifierEvent);
  }
  const evaluatedAt = verifierEvent?.timestamp ?? new Date(Date.parse(createdAt) + tick++ * 1_000).toISOString();
  record.verification.push({
    verifierId: "demo-parent-verifier",
    scope: "parent_global",
    state: verifierPassed ? "passed" : verifierResult.completed ? "failed" : "unknown",
    steps: parentContract.globalVerifierStack.map((step) => ({ ...step })),
    boundAt: evaluatedAt,
  });
  record.updatedAt = evaluatedAt;
  const receiptEvidence: SwarmDeterministicDemoReceiptEvidence[] = record.agents.map((agent) => ({
    evidenceKind: "deterministic_demo",
    swarmId: record.swarmId,
    agentId: agent.agentId,
    taskIds: [...agent.contract.taskIds],
    childRunId: agent.childRunId!,
    referentialBinding: "passed",
    signedIntegrity: "not_evaluated",
  }));
  const completion = completeDeterministicDemoSwarmRun({
    record,
    verifier: {
      verifierId: "demo-parent-verifier",
      swarmId: record.swarmId,
      workspaceId: record.workspaceId,
      parentPolicyVersion: parentContract.policyVersion,
      commands: parentContract.globalVerifierStack.map((step) => step.command),
      launched: verifierResult.launched,
      completed: verifierResult.completed,
      crashed: verifierResult.crashed,
      timedOut: false,
      exitCode: verifierResult.exitCode,
      evaluatedAt,
    },
    receiptEvidence,
  });
  const completedRecord = completion.record;
  const executionAssignments = new Map(completedRecord.tasks.map((task) => [task.taskId, task.assignedAgentId!]));
  const buildGraphEdges = (assignments: ReadonlyMap<string, string>): DeterministicSwarmDemoGraphEdge[] => (
    completedRecord.tasks.flatMap((task) => task.dependsOn.map((dependencyTaskId) => ({
      dependencyTaskId,
      dependencyAgentId: assignments.get(dependencyTaskId)!,
      taskId: task.taskId,
      agentId: assignments.get(task.taskId)!,
    })))
  );
  const plannedGraphEdges = buildGraphEdges(plannedAssignments);
  const executionGraphEdges = buildGraphEdges(executionAssignments);
  const executionAttribution: DeterministicSwarmDemoExecutionAttribution[] = completedRecord.tasks.map((task) => {
    const plannedAgentId = plannedAssignments.get(task.taskId)!;
    const executedByAgentId = executionAssignments.get(task.taskId)!;
    return {
      taskId: task.taskId,
      plannedAgentId,
      executedByAgentId,
      recovery: plannedAgentId === executedByAgentId ? "original" : "reassigned",
    };
  });
  const agentStatuses = completedRecord.agents.map((agent) => ({
    agentId: agent.agentId,
    number: SWARM_DEMO_AGENTS.find((candidate) => candidate.id === agent.agentId)!.number,
    role: agent.role,
    status: agent.status === "verified" ? "completed" as const
      : agent.status === "stopped" ? "stopped" as const
      : "needs_review" as const,
  }));
  const completed = agentStatuses.filter((agent) => agent.status === "completed").length;
  const stopped = agentStatuses.filter((agent) => agent.status === "stopped").length;
  const needsReview = agentStatuses.filter((agent) => agent.status === "needs_review").length;
  return {
    swarmId: completedRecord.swarmId,
    status: completion.outcome.state,
    targetDirectory: path.resolve(options.targetDirectory),
    orchestrationStrategy: "hybrid",
    graphEdges: plannedGraphEdges.map((edge) => [edge.dependencyAgentId, edge.agentId]),
    plannedGraphEdges,
    executionGraphEdges,
    executionAttribution,
    agents: 15,
    completed,
    stopped,
    needsReview,
    reassignedTasks: 1,
    deniedChangesAdmitted: 0,
    maxObservedConcurrency,
    providerMode: "deterministic_local",
    providerSpendUsd: 0,
    budget: { capUsd: 1, settledUsd: 0, reservedUsd: 0, remainingUsd: 1 },
    globalVerifier: {
      command: "node --test",
      launched: verifierResult.launched,
      completed: verifierResult.completed,
      crashed: verifierResult.crashed,
      exitCode: verifierResult.exitCode,
      passed: verifierPassed,
    },
    integration: { provenance },
    agentStatuses,
    parentOutcome: { ...completion.outcome },
    receiptEvidence: completion.receiptEvidence.map((receipt) => ({ ...receipt, taskIds: [...receipt.taskIds] })),
    events: completedRecord.events.map(({ type, timestamp, agentId, taskId, payload }) => ({
      type,
      timestamp,
      ...(agentId ? { agentId } : {}),
      ...(taskId ? { taskId } : {}),
      payload: { ...payload },
    })),
    record: completedRecord,
  };
}

export function getDeterministicSwarmDemoExitCode(result: DeterministicSwarmDemoResult): 0 | 1 {
  return result.status === "verified" && result.globalVerifier.passed ? 0 : 1;
}

export function assertSafeDeterministicSwarmDemoTarget(
  targetDirectory: string,
  force: boolean,
  boundaries: { workingDirectory: string; fixtureDirectory: string },
): void {
  if (!force) return;
  const target = path.resolve(targetDirectory);
  const protectedPaths = [
    path.resolve(boundaries.fixtureDirectory),
    path.resolve(boundaries.workingDirectory, ".git"),
  ];
  const workingDirectory = path.resolve(boundaries.workingDirectory);
  const isAtOrInside = (parent: string, candidate: string): boolean => {
    const relativePath = path.relative(parent, candidate);
    return relativePath === ""
      || (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
  };
  const overlapsProtectedPath = protectedPaths.some((protectedPath) => (
    isAtOrInside(target, protectedPath) || isAtOrInside(protectedPath, target)
  ));
  const isFileSystemRoot = target === path.parse(target).root;
  const isWorkingDirectoryOrAncestor = isAtOrInside(target, workingDirectory);
  if (isFileSystemRoot || isWorkingDirectoryOrAncestor || overlapsProtectedPath) {
    throw new Error(`Unsafe --force target refused: ${target}`);
  }
}

export function renderDeterministicSwarmDemoHuman(result: DeterministicSwarmDemoResult): string {
  const verifierState = result.globalVerifier.passed
    ? "PASS"
    : result.globalVerifier.completed ? "FAIL" : "UNKNOWN";
  const rows = SWARM_DEMO_AGENTS.map((agent) => {
    const actual = result.agentStatuses.find((candidate) => candidate.agentId === agent.id)!;
    const status = actual.status === "completed"
      ? "COMPLETED"
      : actual.status === "stopped"
        ? agent.id === "agent-06" ? "STOPPED · scope_creep" : "STOPPED"
        : "NEEDS REVIEW";
    return `  ${agent.number} ${agent.role.padEnd(18, " ")} ${status}`;
  });
  const needsReviewSummary = result.needsReview > 0 ? ` · ${result.needsReview} needs review` : "";
  const lines = [
    "DEMO SWARM · deterministic local workers · $0 provider spend",
    "GOVERNED BY MARTINLOOP",
    "",
    "CREATE · Parent contract created; concurrency capped at 5.",
    "PLAN · Hybrid task DAG approved.",
    "FAN OUT · Bounded local workers scheduled.",
    "REVIEW · Scope and test reviewer gates completed.",
    "RECOVER · BLOCKED BY MARTINLOOP · Agent 06 scope_creep rejected pre-write.",
    "          Task reassigned to Agent 10 · Swarm continued.",
    "INTEGRATE · Parent admitted bounded proposals with provenance.",
    `VERIFY · Parent verifier: ${verifierState}`,
    `COMPLETE · ${result.completed} completed · ${result.stopped} stopped${needsReviewSummary} · ${result.reassignedTasks} reassigned task`,
    "",
    ...rows,
    "",
    `${result.deniedChangesAdmitted} denied changes admitted`,
    `Provider spend: $${result.providerSpendUsd}`,
    "Receipt binding: deterministic_demo · signed integrity: not_evaluated",
    `Parent verifier: ${verifierState}`,
    "ONE JOB · 15 AGENTS · ONE ACCOUNTABLE OUTCOME",
  ];
  if (result.status === "verified") lines.push("SWARM VERIFIED");
  return lines.join("\n");
}
