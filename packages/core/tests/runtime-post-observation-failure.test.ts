import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

vi.mock("../src/rollback.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/rollback.js")>();
  return {
    ...actual,
    listIgnoredFileChangesSinceBoundary: () => {
      throw new Error("simulated ignored inventory observation failure");
    }
  };
});

import { createFileRunStore, runMartin, type MartinAdapter } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function git(repoRoot: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
}

it("fails closed and restores the workspace when a post-run observer throws", async () => {
  const root = await mkdtemp(join(tmpdir(), "martin-post-observation-"));
  temporaryDirectories.push(root);
  const repoRoot = join(root, "repo");
  const runsRoot = join(root, "runs");
  await mkdir(repoRoot, { recursive: true });
  git(repoRoot, "init", "-q");
  git(repoRoot, "config", "user.email", "observation@test.invalid");
  git(repoRoot, "config", "user.name", "Observation Test");
  git(repoRoot, "config", "core.autocrlf", "false");
  await writeFile(join(repoRoot, "tracked.txt"), "baseline\n", "utf8");
  git(repoRoot, "add", "tracked.txt");
  git(repoRoot, "commit", "-q", "-m", "baseline");

  const adapter: MartinAdapter = {
    adapterId: "direct:post-observation",
    kind: "direct-provider",
    label: "Post-observation fixture",
    metadata: { providerId: "test", model: "deterministic" },
    async execute(request) {
      await writeFile(join(repoRoot, "tracked.txt"), "attempt\n", "utf8");
      return {
        status: "completed",
        summary: "attempt completed",
        usage: { actualUsd: 0, tokensIn: 0, tokensOut: 0 },
        verification: {
          passed: true,
          summary: "fixture verifier passed",
          binding: {
            runId: request.loopId,
            attemptId: request.attemptId,
            workspaceId: request.workspaceId,
            cwd: repoRoot,
            commands: request.context.verificationPlan
          },
          steps: [{ command: "node --version", launched: true, completed: true, crashed: false, exitCode: 0, timedOut: false }]
        }
      };
    }
  };

  const result = await runMartin({
    workspaceId: "ws_post_observation",
    projectId: "proj_post_observation",
    task: { title: "Observe safely", objective: "Modify tracked.txt", verificationPlan: ["node --version"], repoRoot },
    budget: { maxUsd: 1, softLimitUsd: 0.8, maxIterations: 1, maxTokens: 1_000 },
    adapter,
    store: createFileRunStore({ runsRoot })
  });

  expect(result.decision.lifecycleState).toBe("human_escalation");
  expect(result.decision.reasonCode).toBe("workspace_observation_unavailable");
  expect(result.decision.reason).toContain("simulated ignored inventory observation failure");
  await expect(readFile(join(repoRoot, "tracked.txt"), "utf8")).resolves.toBe("baseline\n");
  const rollback = JSON.parse(
    await readFile(join(runsRoot, result.loop.loopId, "artifacts", "attempt-001", "rollback-outcome.json"), "utf8")
  ) as { status: string };
  expect(rollback.status).toBe("restored");
});
