// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLoopRecord } from "@martin/contracts";
import { describe, expect, it } from "vitest";

import { martinRunDossierTool } from "../src/tools/run-dossier.js";

async function withRunsAndWorkspace<T>(
  fn: (input: { runsRoot: string; workspaceRoot: string }) => Promise<T>
): Promise<T> {
  const previousRunsRoot = process.env.MARTIN_RUNS_DIR;
  const previousWorkspaceRoot = process.env.MARTIN_MCP_WORKSPACE_ROOT;
  const runsRoot = await mkdtemp(join(tmpdir(), "martin-mcp-dossier-runs-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "martin-mcp-dossier-workspace-"));
  process.env.MARTIN_RUNS_DIR = runsRoot;
  process.env.MARTIN_MCP_WORKSPACE_ROOT = workspaceRoot;

  try {
    return await fn({ runsRoot, workspaceRoot });
  } finally {
    if (previousRunsRoot === undefined) {
      delete process.env.MARTIN_RUNS_DIR;
    } else {
      process.env.MARTIN_RUNS_DIR = previousRunsRoot;
    }

    if (previousWorkspaceRoot === undefined) {
      delete process.env.MARTIN_MCP_WORKSPACE_ROOT;
    } else {
      process.env.MARTIN_MCP_WORKSPACE_ROOT = previousWorkspaceRoot;
    }

    await rm(runsRoot, { recursive: true, force: true }).catch(() => {});
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
  }
}

describe("martinRunDossierTool", () => {
  it("uses the trusted workspace root when a run record omits repoRoot", { timeout: 20_000 }, async () => {
    await withRunsAndWorkspace(async ({ runsRoot, workspaceRoot }) => {
      const loop = createLoopRecord({
        loopId: "loop_workspace_fallback",
        workspaceId: "ws_test",
        projectId: "proj_test",
        task: {
          title: "Inspect dossier workspace boundary",
          objective: "Review the latest public trust lane",
          allowedPaths: ["**"],
          verificationPlan: ["pnpm test"]
        },
        budget: {
          maxUsd: 5,
          softLimitUsd: 3,
          maxIterations: 2,
          maxTokens: 2000
        },
        cost: {
          actualUsd: 1.25,
          avoidedUsd: 0,
          tokensIn: 100,
          tokensOut: 50
        }
      });

      await mkdir(join(runsRoot, loop.loopId), { recursive: true });
      await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");

      const dossier = await martinRunDossierTool({
        loopId: loop.loopId,
        runsDir: runsRoot
      });

      expect(dossier.review.risk.reasons).not.toContain(
        "Wide edit scope overlaps with sensitive repo areas."
      );
      expect(dossier.evaluation.warnings).not.toContain(
        "Wide edit scope overlaps with sensitive repo areas."
      );
      expect(dossier.inspection.runsRoot).toBe(runsRoot);
      expect(workspaceRoot).not.toBe(process.cwd());
    });
  });
});
