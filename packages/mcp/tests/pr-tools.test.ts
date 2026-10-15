import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLoopRecord } from "@martin/contracts";

import { martinCreatePrTool } from "../src/tools/pr-tools.js";

const scratch: string[] = [];
const originalWorkspaceRoot = process.env.MARTIN_MCP_WORKSPACE_ROOT;
const originalRunsDir = process.env.MARTIN_RUNS_DIR;

afterEach(async () => {
  if (originalWorkspaceRoot === undefined) delete process.env.MARTIN_MCP_WORKSPACE_ROOT;
  else process.env.MARTIN_MCP_WORKSPACE_ROOT = originalWorkspaceRoot;
  if (originalRunsDir === undefined) delete process.env.MARTIN_RUNS_DIR;
  else process.env.MARTIN_RUNS_DIR = originalRunsDir;
  for (const directory of scratch.splice(0)) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});

async function writeFailedRun(): Promise<{ runsDir: string; loopId: string }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "martin-pr-tools-"));
  scratch.push(workspace);
  process.env.MARTIN_MCP_WORKSPACE_ROOT = workspace;
  const runsDir = path.join(workspace, "runs");
  process.env.MARTIN_RUNS_DIR = runsDir;
  const repoRoot = path.join(workspace, "repo");
  await mkdir(repoRoot, { recursive: true });
  const loopId = "loop_pr_not_verified";
  await mkdir(path.join(runsDir, loopId), { recursive: true });
  const loop = {
    ...createLoopRecord({
      workspaceId: "ws_pr",
      projectId: "proj_pr",
      task: { title: "Unverified change", objective: "Unverified change", verificationPlan: ["npm test"], repoRoot }
    }),
    loopId,
    status: "failed",
    lifecycleState: "failed"
  };
  await writeFile(path.join(runsDir, loopId, "loop-record.json"), `${JSON.stringify(loop, null, 2)}
`, "utf8");
  return { runsDir, loopId };
}

describe("martin_create_pr", () => {
  it("previews the PR for any run without creating it", async () => {
    const { runsDir, loopId } = await writeFailedRun();
    const preview = await martinCreatePrTool({ loopId, runsDir, execute: false, title: "Custom title" });

    expect(preview.created).toBe(false);
    expect(preview.execute).toBe(false);
    expect(preview.title).toBe("Custom title");
  });

  it("refuses to open a PR for a run that is not VERIFIED", async () => {
    const { runsDir, loopId } = await writeFailedRun();

    await expect(martinCreatePrTool({ loopId, runsDir, execute: true, base: "main" })).rejects.toMatchObject({
      code: "policy_blocked",
      category: "policy_blocked"
    });
  });
});
