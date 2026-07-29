// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLoopRecord } from "@martin/contracts";
import { describe, expect, it } from "vitest";

import { executeCli } from "../src/index.js";

async function withRunsRoot<T>(fn: (runsRoot: string) => Promise<T>): Promise<T> {
  const previousRunsRoot = process.env.MARTIN_RUNS_DIR;
  const runsRoot = await mkdtemp(join(tmpdir(), "martin-cli-trajectory-"));
  process.env.MARTIN_RUNS_DIR = runsRoot;

  try {
    return await fn(runsRoot);
  } finally {
    if (previousRunsRoot === undefined) {
      delete process.env.MARTIN_RUNS_DIR;
    } else {
      process.env.MARTIN_RUNS_DIR = previousRunsRoot;
    }

    await rm(runsRoot, { force: true, recursive: true }).catch(() => {});
  }
}

describe("CLI trajectory triage", () => {
  it("surfaces stalled trajectory findings in triage receipts", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = {
        ...createLoopRecord({
          workspaceId: "ws_ops",
          projectId: "proj_runtime",
          task: {
            title: "Repair runtime guard",
            objective: "Repair the runtime guard without touching release automation.",
            verificationPlan: ["pnpm --filter @martin/core test"]
          },
          budget: {
            maxUsd: 12,
            softLimitUsd: 8,
            maxIterations: 4,
            maxTokens: 4000
          },
          cost: {
            actualUsd: 4.2,
            avoidedUsd: 0.5,
            tokensIn: 900,
            tokensOut: 300
          }
        }),
        loopId: "loop_trajectory_cli",
        status: "failed" as const,
        lifecycleState: "diminishing_returns" as const,
        updatedAt: "2026-06-07T18:00:00.000Z",
        attempts: [
          {
            attemptId: "att_001",
            index: 1,
            adapterId: "codex-cli",
            model: "gpt-5-codex",
            startedAt: "2026-06-07T17:00:00.000Z",
            summary: "Patched the wrong runtime branch.",
            failureClass: "logic_error" as const
          },
          {
            attemptId: "att_002",
            index: 2,
            adapterId: "codex-cli",
            model: "gpt-5-codex",
            startedAt: "2026-06-07T17:05:00.000Z",
            summary: "Patched the assertion but verification still failed.",
            failureClass: "verification_failure" as const
          },
          {
            attemptId: "att_003",
            index: 3,
            adapterId: "codex-cli",
            model: "gpt-5-codex",
            startedAt: "2026-06-07T17:10:00.000Z",
            summary: "Returned to the wrong runtime branch again.",
            failureClass: "logic_error" as const
          }
        ],
        events: [
          {
            eventId: "evt_verification",
            type: "verification.completed" as const,
            timestamp: "2026-06-07T17:10:30.000Z",
            lifecycleState: "verifying" as const,
            payload: {
              attemptId: "att_003",
              attemptIndex: 3,
              passed: false,
              summary: "Runtime tests still failed."
            }
          }
        ]
      };

      await mkdir(join(runsRoot, loop.loopId), { recursive: true });
      await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");

      const triage = JSON.parse((await executeCli(["--json", "triage"])).stdout);
      const dossier = JSON.parse((await executeCli(["--json", "dossier", "--loop-id", loop.loopId])).stdout);

      expect(triage.findings[0]?.reasons).toContain("trajectory_stalled");
      expect(triage.findings[0]?.summary).toContain("Trajectory stalled");
      expect(dossier.receipt.receiptIntegrity.state).toBe("material_missing");
      expect(dossier.receipt.whatMartinPrevented).toContain(
        "trust claim unavailable until receipt integrity verifies"
      );
      expect(dossier.receipt.nextSafeAction).toContain("receipt integrity");
    });
  });
});
