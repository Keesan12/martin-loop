import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLoopRecord, type LoopRecord } from "@martin/contracts";
import { describe, expect, it } from "vitest";

import { executeCli } from "../src/index.js";
import { deriveWorkspaceId } from "../src/workflow-state.js";

// `runs list` / `runs get --latest` filter to the workspace derived from the current directory.
// Run from a parent folder, a populated store must explain that the results are scoped.

function makeLoop(workingDirectory: string, title: string): LoopRecord {
  return createLoopRecord({
    workspaceId: deriveWorkspaceId(workingDirectory),
    projectId: "proj_discovery",
    task: { title, objective: title, verificationPlan: ["npm test"] },
    budget: { maxUsd: 1, softLimitUsd: 0.5, maxIterations: 1, maxTokens: 1000 },
  });
}

async function withStore<T>(fn: (runsRoot: string, loop: LoopRecord) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "martin-runs-discovery-"));
  const runsRoot = join(root, "runs");
  const loop = makeLoop(join(root, "sibling-project"), "Sibling project run");
  try {
    await mkdir(join(runsRoot, loop.loopId), { recursive: true });
    await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop, null, 2), "utf8");
    return await fn(runsRoot, loop);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

describe("persisted run discovery scope", () => {
  it("keeps the current-workspace default and explains loops held for other workspaces", async () => {
    await withStore(async (runsRoot) => {
      const result = await executeCli(["runs", "list", "--runs-dir", runsRoot, "--json"]);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;

      expect(payload).toMatchObject({
        command: "runs_list",
        count: 0,
        scope: { workspaceId: deriveWorkspaceId(process.cwd()), allWorkspaces: false },
        otherWorkspaceLoopCount: 1,
      });
      expect(JSON.stringify(payload["warnings"])).toMatch(/--all-workspaces/u);
    });
  });

  it("lists every workspace in the store only when --all-workspaces is passed", async () => {
    await withStore(async (runsRoot, loop) => {
      const payload = JSON.parse(
        (await executeCli(["runs", "list", "--runs-dir", runsRoot, "--all-workspaces", "--json"])).stdout
      ) as { count: number; loops: Array<{ loopId: string }>; scope: Record<string, unknown> };

      expect(payload.count).toBe(1);
      expect(payload.loops[0]?.loopId).toBe(loop.loopId);
      expect(payload.scope).toMatchObject({ allWorkspaces: true });
    });
  });

  it("explains other-workspace loops when runs get --latest finds none in scope", async () => {
    await withStore(async (runsRoot, loop) => {
      const missing = await executeCli(["runs", "get", "--latest", "--runs-dir", runsRoot, "--json"]);
      expect(missing.exitCode).not.toBe(0);
      expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, category: "not_found" });
      expect(missing.stdout).toMatch(/1 persisted loop.*other workspace/u);
      expect(missing.stdout).toMatch(/--all-workspaces/u);

      const found = JSON.parse(
        (await executeCli(["runs", "get", "--latest", "--runs-dir", runsRoot, "--all-workspaces", "--json"])).stdout
      ) as Record<string, unknown>;
      expect(JSON.stringify(found)).toContain(loop.loopId);
    });
  });
});
