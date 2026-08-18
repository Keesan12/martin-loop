import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLoopRecord } from "@martin/contracts";
import type { TerminationEnvelopeV1 } from "@martin/contracts";
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
          tokensOut: 50,
          provenance: "calculated"
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
      expect(dossier.cost.provenance).toBe("calculated");
      expect(workspaceRoot).not.toBe(process.cwd());
    });
  });

  it("surfaces terminationEnvelope from a persisted loop record with wall_clock exit", { timeout: 20_000 }, async () => {
    await withRunsAndWorkspace(async ({ runsRoot }) => {
      const envelope: TerminationEnvelopeV1 = {
        schemaVersion: "termination/1",
        class: "operational_exit",
        exit: {
          schemaVersion: "exit_evaluation/1",
          policyVersion: "exit_policy/1",
          shouldExit: true,
          primary: "wall_clock",
          matched: ["wall_clock"],
          phase: "attempt_completed",
          evaluatedAt: "2026-07-30T00:00:00.000Z",
          matches: [
            {
              kind: "wall_clock",
              fired: true,
              reason: "Wall-clock limit reached (3600s).",
              evidence: {}
            }
          ]
        }
      };

      const loop = createLoopRecord({
        workspaceId: "ws_d5_mcp",
        projectId: "proj_d5_mcp",
        task: {
          title: "D5 MCP surface proof",
          objective: "Prove terminationEnvelope survives through MCP dossier tool.",
          verificationPlan: ["vitest run"]
        },
        terminationEnvelope: envelope
      });

      // Stamp the lifecycle state to match a wall_clock exit
      const terminatedLoop = {
        ...loop,
        status: "exited" as const,
        lifecycleState: "wall_clock" as const
      };

      await mkdir(join(runsRoot, terminatedLoop.loopId), { recursive: true });
      await writeFile(
        join(runsRoot, terminatedLoop.loopId, "loop-record.json"),
        JSON.stringify(terminatedLoop),
        "utf8"
      );

      const dossier = await martinRunDossierTool({
        loopId: terminatedLoop.loopId,
        runsDir: runsRoot
      });

      // MCP surface proof: termination identity must be present and correct
      expect(dossier.terminationEnvelope).toBeDefined();
      expect(dossier.terminationEnvelope?.class).toBe("operational_exit");
      expect(dossier.terminationEnvelope?.exit.primary).toBe("wall_clock");
      expect(dossier.loop.lifecycleState).toBe("wall_clock");
      expect(dossier.loop.loopId).toBe(terminatedLoop.loopId);
    });
  });
});
