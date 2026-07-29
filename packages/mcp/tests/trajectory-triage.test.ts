// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLoopRecord } from "@martin/contracts";
import { describe, expect, it } from "vitest";

import { martinTriageRunsTool } from "../src/tools/triage-runs.js";

async function withRunsRoot<T>(fn: (runsRoot: string) => Promise<T>): Promise<T> {
  const previousRunsRoot = process.env.MARTIN_RUNS_DIR;
  const runsRoot = await mkdtemp(join(tmpdir(), "martin-mcp-trajectory-"));
  process.env.MARTIN_RUNS_DIR = runsRoot;

  try {
    return await fn(runsRoot);
  } finally {
    if (previousRunsRoot === undefined) {
      delete process.env.MARTIN_RUNS_DIR;
    } else {
      process.env.MARTIN_RUNS_DIR = previousRunsRoot;
    }

    await rm(runsRoot, { recursive: true, force: true }).catch(() => {});
  }
}

describe("MCP trajectory triage", () => {
  it("reports stalled trajectory reason codes from persisted loops", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = {
        ...createLoopRecord({
          workspaceId: "ws_test",
          projectId: "proj_test",
          task: {
            title: "Repair runtime guard",
            objective: "Repair the runtime guard without touching release automation.",
            verificationPlan: ["pnpm --filter @martin/core test"]
          },
          budget: {
            maxUsd: 10,
            softLimitUsd: 6,
            maxIterations: 4,
            maxTokens: 4000
          },
          cost: {
            actualUsd: 3.4,
            avoidedUsd: 0.2,
            tokensIn: 700,
            tokensOut: 260
          }
        }),
        loopId: "loop_trajectory_mcp",
        status: "failed" as const,
        lifecycleState: "diminishing_returns" as const,
        updatedAt: "2026-06-07T18:30:00.000Z",
        attempts: [
          {
            attemptId: "att_001",
            index: 1,
            adapterId: "codex-cli",
            model: "gpt-5-codex",
            summary: "Patched the wrong runtime branch.",
            failureClass: "logic_error" as const
          },
          {
            attemptId: "att_002",
            index: 2,
            adapterId: "codex-cli",
            model: "gpt-5-codex",
            summary: "Patched the assertion but verification still failed.",
            failureClass: "verification_failure" as const
          },
          {
            attemptId: "att_003",
            index: 3,
            adapterId: "codex-cli",
            model: "gpt-5-codex",
            summary: "Returned to the wrong runtime branch again.",
            failureClass: "logic_error" as const
          }
        ],
        events: [
          {
            eventId: "evt_verification",
            timestamp: "2026-06-07T18:31:00.000Z",
            type: "verification.completed" as const,
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

      const triage = await martinTriageRunsTool({});

      expect(triage.findings[0]?.reasonCodes).toContain("trajectory_stalled");
      expect(triage.findings[0]?.summary).toContain("should not spend another attempt");
    });
  });
});
