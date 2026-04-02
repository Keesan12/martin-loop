import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createLoopRecord } from "@martin/contracts";

import { persistLoopArtifacts } from "../src/persistence.js";

describe("persistLoopArtifacts", () => {
  it("writes contract, state, ledger, and attempt artifacts to <runsRoot>/<loopId>/", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-runs-"));
    const loop = createLoopRecord({
      workspaceId: "ws_alpha",
      projectId: "proj_control",
      task: {
        title: "Repair runtime",
        objective: "Stabilize the runtime without drifting scope.",
        repoRoot: "/tmp/repo",
        verificationPlan: ["pnpm test"]
      },
      attempts: [
        {
          attemptId: "att_1",
          index: 1,
          adapterId: "claude-cli",
          model: "claude-sonnet-4-6",
          startedAt: "2026-04-01T00:00:00.000Z",
          completedAt: "2026-04-01T00:00:02.000Z",
          summary: "Scoped patch",
          failureClass: "test_regression",
          intervention: "run_verifier"
        }
      ],
      events: [
        {
          eventId: "evt_1",
          type: "run.started",
          timestamp: "2026-04-01T00:00:00.000Z",
          lifecycleState: "running",
          payload: { model: "claude-sonnet-4-6" }
        }
      ]
    });

    await persistLoopArtifacts(loop, { runsRoot });

    const base = join(runsRoot, loop.loopId);
    const contract = JSON.parse(await readFile(join(base, "contract.json"), "utf8"));
    const state = JSON.parse(await readFile(join(base, "state.json"), "utf8"));
    const attempt = JSON.parse(
      await readFile(join(base, "attempts", "001-att_1.json"), "utf8")
    );
    const ledger = await readFile(join(base, "ledger.jsonl"), "utf8");

    expect(contract.task.title).toBe("Repair runtime");
    expect(state.metrics.attemptCount).toBe(1);
    expect(attempt.failureClass).toBe("test_regression");
    expect(ledger).toContain('"type":"run.started"');
  });

  it("uses flat <runId> path — NOT nested <workspaceId>/<loopId>", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-flat-path-"));
    const loop = createLoopRecord({
      workspaceId: "ws_flat",
      projectId: "proj_flat",
      task: {
        title: "Test flat path",
        objective: "Verify path structure.",
        verificationPlan: ["pnpm test"]
      }
    });

    await persistLoopArtifacts(loop, { runsRoot });

    // The contract should be at <runsRoot>/<loopId>/contract.json
    // NOT at <runsRoot>/ws_flat/<loopId>/contract.json
    const contractPath = join(runsRoot, loop.loopId, "contract.json");
    const contract = JSON.parse(await readFile(contractPath, "utf8"));
    expect(contract.loopId).toBe(loop.loopId);
  });
});
