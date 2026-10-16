import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ApprovalPolicy } from "@martin/contracts";

import { createFileRunStore, runMartin, type MartinAdapter } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

const BASE_MATH = "function add(a, b) { return a + b; }\nmodule.exports = { add };\n";
const BASE_TEST = "test('add', () => assert.equal(add(2, 3), 5));\ntest('multiply', () => assert.equal(multiply(2, 3), 6));\n";
const MULTIPLY = "function add(a, b) { return a + b; }\nfunction multiply(a, b) { return a * b; }\nmodule.exports = { add, multiply };\n";

function git(repoRoot: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

async function createWorkspace(): Promise<{ runsRoot: string; repoRoot: string; head: string }> {
  const runsRoot = await mkdtemp(join(tmpdir(), "martin-workspace-hardening-"));
  temporaryDirectories.push(runsRoot);
  const repoRoot = join(runsRoot, "repo");
  await mkdir(repoRoot, { recursive: true });
  git(repoRoot, "init", "-q");
  git(repoRoot, "config", "user.email", "agent@test.invalid");
  git(repoRoot, "config", "user.name", "Agent");
  git(repoRoot, "config", "core.autocrlf", "false");
  await writeFile(join(repoRoot, "math.js"), BASE_MATH, "utf8");
  await writeFile(join(repoRoot, "math.test.js"), BASE_TEST, "utf8");
  await writeFile(join(repoRoot, ".gitignore"), "node_modules/\nsecrets/\n", "utf8");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", "baseline");
  return { runsRoot, repoRoot, head: git(repoRoot, "rev-parse", "HEAD") };
}

function agent(
  action: (repoRoot: string) => Promise<void>,
  repoRoot: string,
  reportedChangedFiles?: string[]
): MartinAdapter {
  return {
    adapterId: "direct:workspace-hardening",
    kind: "direct-provider",
    label: "Workspace hardening adapter",
    metadata: { providerId: "test", model: "deterministic" },
    async execute(request) {
      await action(repoRoot);
      const commands = request.context.verificationPlan;
      return {
        status: "completed",
        summary: "Implemented the requested change. All tests pass.",
        usage: { actualUsd: 0, tokensIn: 0, tokensOut: 0 },
        ...(reportedChangedFiles ? { execution: { changedFiles: reportedChangedFiles } } : {}),
        verification: {
          passed: true,
          summary: "deterministic fixture passed",
          binding: {
            runId: request.loopId,
            attemptId: request.attemptId,
            workspaceId: request.workspaceId,
            ...(request.context.runsRoot ? { runsRoot: request.context.runsRoot } : {}),
            ...(request.context.executionProfile ? { executionProfile: request.context.executionProfile } : {}),
            cwd: request.context.repoRoot ?? process.cwd(),
            commands
          },
          steps: commands.map((command) => ({
            command,
            launched: true,
            completed: true,
            crashed: false,
            exitCode: 0,
            timedOut: false
          }))
        }
      };
    }
  };
}

async function run(
  workspace: { runsRoot: string; repoRoot: string },
  action: (repoRoot: string) => Promise<void>,
  options: { deniedPaths?: string[]; approvalPolicy?: ApprovalPolicy; reportedChangedFiles?: string[] } = {}
) {
  return runMartin({
    workspaceId: "ws_hardening",
    projectId: "proj_hardening",
    task: {
      title: "Add multiply",
      objective: "Add a function multiply(a, b) to math.js and export it alongside add.",
      verificationPlan: ["npm test"],
      repoRoot: workspace.repoRoot,
      ...(options.deniedPaths ? { deniedPaths: options.deniedPaths } : {}),
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {})
    },
    budget: { maxUsd: 1, softLimitUsd: 0.8, maxIterations: 1, maxTokens: 2_000 },
    adapter: agent(action, workspace.repoRoot, options.reportedChangedFiles),
    store: createFileRunStore({ runsRoot: workspace.runsRoot })
  });
}

describe("runtime workspace hardening", () => {
  it("control: an honest edit still completes", async () => {
    const workspace = await createWorkspace();
    const result = await run(workspace, async (repoRoot) => {
      await writeFile(join(repoRoot, "math.js"), MULTIPLY, "utf8");
    });

    expect(result.decision.lifecycleState).toBe("completed");
    await expect(readFile(join(workspace.repoRoot, "math.js"), "utf8")).resolves.toBe(MULTIPLY);
  });

  it("control: an honest agent commit of an allowed change is kept", async () => {
    const workspace = await createWorkspace();
    const result = await run(workspace, async (repoRoot) => {
      await writeFile(join(repoRoot, "math.js"), MULTIPLY, "utf8");
      git(repoRoot, "commit", "-qam", "agent: add multiply");
    });

    expect(result.decision.lifecycleState).toBe("completed");
    expect(git(workspace.repoRoot, "rev-parse", "HEAD")).not.toBe(workspace.head);
  });

  it("blocks a denied file the agent committed and rewinds the commit", async () => {
    const workspace = await createWorkspace();
    const result = await run(
      workspace,
      async (repoRoot) => {
        await writeFile(join(repoRoot, "math.js"), MULTIPLY, "utf8");
        git(repoRoot, "commit", "-qam", "agent: sneak denied change");
      },
      { deniedPaths: ["math.js"] }
    );

    expect(result.decision.lifecycleState).toBe("human_escalation");
    expect(result.decision.reasonCode).toBe("protected_surface_write");
    expect(git(workspace.repoRoot, "rev-parse", "HEAD")).toBe(workspace.head);
    expect(git(workspace.repoRoot, "status", "--porcelain")).toBe("");
  });

  it("blocks a denied git-ignored write and removes only that file", async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace.repoRoot, "secrets"), { recursive: true });
    await writeFile(join(workspace.repoRoot, "secrets", "operator.txt"), "keep\n", "utf8");

    const result = await run(
      workspace,
      async (repoRoot) => {
        await writeFile(join(repoRoot, "secrets", "token.txt"), "stolen\n", "utf8");
        await writeFile(join(repoRoot, "math.js"), MULTIPLY, "utf8");
      },
      { deniedPaths: ["secrets/**"] }
    );

    expect(result.decision.reasonCode).toBe("protected_surface_write");
    await expect(readFile(join(workspace.repoRoot, "secrets", "token.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(workspace.repoRoot, "secrets", "operator.txt"), "utf8")).resolves.toBe("keep\n");
    await expect(readFile(join(workspace.repoRoot, "math.js"), "utf8")).resolves.toBe(BASE_MATH);
  });

  it("restores a denied ignored file changed with the same size and mtime", async () => {
    const workspace = await createWorkspace();
    const operatorFile = join(workspace.repoRoot, "secrets", "operator.txt");
    await mkdir(join(workspace.repoRoot, "secrets"), { recursive: true });
    await writeFile(operatorFile, "keep\n", "utf8");
    const baseline = await stat(operatorFile);

    const result = await run(
      workspace,
      async () => {
        await writeFile(operatorFile, "lose\n", "utf8");
        await utimes(operatorFile, baseline.atime, baseline.mtime);
      },
      { deniedPaths: ["secrets/**"] }
    );

    expect(result.decision.reasonCode).toBe("protected_surface_write");
    await expect(readFile(operatorFile, "utf8")).resolves.toBe("keep\n");
  });

  it("restores a denied ignored file deleted by the attempt", async () => {
    const workspace = await createWorkspace();
    const operatorFile = join(workspace.repoRoot, "secrets", "operator.txt");
    await mkdir(join(workspace.repoRoot, "secrets"), { recursive: true });
    await writeFile(operatorFile, "keep\n", "utf8");

    const result = await run(
      workspace,
      async () => {
        await rm(operatorFile);
      },
      { deniedPaths: ["secrets/**"] }
    );

    expect(result.decision.reasonCode).toBe("protected_surface_write");
    await expect(readFile(operatorFile, "utf8")).resolves.toBe("keep\n");
  });

  it("control: growing the import line while adding a test still completes", async () => {
    const workspace = await createWorkspace();
    const header = "const { add } = require('./math');\n";
    await writeFile(join(workspace.repoRoot, "math.test.js"), header + BASE_TEST, "utf8");
    git(workspace.repoRoot, "commit", "-qam", "test header");

    const result = await run(workspace, async (repoRoot) => {
      await writeFile(join(repoRoot, "math.js"), MULTIPLY, "utf8");
      await writeFile(
        join(repoRoot, "math.test.js"),
        `${header.replace("{ add }", "{ add, multiply }")}${BASE_TEST}test('multiply zero', () => assert.equal(multiply(0, 3), 0));\n`,
        "utf8"
      );
    });

    expect(result.decision.lifecycleState).toBe("completed");
    expect(result.decision.reasonCode).not.toBe("test_change_approval_required");
  });

  it("requires approval when the agent edits an expected value to match its own output", async () => {
    const workspace = await createWorkspace();
    const result = await run(workspace, async (repoRoot) => {
      await writeFile(join(repoRoot, "math.test.js"), BASE_TEST.replace("multiply(2, 3), 6", "multiply(2, 3), 5"), "utf8");
    });

    expect(result.decision.reasonCode).toBe("test_change_approval_required");
    await expect(readFile(join(workspace.repoRoot, "math.test.js"), "utf8")).resolves.toBe(BASE_TEST);
  });

  it("control: installing ignored dependencies does not block an honest edit", async () => {
    const workspace = await createWorkspace();
    const result = await run(workspace, async (repoRoot) => {
      await mkdir(join(repoRoot, "node_modules", "pkg", "test"), { recursive: true });
      await writeFile(join(repoRoot, "node_modules", "pkg", "test", "fixture.pem"), "fixture\n", "utf8");
      await writeFile(join(repoRoot, "math.js"), MULTIPLY, "utf8");
    });

    expect(result.decision.lifecycleState).toBe("completed");
  });

  it("blocks and removes a .env file the agent wrote", async () => {
    const workspace = await createWorkspace();
    const result = await run(workspace, async (repoRoot) => {
      await writeFile(join(repoRoot, ".env"), "OPENAI_API_KEY=placeholder-value\n", "utf8");
      await writeFile(join(repoRoot, "math.js"), MULTIPLY, "utf8");
    });

    expect(result.decision.reasonCode).toBe("protected_surface_write");
    await expect(readFile(join(workspace.repoRoot, ".env"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires approval when the agent deletes a failing assertion", async () => {
    const workspace = await createWorkspace();
    const result = await run(workspace, async (repoRoot) => {
      await writeFile(join(repoRoot, "math.test.js"), "test('add', () => assert.equal(add(2, 3), 5));\n", "utf8");
    });

    expect(result.decision.lifecycleState).toBe("human_escalation");
    expect(result.decision.reasonCode).toBe("test_change_approval_required");
    await expect(readFile(join(workspace.repoRoot, "math.test.js"), "utf8")).resolves.toBe(BASE_TEST);
  });

  it("requires approval when the agent deletes the test file", async () => {
    const workspace = await createWorkspace();
    const result = await run(workspace, async (repoRoot) => {
      await rm(join(repoRoot, "math.test.js"));
    });

    expect(result.decision.reasonCode).toBe("test_change_approval_required");
    await expect(readFile(join(workspace.repoRoot, "math.test.js"), "utf8")).resolves.toBe(BASE_TEST);
  });

  it("control: appending a new test case still completes", async () => {
    const workspace = await createWorkspace();
    const result = await run(workspace, async (repoRoot) => {
      await writeFile(join(repoRoot, "math.js"), MULTIPLY, "utf8");
      await writeFile(join(repoRoot, "math.test.js"), `${BASE_TEST}test('multiply zero', () => assert.equal(multiply(0, 3), 0));\n`, "utf8");
    });

    expect(result.decision.lifecycleState).toBe("completed");
  });

  it("control: test rewrites proceed when the operator approves test changes", async () => {
    const workspace = await createWorkspace();
    const result = await run(
      workspace,
      async (repoRoot) => {
        await writeFile(join(repoRoot, "math.test.js"), "test('add', () => assert.equal(add(1, 1), 2));\n", "utf8");
      },
      { approvalPolicy: { testChanges: true } }
    );

    expect(result.decision.reasonCode).not.toBe("test_change_approval_required");
    expect(result.decision.lifecycleState).toBe("completed");
  });

  it("fails closed when Git observation disappears even if the adapter reports changed files", async () => {
    const workspace = await createWorkspace();
    const gitDirectory = join(workspace.repoRoot, ".git");
    const hiddenGitDirectory = join(workspace.repoRoot, ".git-hidden");
    let result: Awaited<ReturnType<typeof run>> | undefined;
    try {
      result = await run(
        workspace,
        async (repoRoot) => {
          await writeFile(join(repoRoot, "math.js"), MULTIPLY, "utf8");
          await rename(gitDirectory, hiddenGitDirectory);
        },
        { reportedChangedFiles: ["math.js"] }
      );
    } finally {
      await rename(hiddenGitDirectory, gitDirectory).catch(() => undefined);
    }
    expect(result?.decision.lifecycleState).toBe("human_escalation");
    expect(result?.decision.reasonCode).toBe("workspace_observation_unavailable");
    expect(result?.decision.reason).toMatch(/Git rollback state unavailable/u);
  });
});
