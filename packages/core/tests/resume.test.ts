import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLoopRecord, type LoopRecord } from "@martin/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  acquireRunExecutionLease,
  captureRollbackBoundary,
  createFileRunStore,
  evaluateRunResumability,
  loadResumeCandidateBoundary,
  loadResumeVerifierFailure,
  runMartin,
  type MartinAdapter
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("execution continuation", () => {
  it("continues the same persisted loop and preserves prior attempts", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-resume-"));
    temporaryDirectories.push(root);
    const runsRoot = join(root, "runs");

    const loop: LoopRecord = {
      ...createLoopRecord({
        loopId: "loop_resume_test",
        workspaceId: "ws_resume",
        projectId: "proj_resume",
        task: {
          title: "resume fixture",
          objective: "verify the persisted task",
          verificationPlan: ["node --version"],
          mutationMode: "read_only",
          definitionOfDonePreSatisfied: true
        },
        budget: { maxUsd: 1, softLimitUsd: 0.8, maxIterations: 3 }
      }),
      status: "running",
      lifecycleState: "running",
      attempts: [
        {
          attemptId: "att_prior",
          index: 1,
          adapterId: "agent-cli:claude",
          startedAt: "2026-10-22T00:00:00.000Z",
          completedAt: "2026-10-22T00:00:01.000Z",
          summary: "Prior attempt ended between retries.",
          verifierScore: 0
        }
      ]
    };

    const adapter: MartinAdapter = {
      adapterId: "agent-cli:claude",
      kind: "direct-provider",
      label: "resume-test",
      metadata: {
        providerId: "claude",
        model: "resume-test",
        capabilities: { workspaceMutations: false }
      },
      async execute(request) {
        return {
          status: "completed",
          summary: "Resumed verification passed.",
          usage: {
            actualUsd: 0.01,
            tokensIn: 10,
            tokensOut: 5,
            provenance: "actual"
          },
          verification: {
            passed: true,
            summary: "node version passed",
            binding: {
              runId: request.loopId,
              workspaceId: request.workspaceId,
              attemptId: request.attemptId,
              ...(request.context.runsRoot
                ? { runsRoot: request.context.runsRoot }
                : {}),
              cwd: request.context.repoRoot ?? process.cwd(),
              commands: request.context.verificationPlan
            },
            steps: [
              {
                command: "node --version",
                launched: true,
                completed: true,
                crashed: false,
                exitCode: 0,
                timedOut: false
              }
            ]
          }
        };
      }
    };

    const result = await runMartin({
      workspaceId: loop.workspaceId,
      projectId: loop.projectId,
      task: loop.task,
      budget: loop.budget,
      adapter,
      store: createFileRunStore({ runsRoot }),
      resume: { loop }
    });

    expect(result.loop.loopId).toBe("loop_resume_test");
    expect(result.loop.attempts).toHaveLength(2);
    expect(result.loop.attempts[0]?.attemptId).toBe("att_prior");
    expect(result.loop.status).toBe("completed");
    expect(result.loop.lifecycleState).toBe("completed");
  });

  it("recovers a persisted retained candidate after process disappearance and repairs it on the same run", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-resume-repair-"));
    temporaryDirectories.push(root);
    const repoRoot = join(root, "repo");
    const runsRoot = join(root, "runs");
    await mkdir(repoRoot, { recursive: true });

    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
      }
      return result.stdout.trim();
    };

    await writeFile(
      join(repoRoot, "target.js"),
      "module.exports = { value: 1 };\n",
      "utf8"
    );
    await writeFile(
      join(repoRoot, "verify.cjs"),
      [
        "const { value } = require('./target');",
        "if (value !== 3) {",
        "  console.error('expected value 3, got ' + value);",
        "  process.exit(1);",
        "}",
        "console.log('PASS');"
      ].join("\n") + "\n",
      "utf8"
    );
    git("init", "-q");
    git("config", "user.email", "resume@test.invalid");
    git("config", "user.name", "Resume Test");
    git("add", ".");
    git("commit", "-q", "-m", "baseline");

    const boundary = await captureRollbackBoundary({
      repoRoot,
      capturedAt: "2026-10-22T00:00:00.000Z"
    });
    expect(boundary).toBeDefined();

    // Attempt 1 happened in the previous process: safe partial candidate persisted,
    // verifier failed, and the process disappeared before attempt 2 was launched.
    await writeFile(
      join(repoRoot, "target.js"),
      "module.exports = { value: 2 };\n",
      "utf8"
    );
    const failedVerifier = spawnSync("node", ["verify.cjs"], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    expect(failedVerifier.status).toBe(1);

    const loop: LoopRecord = {
      ...createLoopRecord({
        loopId: "loop_resume_repair",
        workspaceId: "ws_resume_repair",
        projectId: "proj_resume_repair",
        task: {
          title: "repair persisted candidate",
          objective: "make target value equal 3",
          verificationPlan: ["node verify.cjs"],
          repoRoot,
          allowedPaths: ["target.js"],
          mutationMode: "edit",
          taskClass: "reversible_edit"
        },
        budget: { maxUsd: 2, softLimitUsd: 1.5, maxIterations: 3 }
      }),
      status: "running",
      lifecycleState: "running",
      attempts: [
        {
          attemptId: "att_persisted_1",
          index: 1,
          adapterId: "agent-cli:claude",
          startedAt: "2026-10-22T00:00:00.000Z",
          completedAt: "2026-10-22T00:00:01.000Z",
          summary: "Partial candidate persisted but verifier failed.",
          failureClass: "verification_failure",
          verifierScore: 0,
          failingVerifierStepCount: 1,
          candidateRetained: true
        }
      ],
      events: [
        {
          eventId: "evt_start",
          type: "attempt.started",
          timestamp: "2026-10-22T00:00:00.000Z",
          lifecycleState: "running",
          payload: { attemptId: "att_persisted_1" }
        },
        {
          eventId: "evt_done",
          type: "attempt.completed",
          timestamp: "2026-10-22T00:00:01.000Z",
          lifecycleState: "running",
          payload: { attemptId: "att_persisted_1", status: "completed" }
        }
      ]
    };

    const attemptDir = join(runsRoot, loop.loopId, "artifacts", "attempt-001");
    await mkdir(attemptDir, { recursive: true });
    await writeFile(
      join(attemptDir, "rollback-boundary.json"),
      `${JSON.stringify(boundary, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      join(attemptDir, "verification.json"),
      `${JSON.stringify({
        passed: false,
        summary: "verifier failed",
        binding: {
          runId: loop.loopId,
          workspaceId: loop.workspaceId,
          attemptId: "att_persisted_1",
          cwd: repoRoot,
          runsRoot,
          commands: ["node verify.cjs"]
        },
        steps: [{
          command: "node verify.cjs",
          launched: true,
          completed: true,
          crashed: false,
          exitCode: 1,
          timedOut: false,
          detail: failedVerifier.stderr
        }]
      }, null, 2)}\n`,
      "utf8"
    );

    const store = createFileRunStore({ runsRoot });
    await store.initRun({
      runId: loop.loopId,
      workspaceId: loop.workspaceId,
      projectId: loop.projectId,
      task: loop.task,
      budget: loop.budget,
      createdAt: loop.createdAt
    });
    await store.writeLoopRecord?.(loop.loopId, loop);

    const restoredBoundary = await loadResumeCandidateBoundary(runsRoot, loop);
    const restoredFailure = await loadResumeVerifierFailure(runsRoot, loop);
    expect(restoredBoundary).toBeDefined();
    expect(restoredFailure).toMatchObject({
      command: "node verify.cjs",
      exitCode: 1,
      attemptId: "att_persisted_1",
      attemptIndex: 1
    });

    let sawRetainedCandidate = false;
    let sawFailureContext = false;
    const adapter: MartinAdapter = {
      adapterId: "agent-cli:claude",
      kind: "direct-provider",
      label: "resume-repair",
      metadata: {
        providerId: "claude",
        model: "resume-repair",
        capabilities: { workspaceMutations: true }
      },
      async execute(request) {
        sawRetainedCandidate =
          request.context.previousCandidateRetained === true &&
          (await readFile(join(repoRoot, "target.js"), "utf8")).includes("value: 2");
        sawFailureContext =
          request.context.lastVerifierFailure?.attemptId === "att_persisted_1" &&
          request.context.lastVerifierFailure.failureExcerpt.includes("expected value 3");

        await writeFile(
          join(repoRoot, "target.js"),
          "module.exports = { value: 3 };\n",
          "utf8"
        );
        const verifier = spawnSync("node", ["verify.cjs"], {
          cwd: repoRoot,
          encoding: "utf8"
        });

        return {
          status: "completed",
          summary: "Repaired persisted candidate.",
          usage: {
            actualUsd: 0.02,
            tokensIn: 10,
            tokensOut: 10,
            provenance: "actual"
          },
          verification: {
            passed: verifier.status === 0,
            summary: verifier.status === 0 ? "verifier passed" : "verifier failed",
            binding: {
              runId: request.loopId,
              workspaceId: request.workspaceId,
              attemptId: request.attemptId,
              runsRoot: request.context.runsRoot!,
              cwd: repoRoot,
              commands: request.context.verificationPlan
            },
            steps: [{
              command: "node verify.cjs",
              launched: true,
              completed: true,
              crashed: false,
              exitCode: verifier.status ?? 1,
              timedOut: false,
              detail: [verifier.stdout, verifier.stderr].filter(Boolean).join("\n")
            }]
          },
          execution: { changedFiles: ["target.js"] }
        };
      }
    };

    const result = await runMartin({
      workspaceId: loop.workspaceId,
      projectId: loop.projectId,
      task: loop.task,
      budget: loop.budget,
      adapter,
      store,
      resume: {
        loop,
        ...(restoredBoundary ? { preCandidateBoundary: restoredBoundary } : {}),
        ...(restoredFailure ? { lastVerifierFailure: restoredFailure } : {})
      }
    });

    expect(sawRetainedCandidate).toBe(true);
    expect(sawFailureContext).toBe(true);
    expect(result.loop.loopId).toBe(loop.loopId);
    expect(result.loop.attempts).toHaveLength(2);
    expect(result.loop.status).toBe("completed");
    expect(result.loop.lifecycleState).toBe("completed");
    expect(await readFile(join(repoRoot, "target.js"), "utf8")).toContain("value: 3");
  });

  it("refuses irreversible or exhausted persisted runs", () => {
    const irreversible = createLoopRecord({
      loopId: "loop_irreversible",
      workspaceId: "ws",
      projectId: "proj",
      task: {
        title: "external write",
        objective: "deploy",
        verificationPlan: [],
        taskClass: "irreversible",
        approvalPolicy: { externalWrites: true }
      },
      budget: { maxUsd: 1, softLimitUsd: 0.8, maxIterations: 2 }
    });

    expect(evaluateRunResumability({ ...irreversible, status: "running", lifecycleState: "running" }))
      .toMatchObject({ allowed: false });

    const exhausted = {
      ...createLoopRecord({
        loopId: "loop_exhausted",
        workspaceId: "ws",
        projectId: "proj",
        task: { title: "task", objective: "task", verificationPlan: [] },
        budget: { maxUsd: 1, softLimitUsd: 0.8, maxIterations: 1 }
      }),
      status: "running" as const,
      lifecycleState: "running" as const,
      attempts: [
        {
          attemptId: "att_1",
          index: 1,
          adapterId: "agent-cli:claude",
          startedAt: "2026-10-22T00:00:00.000Z"
        }
      ]
    };
    expect(evaluateRunResumability(exhausted)).toMatchObject({ allowed: false });
  });

  it("switches only to an explicitly supplied fallback adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-fallback-"));
    temporaryDirectories.push(root);
    const runsRoot = join(root, "runs");

    const primary: MartinAdapter = {
      adapterId: "agent-cli:primary",
      kind: "direct-provider",
      label: "primary",
      metadata: { providerId: "primary", capabilities: { workspaceMutations: false } },
      async execute() {
        return {
          status: "failed",
          summary: "provider command not found",
          failure: { message: "command not found" },
          usage: { actualUsd: 0, tokensIn: 0, tokensOut: 0, provenance: "actual" },
          verification: {
            passed: false,
            summary: "provider never reached verification",
            steps: []
          }
        };
      }
    };
    const fallback: MartinAdapter = {
      adapterId: "agent-cli:fallback",
      kind: "direct-provider",
      label: "fallback",
      metadata: { providerId: "fallback", capabilities: { workspaceMutations: false } },
      async execute(request) {
        return {
          status: "completed",
          summary: "authorized fallback completed",
          usage: { actualUsd: 0.01, tokensIn: 5, tokensOut: 5, provenance: "actual" },
          verification: {
            passed: true,
            summary: "fallback verifier passed",
            binding: {
              runId: request.loopId,
              workspaceId: request.workspaceId,
              attemptId: request.attemptId,
              ...(request.context.runsRoot ? { runsRoot: request.context.runsRoot } : {}),
              cwd: request.context.repoRoot ?? process.cwd(),
              commands: request.context.verificationPlan
            },
            steps: [{
              command: "node --version",
              launched: true,
              completed: true,
              crashed: false,
              exitCode: 0,
              timedOut: false
            }]
          }
        };
      }
    };

    const result = await runMartin({
      workspaceId: "ws_fallback",
      projectId: "proj_fallback",
      task: {
        title: "fallback fixture",
        objective: "verify with an authorized fallback",
        verificationPlan: ["node --version"],
        mutationMode: "read_only",
        definitionOfDonePreSatisfied: true
      },
      budget: { maxUsd: 1, softLimitUsd: 0.8, maxIterations: 3 },
      adapter: primary,
      fallbackAdapters: [fallback],
      store: createFileRunStore({ runsRoot })
    });

    expect(result.loop.attempts).toHaveLength(2);
    expect(result.loop.attempts.map((attempt) => attempt.adapterId)).toEqual([
      "agent-cli:primary",
      "agent-cli:fallback"
    ]);
    expect(result.loop.lifecycleState).toBe("completed");
    expect(
      result.loop.events.some(
        (event) =>
          event.type === "intervention.selected" &&
          event.payload["intervention"] === "switch_adapter"
      )
    ).toBe(true);
  });

  it("enforces one live execution lease and reclaims it after release", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-lease-"));
    temporaryDirectories.push(root);

    const first = await acquireRunExecutionLease({
      runsRoot: root,
      runId: "loop_lease",
      owner: "first"
    });

    await expect(
      acquireRunExecutionLease({
        runsRoot: root,
        runId: "loop_lease",
        owner: "second"
      })
    ).rejects.toThrow(/already executing/iu);

    await first.release();

    const second = await acquireRunExecutionLease({
      runsRoot: root,
      runId: "loop_lease",
      owner: "second"
    });
    expect(second.lease.owner).toBe("second");
    await second.release();
  });
});
