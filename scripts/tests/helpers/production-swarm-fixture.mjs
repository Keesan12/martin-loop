import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  SWARM_CHILD_MAX_WALL_CLOCK_MS,
  resolveSwarmDeadlineMs,
} from "../../../packages/contracts/dist/index.js";

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..", "..", "..");

export async function buildLiveSwarmProductionFixture({ root, submittedRoot, name, workers, maxConcurrency, budgetUsd, verifierPass = true, usageUsdByIndex, delayMsByIndex }) {
  const previousTsconfig = process.env.TSX_TSCONFIG_PATH;
  process.env.TSX_TSCONFIG_PATH = resolve(ROOT, "packages/core/tsconfig.json");
  const { tsImport } = await import("tsx/esm/api");
  const liveRuntime = await tsImport(pathToFileURL(resolve(ROOT, "packages/core/src/swarm/live-runtime.ts")).href, import.meta.url);
  const core = await tsImport(pathToFileURL(resolve(ROOT, "packages/core/src/index.ts")).href, import.meta.url);
  const contracts = await tsImport(pathToFileURL(resolve(ROOT, "packages/contracts/src/index.ts")).href, import.meta.url);
  if (previousTsconfig === undefined) delete process.env.TSX_TSCONFIG_PATH; else process.env.TSX_TSCONFIG_PATH = previousTsconfig;

  const trustRoot = join(root, "trust");
  const integrityRoot = join(trustRoot, "integrity-keys");
  const repositoryRoot = join(root, `${name}-repository`);
  const runsRoot = join(root, `${name}-runs`);
  const swarmId = `live-swarm-${name}`;
  await mkdir(join(repositoryRoot, "fixture"), { recursive: true });
  await mkdir(runsRoot, { recursive: true });
  await mkdir(submittedRoot, { recursive: true });
  await git(repositoryRoot, ["init"]);
  await git(repositoryRoot, ["config", "user.email", "fixture@example.invalid"]);
  await git(repositoryRoot, ["config", "user.name", "Live Swarm Fixture"]);
  await writeFile(join(repositoryRoot, "README.md"), `${name}\n`, "utf8");
  for (let index = 0; index < workers; index += 1) await writeFile(join(repositoryRoot, "fixture", `agent-${index}.txt`), "before\n", "utf8");
  await git(repositoryRoot, ["add", "."]); await git(repositoryRoot, ["commit", "-m", `live-swarm-${name}`]);
  const workspaceSourceSha = (await git(repositoryRoot, ["rev-parse", "HEAD"])).trim();
  const tasks = Array.from({ length: workers }, (_, index) => ({ taskId: `${name}-task-${index}`, title: `Task ${index}`, objective: `Write ${index}`, required: true, dependsOn: [], assignedAgentId: `${name}-agent-${index}`, status: "queued", mutationMode: "write", writeScope: [`fixture/agent-${index}.txt`] }));
  const agents = tasks.map((task) => ({ agentId: task.assignedAgentId, role: "worker", status: "queued", contract: { agentId: task.assignedAgentId, taskIds: [task.taskId], scope: { allowedPaths: ["fixture/**"], deniedPaths: [".git/**"] }, budget: { maxUsd: Math.max(0.01, budgetUsd / workers), softLimitUsd: Math.max(0.01, budgetUsd / workers), maxIterations: 1, maxTokens: 100 }, maxWallClockMs: SWARM_CHILD_MAX_WALL_CLOCK_MS, permissions: { networkDomains: [], commands: ["echo verify"] }, approvalPolicy: {}, verifierAuthority: "child_only" } }));
  const plan = contracts.createSwarmLivePlan({
    planId: `plan-${swarmId}`, swarmId, workspaceId: `workspace-${swarmId}`, projectId: `project-${swarmId}`, baselineCommit: workspaceSourceSha,
    parentContract: { policyVersion: "swarm-policy-v1", objective: swarmId, definitionOfDone: ["verified"], budget: { maxUsd: budgetUsd, softLimitUsd: budgetUsd, maxIterations: workers + 1, maxTokens: workers * 100 }, maxWallClockMs: resolveSwarmDeadlineMs({ agents: workers, maxConcurrency }), maxConcurrency, scope: { allowedPaths: ["fixture/**"], deniedPaths: [".git/**"] }, permissions: { networkDomains: [], commands: ["echo verify"] }, integrationStrategy: "parent_fan_in", globalVerifierStack: [{ command: "echo verify", type: "custom" }], stopPolicy: { budgetExhausted: "stop", blockingFailure: "needs_review", verifierFailure: "stop" }, recoveryPolicy: { maxReassignmentsPerTask: 0, dependencyWaiversAllowed: false }, approvalPolicy: {}, orchestrationStrategy: "hierarchical_dag" },
    tasks, agents, engine: { engine: "codex", model: "gpt-6.1-sol" }, childMaxIterations: 1, createdAt: new Date().toISOString(),
  });
  process.env.MARTIN_INTEGRITY_KEY_DIR = integrityRoot;
  await seedKey(integrityRoot, runsRoot, `swarm-${swarmId}.key`, `parent-${swarmId}`);
  const result = await liveRuntime.runProductionLiveSwarm({
    plan, canonicalRoot: repositoryRoot, ownedRoot: join(runsRoot, "_swarms", swarmId, "worktrees"), storeRoot: runsRoot, runsRoot,
    adapterFactory: ({ agent, childRunId }) => ({
      declaredPaths: [`fixture/${agent.agentId.replace(`${name}-agent-`, "agent-")}.txt`],
      adapter: {
        adapterId: "agent-cli:codex", kind: "agent-cli", label: "production persisted-store fixture", metadata: { providerId: "codex", model: "gpt-6.1-sol", capabilities: { workspaceMutations: true } },
        async execute(request) {
          await seedKey(integrityRoot, runsRoot, `${childRunId}.key`, `child-${childRunId}`);
          const index = agent.agentId.replace(`${name}-agent-`, "");
          await delay(delayMsByIndex?.[Number(index)] ?? 0);
          await writeFile(join(request.context.repoRoot, "fixture", `agent-${index}.txt`), "after\n", "utf8");
          const settledAt = new Date().toISOString();
          return {
            status: "completed", summary: "provider completed", usage: { actualUsd: usageUsdByIndex?.[Number(index)] ?? 0.01, tokensIn: 2, tokensOut: 3, provenance: "calculated", providerSettlement: { providerId: "codex", model: "gpt-6.1-sol", transport: "cli", source: "codex_jsonl", inputTokens: 2, outputTokens: 3, pricingSource: "static_catalog", pricingVersion: "fixture", rawUsageAvailable: true, settledAt } },
            execution: { changedFiles: [`fixture/agent-${index}.txt`] },
            verification: { passed: true, summary: "verified", binding: { runId: request.loopId, workspaceId: request.workspaceId, attemptId: request.attemptId, cwd: request.context.repoRoot, runsRoot: request.context.runsRoot, executionProfile: request.context.executionProfile, allowedNetworkDomains: request.context.allowedNetworkDomains, commands: request.context.verificationPlan }, steps: [{ command: "echo verify", launched: true, completed: true, crashed: false, exitCode: 0, timedOut: false }] },
          };
        },
      },
    }),
    verifierExecutor: { async execute(request) { return { passed: verifierPass, processCloseState: "closed", binding: { swarmId: request.swarmId, workspaceId: request.workspaceId, cwd: request.cwd, parentPolicyVersion: request.parentPolicyVersion, baselineCommit: request.baselineCommit, integratedTreeHash: request.integratedTreeHash, commands: request.commands.map((item) => item.command) }, subprocessResults: request.commands.map((item) => ({ command: item.command, launched: true, completed: true, timedOut: false, exitCode: verifierPass ? 0 : 1, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() })) }; } },
  });
  if (verifierPass ? result.outcome.state !== "verified" : result.outcome.state !== "needs_review") throw new Error(`production fixture outcome mismatch: ${JSON.stringify(result.outcome)}`);
  const projection = await core.readSwarmReceiptProjection({ runsRoot, swarmId });
  const dossier = await core.readSwarmDossier({ runsRoot, swarmId });
  const verification = await core.verifySwarmEvidence({ runsRoot, swarmId });
  const parent = projection.receipt;
  const budget = { capUsd: parent.budgetLedger.capUsd, settledUsd: parent.budgetLedger.settledUsd, settledTokens: parent.budgetLedger.settledTokens };
  const mirrors = { receipt: parent, ledger: parent.budgetLedger, dossier, integrity: projection.integrity, verifier: verification, budget };
  const artifacts = [];
  for (const [kind, value] of Object.entries(mirrors)) {
    const path = join(submittedRoot, `${name}-${kind}.json`); const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    await writeFile(path, bytes); artifacts.push({ kind, path, sha256: digest(bytes) });
  }
  const children = [];
  for (const [childIndex, child] of parent.childReceipts.entries()) {
    const loop = JSON.parse(await readFile(join(runsRoot, child.childRunId, "loop-record.json"), "utf8"));
    const started = parent.events.find((event) => event.type === "CHILD_STARTED" && event.childRunId === child.childRunId);
    children.push({ childRunId: child.childRunId, agentId: child.agentId, attemptId: child.attemptId, taskIds: child.taskIds, workspaceId: started.payload.workspaceId, workingDirectory: loop.receiptScope.workingDirectory, candidateSourceSha: null, workspaceSourceSha, adapterId: "agent-cli:codex", providerId: "codex", model: "gpt-6.1-sol", transport: "cli", providerProcessId: 10_000 + childIndex, launchedAt: started.timestamp, completedAt: parent.events.find((event) => event.type === "CHILD_VERIFIED" && event.childRunId === child.childRunId).timestamp, verificationId: parent.globalVerificationId, receiptIntegritySha256: child.receiptIntegritySha256, actualUsd: loop.cost.actualUsd, actualTokens: loop.cost.tokensIn + loop.cost.tokensOut });
  }
  return { name, workers, maxConcurrency, budgetUsd, maxWallClockMs: resolveSwarmDeadlineMs({ agents: workers, maxConcurrency }), swarmId, runsRoot, workspaceSourceSha, parent, artifacts, children, accounting: budget };
}

export async function writeLiveSwarmTrustedDocuments({ root, runs, sourceSha, sourceTree }) {
  const trustRoot = join(root, "trust"); await mkdir(trustRoot, { recursive: true });
  const generatedBuildPath = resolve(ROOT, ".martin/generated/candidate-build.json");
  const buildBytes = await readFile(generatedBuildPath); const build = JSON.parse(buildBytes);
  if (build.sourceSha !== sourceSha || build.sourceTree !== sourceTree) throw new Error("canonical build manifest is stale for the test candidate");
  await writeFile(join(trustRoot, "candidate-build-manifest.json"), buildBytes);
  const packageJson = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
  const cliPath = build.cliEntrypoint.path;
  const limits = runs.map(({ name, workers, maxConcurrency, budgetUsd, maxWallClockMs }) => ({ name, agents: workers, maxConcurrency, budgetUsd, maxWallClockMs }));
  const authorization = { schemaVersion: "martin.live-swarm.external-authorization.v1", decision: "AUTHORIZED", approvalId: "live-swarm-test-approval", approvedBy: "external-test-reviewer", approvedAt: new Date().toISOString(), sourceSha, sourceTree, packageVersion: packageJson.version, maxCombinedUsd: 15, runs: limits, buildManifestSha256: digest(buildBytes), cliEntrypointPath: cliPath, cliEntrypointSha256: build.cliEntrypoint.sha256 };
  await writeFile(join(trustRoot, "live-swarm-authorization.json"), `${JSON.stringify(authorization, null, 2)}\n`);
  for (const run of runs) {
    for (const child of run.children) child.candidateSourceSha = sourceSha;
    const capture = { schemaVersion: "martin.live-swarm.trusted-capture.v1", approvalId: authorization.approvalId, runName: run.name, sourceSha, sourceTree, workspaceSourceSha: run.workspaceSourceSha, executionMode: "governed", startedAt: run.parent.events[0].timestamp, completedAt: run.parent.sealedAt, exitCode: 0, process: { launched: true, completed: true, pid: run.workers === 3 ? 3003 : 15_015, stdoutSha256: digest(Buffer.from(`${run.name}:stdout`)), stderrSha256: digest(Buffer.from(`${run.name}:stderr`)) }, argv: ["demo", "--swarm", "--live", "--engine", "codex", "--agents", String(run.workers), "--max-concurrency", String(run.maxConcurrency), "--budget-usd", String(run.budgetUsd)], executable: { path: cliPath, sha256: build.cliEntrypoint.sha256, version: packageJson.version }, runsRoot: run.runsRoot, swarmId: run.swarmId, model: "gpt-6.1-sol", children: run.children, accounting: { settledUsd: run.accounting.settledUsd, settledTokens: run.accounting.settledTokens } };
    await writeFile(join(trustRoot, `live-swarm-${run.name}-capture.json`), `${JSON.stringify(capture, null, 2)}\n`);
  }
  return { trustRoot, build, authorization };
}

export function qualificationReceipt({ runs, sourceSha, cliPath, cliSha256, version }) {
  return { schemaVersion: "martin.live-swarm.qualification.v1", status: "PASS", generatedAt: new Date().toISOString(), source: { sha: sourceSha }, binary: { path: cliPath, sha256: cliSha256, version }, capability: { authStatus: "PASS", preflightStatus: "PASS" }, approval: { approved: true, maxCombinedUsd: 15 }, runs: runs.map((run) => ({ name: run.name, agents: run.workers, maxConcurrency: run.maxConcurrency, budgetUsd: run.budgetUsd, maxWallClockMs: resolveSwarmDeadlineMs({ agents: run.workers, maxConcurrency: run.maxConcurrency }), simulationFallbackCalls: 0, command: `martin demo --swarm --live --engine codex --agents ${run.workers} --max-concurrency ${run.maxConcurrency} --budget-usd ${run.budgetUsd}`, argv: ["demo", "--swarm", "--live", "--engine", "codex", "--agents", String(run.workers), "--max-concurrency", String(run.maxConcurrency), "--budget-usd", String(run.budgetUsd)], swarmId: run.swarmId, exitCode: 0, evidence: { runsRoot: run.runsRoot, swarmId: run.swarmId, artifacts: run.artifacts } })), zeroFallbackPolicy: "live failures exit nonzero; simulation is never invoked" };
}

async function seedKey(root, runsRoot, name, secret) { const dir = join(root, digest(Buffer.from(runsRoot)).slice(0, 16)); await mkdir(dir, { recursive: true }); await writeFile(join(dir, name), `${secret}\n`); }
async function git(cwd, args) { return (await execFileAsync("git", args, { cwd, windowsHide: true })).stdout; }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
