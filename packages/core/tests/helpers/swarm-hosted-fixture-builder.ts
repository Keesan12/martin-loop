import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  createSwarmLivePlan,
  validateSwarmLivePlan,
  type SwarmTaskNode,
} from "@martin/contracts";
import {
  computeSwarmHostedEnvelopeIdentity,
  type SwarmAtlasView,
  type SwarmDashboardView,
  type SwarmHostedEnvelope,
  type SwarmSansaView,
} from "../../../contracts/dist/swarm-hosted.js";

import {
  type MartinAdapter,
  type MartinAdapterRequest,
} from "../../src/index.js";
import { buildSwarmHostedEnvelope, type BuiltSwarmHostedEnvelope } from "../../src/swarm/hosted-export.js";
import { projectSwarmAtlasView, projectSwarmDashboardView, projectSwarmTraceFacts } from "../../src/swarm/hosted-projection.js";
import { runProductionLiveSwarm, type RunProductionLiveSwarmInput } from "../../src/swarm/live-runtime.js";

const execFileAsync = promisify(execFile);
const FIXTURE_SCHEMA_VERSION = "martin.swarm-hosted-fixtures.v1" as const;
const FIXED_TIME_MS = Date.UTC(2026, 9, 3, 12, 0, 0);
const RUNTIME_VERSION = "0.8.0";
const FIXTURE_LOCK_WAIT_MS = 120_000;
const FIXTURE_LOCK_STALE_MS = 120_000;
const FIXTURE_LOCK_POLL_MS = 25;
const FIXTURE_LOCK_OWNER_FILE = "owner.json";
const FIXTURE_PROTOCOL_VERSION = "owner-v1";

export interface SwarmHostedFixtureCase {
  readonly name: string;
  readonly provenance: "production-exporter";
  readonly envelope: SwarmHostedEnvelope;
  readonly atlas: SwarmAtlasView;
  readonly sansa: SwarmSansaView;
  readonly dashboard: SwarmDashboardView;
}

export interface InvalidSwarmHostedFixtureCase {
  readonly name: string;
  readonly provenance: "tampered-copy";
  readonly tamper: "envelope_identity" | "parent_authority";
  readonly envelope: SwarmHostedEnvelope;
}

export interface SwarmHostedFixtureBundle {
  readonly schemaVersion: typeof FIXTURE_SCHEMA_VERSION;
  readonly provenance: {
    readonly producer: "buildSwarmHostedEnvelope";
    readonly source: "phase5-production-layout";
  };
  readonly validCases: readonly SwarmHostedFixtureCase[];
  readonly invalidCases: readonly InvalidSwarmHostedFixtureCase[];
}

export interface SwarmHostedFixtureEvidenceIndexDiagnostic {
  readonly caseName: string;
  readonly files: ReadonlyArray<{
    readonly kind: string;
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
  }>;
}

interface CaseSpec {
  readonly name: string;
  readonly taskCount: number;
  readonly mode: "verified" | "stopped" | "needs_review" | "failed_global" | "reassigned";
}

const CASES: readonly CaseSpec[] = [
  { name: "verified-15-agent", taskCount: 15, mode: "verified" },
  { name: "stopped-blocking-dependency", taskCount: 2, mode: "stopped" },
  { name: "needs-review-child-failure", taskCount: 2, mode: "needs_review" },
  { name: "failed-global-verifier", taskCount: 1, mode: "failed_global" },
  { name: "reassigned-recovered", taskCount: 1, mode: "reassigned" },
];

export async function buildProductionSwarmHostedFixtureBundle(): Promise<SwarmHostedFixtureBundle> {
  return withFixtureLock(async () => {
    const scratchRoot = join(tmpdir(), `martin-swarm-hosted-v1-production-fixtures.${FIXTURE_PROTOCOL_VERSION}`);
    await rm(scratchRoot, { recursive: true, force: true });
    await mkdir(scratchRoot, { recursive: true });
    const previousIntegrityRoot = process.env["MARTIN_INTEGRITY_KEY_DIR"];
    process.env["MARTIN_INTEGRITY_KEY_DIR"] = join(scratchRoot, "integrity");
    try {
      const validCases: SwarmHostedFixtureCase[] = [];
      for (const spec of CASES) {
        validCases.push(await withDeterministicRuntime(() => buildCase(scratchRoot, spec)));
      }
      const verified = validCases[0]!.envelope;
      const failedGlobal = validCases.find((item) => item.name === "failed-global-verifier")!.envelope;
      const parentAuthorityTamper = clone(failedGlobal);
      parentAuthorityTamper.parentOutcome = {
        state: "verified",
        source: "sealed_parent_receipt",
        evidence: failedGlobal.parentOutcome.evidence.map((item) => ({ ...item })),
      };
      const parentEvent = parentAuthorityTamper.events.find((event) => (
        event.eventId === parentAuthorityTamper.parentOutcome.evidence[0]?.eventId
      ));
      if (!parentEvent) throw new Error("The parent-authority fixture has no bound terminal event.");
      parentEvent.type = "SWARM_VERIFIED";
      parentAuthorityTamper.envelopeId = computeSwarmHostedEnvelopeIdentity(parentAuthorityTamper);
      return {
        schemaVersion: FIXTURE_SCHEMA_VERSION,
        provenance: {
          producer: "buildSwarmHostedEnvelope",
          source: "phase5-production-layout",
        },
        validCases,
        invalidCases: [
          {
            name: "tampered-envelope-identity",
            provenance: "tampered-copy",
            tamper: "envelope_identity",
            envelope: { ...clone(verified), envelopeId: "f".repeat(64) },
          },
          {
            name: "tampered-parent-authority",
            provenance: "tampered-copy",
            tamper: "parent_authority",
            envelope: parentAuthorityTamper,
          },
        ],
      };
    } finally {
      if (previousIntegrityRoot === undefined) delete process.env["MARTIN_INTEGRITY_KEY_DIR"];
      else process.env["MARTIN_INTEGRITY_KEY_DIR"] = previousIntegrityRoot;
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });
}

export async function buildProductionSwarmHostedFixtureEvidenceIndexDiagnostic(
  caseName: string,
): Promise<SwarmHostedFixtureEvidenceIndexDiagnostic> {
  const spec = CASES.find((candidate) => candidate.name === caseName);
  if (!spec) throw new Error(`Unknown production fixture case: ${caseName}`);
  return withFixtureLock(() => withDeterministicRuntime(async () => {
    const scratchRoot = join(tmpdir(), `martin-swarm-hosted-v1-diagnostic.${FIXTURE_PROTOCOL_VERSION}-${caseName}`);
    await rm(scratchRoot, { recursive: true, force: true });
    await mkdir(scratchRoot, { recursive: true });
    const previousIntegrityRoot = process.env["MARTIN_INTEGRITY_KEY_DIR"];
    process.env["MARTIN_INTEGRITY_KEY_DIR"] = join(scratchRoot, "integrity");
    let diagnostic: SwarmHostedFixtureEvidenceIndexDiagnostic | undefined;
    try {
      await buildCase(scratchRoot, spec, (value) => { diagnostic = value; });
      if (!diagnostic) throw new Error(`Fixture ${caseName} did not produce an evidence-index diagnostic.`);
      return diagnostic;
    } finally {
      if (previousIntegrityRoot === undefined) delete process.env["MARTIN_INTEGRITY_KEY_DIR"];
      else process.env["MARTIN_INTEGRITY_KEY_DIR"] = previousIntegrityRoot;
      await rm(scratchRoot, { recursive: true, force: true });
    }
  }));
}

export function canonicalSwarmHostedFixtureBytes(bundle: SwarmHostedFixtureBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export const canonicalSwarmHostedFixtureBundleBytes = canonicalSwarmHostedFixtureBytes;

export function swarmHostedFixtureSha256(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

export async function writeProductionSwarmHostedFixtures(
  fixturePath: string,
  checksumPath: string,
): Promise<{ readonly checksum: string; readonly bytes: number }> {
  const canonicalBytes = canonicalSwarmHostedFixtureBytes(await buildProductionSwarmHostedFixtureBundle());
  const checksum = swarmHostedFixtureSha256(canonicalBytes);
  await mkdir(dirname(fixturePath), { recursive: true });
  await writeFile(fixturePath, canonicalBytes, "utf8");
  await writeFile(checksumPath, `${checksum}\n`, "utf8");
  return { checksum, bytes: Buffer.byteLength(canonicalBytes, "utf8") };
}

async function buildCase(
  scratchRoot: string,
  spec: CaseSpec,
  onEvidenceIndex?: (diagnostic: SwarmHostedFixtureEvidenceIndexDiagnostic) => void,
): Promise<SwarmHostedFixtureCase> {
  const caseRoot = join(scratchRoot, spec.name);
  const canonicalRoot = join(caseRoot, "repository");
  const runsRoot = join(caseRoot, "runs");
  await mkdir(canonicalRoot, { recursive: true });
  await mkdir(runsRoot, { recursive: true });
  await git(canonicalRoot, ["init"]);
  await git(canonicalRoot, ["config", "user.email", "fixture@example.invalid"]);
  await git(canonicalRoot, ["config", "user.name", "Fixture Builder"]);
  await writeFile(join(canonicalRoot, "README.md"), `fixture ${spec.name}\n`, "utf8");
  if (spec.mode === "reassigned") {
    await mkdir(join(canonicalRoot, "fixture"), { recursive: true });
    await writeFile(join(canonicalRoot, "fixture", "recovered.txt"), "before recovery\n", "utf8");
  }
  await git(canonicalRoot, ["add", "."]);
  await git(canonicalRoot, ["commit", "-m", `fixture ${spec.name}`]);
  const baselineCommit = (await git(canonicalRoot, ["rev-parse", "HEAD"])).trim();
  const tasks = createTasks(spec);
  const agents = createAgents(tasks, spec);
  const childUsd = 1;
  const plan = createSwarmLivePlan({
    planId: `plan-${spec.name}`,
    swarmId: `swarm-${spec.name}`,
    workspaceId: `workspace-${spec.name}`,
    projectId: `project-${spec.name}`,
    baselineCommit,
    parentContract: {
      policyVersion: "swarm-policy-v1",
      objective: `Exercise ${spec.name}`,
      definitionOfDone: ["All required tasks reach their governed terminal state"],
      budget: {
        maxUsd: Math.max(10, spec.taskCount * childUsd + 2),
        softLimitUsd: Math.max(8, spec.taskCount * childUsd + 1),
        maxIterations: Math.max(10, spec.taskCount + 2),
        maxTokens: Math.max(1_000, spec.taskCount * 100),
      },
      maxWallClockMs: 120_000,
      maxConcurrency: spec.mode === "verified" ? spec.taskCount : 1,
      scope: {
        allowedPaths: spec.mode === "reassigned" ? ["fixture/**"] : ["README.md"],
        deniedPaths: [".git/**"],
      },
      permissions: { networkDomains: [], commands: ["echo verify"] },
      integrationStrategy: "parent_fan_in",
      globalVerifierStack: [{ command: "echo verify", type: "custom" }],
      stopPolicy: { budgetExhausted: "stop", blockingFailure: "needs_review", verifierFailure: "stop" },
      recoveryPolicy: {
        maxReassignmentsPerTask: spec.mode === "reassigned" ? 1 : 0,
        dependencyWaiversAllowed: false,
      },
      approvalPolicy: {},
      orchestrationStrategy: "hierarchical_dag",
    },
    tasks,
    agents,
    engine: { engine: "codex", model: "gpt-test" },
    childMaxIterations: 1,
    createdAt: new Date().toISOString(),
  });
  await seedIntegrityKey(runsRoot, plan.swarmId);
  const cancellation = new AbortController();
  const input: RunProductionLiveSwarmInput = {
    plan,
    canonicalRoot,
    ownedRoot: join(runsRoot, "_swarms", plan.swarmId, "worktrees"),
    storeRoot: runsRoot,
    runsRoot,
    adapterFactory: ({ agent }) => createAdapter(spec, agent.agentId, cancellation, runsRoot),
    verifierExecutor: createVerifier(spec.mode === "failed_global"),
    signal: cancellation.signal,
  };
  const validation = validateSwarmLivePlan(plan);
  if (!validation.ok) {
    throw new Error(`Fixture ${spec.name} has invalid plan: ${validation.errors.map((item) => `${item.code}:${item.path}`).join(",")}`);
  }
  const result = await runProductionLiveSwarm(input).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Fixture ${spec.name} failed production execution: ${detail}`, { cause: error });
  });
  assertExpectedOutcome(spec, result.outcome.state, result.outcome.reason, {
    tasks: result.record.tasks,
    agents: result.record.agents,
    outcome: result.record.outcome,
    events: result.record.events,
    parent: result.parent,
  });
  const built: BuiltSwarmHostedEnvelope = await buildSwarmHostedEnvelope({
    runsRoot,
    swarmId: plan.swarmId,
    runtimeVersion: RUNTIME_VERSION,
  });
  if (onEvidenceIndex) {
    const index = JSON.parse(await readFile(
      join(runsRoot, "_swarms", plan.swarmId, "evidence", "evidence-index.json"),
      "utf8",
    )) as { files?: SwarmHostedFixtureEvidenceIndexDiagnostic["files"] };
    onEvidenceIndex({ caseName: spec.name, files: index.files ?? [] });
  }
  return fixtureCase(spec.name, built.envelope);
}

function createTasks(spec: CaseSpec): SwarmTaskNode[] {
  return Array.from({ length: spec.taskCount }, (_, index) => ({
    taskId: `task-${index + 1}`,
    title: `Task ${index + 1}`,
    objective: `Complete task ${index + 1}`,
    required: true,
    dependsOn: index === 0 ? [] : [`task-${index}`],
    assignedAgentId: `agent-${index + 1}`,
    status: "queued" as const,
    mutationMode: spec.mode === "reassigned" ? "write" as const : "read_only" as const,
    writeScope: spec.mode === "reassigned" ? ["fixture/recovered.txt"] : [],
  }));
}

function createAgents(tasks: readonly SwarmTaskNode[], spec: CaseSpec) {
  const agents = tasks.map((task) => ({
    agentId: task.assignedAgentId!,
    role: "worker",
    status: "queued" as const,
    contract: {
      agentId: task.assignedAgentId!,
      taskIds: [task.taskId],
      scope: {
        allowedPaths: spec.mode === "reassigned" ? ["fixture/**"] : ["README.md"],
        deniedPaths: [".git/**"],
      },
      budget: {
        maxUsd: 1,
        softLimitUsd: 1,
        maxIterations: 1,
        maxTokens: 100,
      },
      maxWallClockMs: 60_000,
      permissions: { networkDomains: [], commands: ["echo verify"] },
      approvalPolicy: {},
      verifierAuthority: "child_only" as const,
    },
  }));
  if (spec.mode === "reassigned") {
    agents.push({
      ...agents[0]!,
      agentId: "agent-recovery",
      contract: { ...agents[0]!.contract, agentId: "agent-recovery" },
    });
  }
  return agents;
}

function createAdapter(
  spec: CaseSpec,
  agentId: string,
  cancellation: AbortController,
  runsRoot: string,
): MartinAdapter {
  return {
    adapterId: "codex:gpt-test",
    kind: "agent-cli",
    label: "production fixture child",
    metadata: { providerId: "codex", model: "gpt-test", capabilities: { workspaceMutations: spec.mode === "reassigned" } },
    async execute(request) {
      await seedChildIntegrityKey(runsRoot, request.loopId);
      if (spec.mode === "stopped") cancellation.abort("fixture_cancelled");
      if (spec.mode === "needs_review" || (spec.mode === "reassigned" && agentId !== "agent-recovery")) {
        return failedAdapterResult();
      }
      if (spec.mode === "reassigned") {
        const repoRoot = request.context.repoRoot;
        if (!repoRoot) throw new Error("fixture workspace missing");
        await writeFile(join(repoRoot, "fixture", "recovered.txt"), `fixture ${spec.name} recovered\n`, "utf8");
        return {
          ...passedAdapterResult(request),
          execution: { changedFiles: ["fixture/recovered.txt"] },
        };
      }
      return passedAdapterResult(request);
    },
  };
}

function passedAdapterResult(request: MartinAdapterRequest) {
  return {
    status: "completed" as const,
    summary: "done",
    usage: { actualUsd: 0.01, tokensIn: 2, tokensOut: 3 },
    verification: {
      passed: true,
      summary: "pass",
      binding: {
        runId: request.loopId,

        attemptId: request.attemptId,
        ...(request.context.runsRoot ? { runsRoot: request.context.runsRoot } : {}),
        ...(request.context.executionProfile ? { executionProfile: request.context.executionProfile } : {}),
        ...(request.context.allowedNetworkDomains?.length ? { allowedNetworkDomains: request.context.allowedNetworkDomains } : {}),
        workspaceId: request.workspaceId,
        cwd: request.context.repoRoot ?? process.cwd(),
        commands: request.context.verificationPlan,
      },
      steps: [{
        command: "echo verify",
        launched: true,
        completed: true,
        crashed: false,
        exitCode: 0,
        timedOut: false,
      }],
    },
  };
}

function failedAdapterResult() {
  return {
    status: "failed" as const,
    summary: "failed",
    usage: { actualUsd: 0.01, tokensIn: 2, tokensOut: 3 },
    verification: { passed: false, summary: "failed" },
    failure: { message: "fixture child failure", classHint: "environment_mismatch" as const },
  };
}

function createVerifier(fail: boolean) {
  return {
    async execute(request: any) {
      return {
        passed: !fail,
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
          exitCode: fail ? 1 : 0,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        })),
      };
    },
  };
}

function fixtureCase(name: string, envelope: SwarmHostedEnvelope): SwarmHostedFixtureCase {
  return {
    name,
    provenance: "production-exporter",
    envelope,
    atlas: projectSwarmAtlasView(envelope),
    sansa: projectSwarmTraceFacts(envelope),
    dashboard: projectSwarmDashboardView(envelope),
  };
}

function assertExpectedOutcome(spec: CaseSpec, state: string, reason: string, evidence: unknown): void {
  const expected = spec.mode === "verified" || spec.mode === "reassigned"
    ? "verified"
    : spec.mode === "stopped" ? "stopped" : "needs_review";
  if (state !== expected) {
    throw new Error(`Fixture ${spec.name} produced ${state} (${reason}); expected ${expected}. Evidence: ${JSON.stringify(evidence)}`);
  }
}

async function seedIntegrityKey(runsRoot: string, swarmId: string): Promise<void> {
  await seedPrivateIntegrityKey(runsRoot, `swarm-${swarmId}.key`, `fixture-key-${swarmId}`);
}

async function seedChildIntegrityKey(runsRoot: string, childRunId: string): Promise<void> {
  await seedPrivateIntegrityKey(runsRoot, `${childRunId}.key`, `fixture-child-key-${childRunId}`);
}

async function seedPrivateIntegrityKey(runsRoot: string, fileName: string, secret: string): Promise<void> {
  const integrityRoot = process.env["MARTIN_INTEGRITY_KEY_DIR"]!;
  const rootHash = createHash("sha256").update(runsRoot).digest("hex").slice(0, 16);
  const keyDir = join(integrityRoot, rootHash);
  await mkdir(keyDir, { recursive: true });
  await writeFile(join(keyDir, fileName), `${secret}\n`, "utf8");
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 8 * 1_024 * 1_024,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-10-03T12:00:00Z",
      GIT_COMMITTER_DATE: "2026-10-03T12:00:00Z",
    },
  });
  return result.stdout;
}

async function withDeterministicRuntime<T>(operation: () => Promise<T>): Promise<T> {
  const OriginalDate = Date;
  const originalRandom = Math.random;
  const require = createRequire(import.meta.url);
  const cryptoModule = require("node:crypto") as { randomUUID: typeof randomUUID };
  const originalRandomUUID = cryptoModule.randomUUID;
  let tick = 0;
  let nowTick = 0;
  let randomSequence = 0;
  let uuidSequence = 0;
  class DeterministicDate extends OriginalDate {
    constructor(value?: string | number | Date) {
      super(value === undefined ? FIXED_TIME_MS + tick++ * 1_000 : value instanceof OriginalDate ? value.getTime() : value);
    }
    static override now(): number {
      return FIXED_TIME_MS + nowTick++;
    }
  }
  globalThis.Date = DeterministicDate as DateConstructor;
  Math.random = () => {
    randomSequence += 1;
    return (randomSequence % 1_000_000) / 1_000_000;
  };
  cryptoModule.randomUUID = (() => {
    uuidSequence += 1;
    return `00000000-0000-4000-8000-${uuidSequence.toString(16).padStart(12, "0")}`;
  }) as typeof randomUUID;
  syncBuiltinESMExports();
  try {
    return await operation();
  } finally {
    globalThis.Date = OriginalDate;
    Math.random = originalRandom;
    cryptoModule.randomUUID = originalRandomUUID;
    syncBuiltinESMExports();
  }
}

interface FixtureLockOwner {
  readonly pid: number;
  readonly createdAt: number;
  readonly nonce: string;
}

interface FixtureLockOptions {
  readonly lockPath?: string;
  readonly waitTimeoutMs?: number;
  readonly staleAfterMs?: number;
  readonly pollIntervalMs?: number;
}

export function withProductionFixtureLockForTest<T>(
  operation: () => Promise<T>,
  options: Required<FixtureLockOptions>,
): Promise<T> {
  return withFixtureLock(operation, options);
}

async function withFixtureLock<T>(
  operation: () => Promise<T>,
  options: FixtureLockOptions = {},
): Promise<T> {
  const lockPath = options.lockPath ?? join(
    tmpdir(),
    `martin-swarm-hosted-v1-production-fixtures.${FIXTURE_PROTOCOL_VERSION}.lock`,
  );
  const waitTimeoutMs = options.waitTimeoutMs ?? FIXTURE_LOCK_WAIT_MS;
  const staleAfterMs = options.staleAfterMs ?? FIXTURE_LOCK_STALE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? FIXTURE_LOCK_POLL_MS;
  const owner: FixtureLockOwner = {
    pid: process.pid,
    createdAt: Date.now(),
    nonce: randomUUID(),
  };
  const deadline = OriginalDateNow() + waitTimeoutMs;
  while (true) {
    if (await tryAcquireFixtureLock(lockPath, owner)) break;
    if (await recoverStaleFixtureLock(lockPath, staleAfterMs)) continue;
    if (OriginalDateNow() >= deadline) throw new Error("Timed out waiting for the production fixture builder lock.");
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  try {
    return await operation();
  } finally {
    await releaseFixtureLock(lockPath, owner);
  }
}

async function tryAcquireFixtureLock(lockPath: string, owner: FixtureLockOwner): Promise<boolean> {
  const candidatePath = `${lockPath}.${owner.pid}.${owner.nonce}.candidate`;
  await mkdir(candidatePath);
  try {
    await writeFile(join(candidatePath, FIXTURE_LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    try {
      await rename(candidatePath, lockPath);
      return true;
    } catch (error) {
      if (await pathExists(lockPath)) return false;
      throw error;
    }
  } finally {
    await rm(candidatePath, { recursive: true, force: true });
  }
}

async function recoverStaleFixtureLock(lockPath: string, staleAfterMs: number): Promise<boolean> {
  const observed = await readFixtureLockOwner(lockPath);
  if (!observed || Date.now() - observed.owner.createdAt <= staleAfterMs) return false;
  if (!ownerProcessIsProvablyAbsent(observed.owner.pid)) return false;
  const quarantinePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
  try {
    await rename(lockPath, quarantinePath);
  } catch (error) {
    if (isFsCode(error, "ENOENT")) return false;
    throw error;
  }
  const moved = await readFixtureLockOwner(quarantinePath);
  if (!moved || moved.bytes !== observed.bytes) {
    await restoreUnknownFixtureLock(quarantinePath, lockPath);
    throw new Error("Fixture lock ownership changed during stale recovery.");
  }
  await rm(quarantinePath, { recursive: true, force: false });
  return true;
}

async function releaseFixtureLock(lockPath: string, owner: FixtureLockOwner): Promise<void> {
  const observed = await readFixtureLockOwner(lockPath);
  if (!observed || observed.bytes !== `${JSON.stringify(owner)}\n`) return;
  const releasePath = `${lockPath}.release.${owner.pid}.${owner.nonce}`;
  try {
    await rename(lockPath, releasePath);
  } catch (error) {
    if (isFsCode(error, "ENOENT")) return;
    throw error;
  }
  const moved = await readFixtureLockOwner(releasePath);
  if (!moved || moved.bytes !== observed.bytes) {
    await restoreUnknownFixtureLock(releasePath, lockPath);
    throw new Error("Fixture lock ownership changed during release.");
  }
  await rm(releasePath, { recursive: true, force: false });
}

async function readFixtureLockOwner(lockPath: string): Promise<{ owner: FixtureLockOwner; bytes: string } | undefined> {
  let bytes: string;
  try {
    bytes = await readFile(join(lockPath, FIXTURE_LOCK_OWNER_FILE), "utf8");
  } catch (error) {
    if (isFsCode(error, "ENOENT") || isFsCode(error, "ENOTDIR")) return undefined;
    throw error;
  }
  try {
    const parsed = JSON.parse(bytes) as Partial<FixtureLockOwner>;
    if (Object.keys(parsed).sort().join(",") !== "createdAt,nonce,pid"
      || !Number.isInteger(parsed.pid) || Number(parsed.pid) <= 0
      || typeof parsed.createdAt !== "number" || !Number.isFinite(parsed.createdAt)
      || typeof parsed.nonce !== "string" || !/^[A-Za-z0-9-]{1,128}$/u.test(parsed.nonce)) return undefined;
    return { owner: parsed as FixtureLockOwner, bytes };
  } catch {
    return undefined;
  }
}

function ownerProcessIsProvablyAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isFsCode(error, "ESRCH");
  }
}

async function restoreUnknownFixtureLock(sourcePath: string, lockPath: string): Promise<void> {
  try {
    await rename(sourcePath, lockPath);
  } catch {
    // Fail closed: retain the unknown owner at its exact quarantined path for inspection.
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isFsCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isFsCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function OriginalDateNow(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
