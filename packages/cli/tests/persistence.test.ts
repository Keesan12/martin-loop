import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLoopRecord } from "@martin/contracts";

import { persistLoopArtifacts } from "../src/persistence.js";

describe("persistLoopArtifacts", () => {
  let keyRoot: string;
  let previousIntegrityKeyDir: string | undefined;

  beforeEach(async () => {
    keyRoot = await mkdtemp(join(tmpdir(), "martin-persistence-keys-"));
    previousIntegrityKeyDir = process.env["MARTIN_INTEGRITY_KEY_DIR"];
    process.env["MARTIN_INTEGRITY_KEY_DIR"] = keyRoot;
  });

  afterEach(async () => {
    if (previousIntegrityKeyDir === undefined) {
      delete process.env["MARTIN_INTEGRITY_KEY_DIR"];
    } else {
      process.env["MARTIN_INTEGRITY_KEY_DIR"] = previousIntegrityKeyDir;
    }
    await rm(keyRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("writes contract, state, events, and attempt artifacts to <runsRoot>/<loopId>/ without shadowing the core ledger", async () => {
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
    const events = await readFile(join(base, "events.jsonl"), "utf8");

    expect(contract.task.title).toBe("Repair runtime");
    expect(state.metrics.attemptCount).toBe(1);
    expect(attempt.failureClass).toBe("test_regression");
    expect(events).toContain('"type":"run.started"');
    await expect(readFile(join(base, "ledger.jsonl"), "utf8")).rejects.toThrow();
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

  it("aggregates events across repeated persists without dropping prior history", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-persist-aggregate-"));
    const loop = createLoopRecord({
      workspaceId: "ws_aggregate",
      projectId: "proj_aggregate",
      task: {
        title: "Aggregate event history",
        objective: "Keep prior receipt intelligence while persisting updates.",
        verificationPlan: ["pnpm test"]
      },
      events: [
        {
          eventId: "evt_1",
          type: "run.started",
          timestamp: "2026-04-01T00:00:00.000Z",
          lifecycleState: "running",
          payload: {}
        }
      ]
    });

    await persistLoopArtifacts(loop, { runsRoot });

    const updated = {
      ...loop,
      updatedAt: "2026-04-01T00:05:00.000Z",
      events: [
        {
          eventId: "evt_2",
          type: "run.completed" as const,
          timestamp: "2026-04-01T00:04:00.000Z",
          lifecycleState: "completed" as const,
          payload: {}
        }
      ]
    };

    await persistLoopArtifacts(updated, { runsRoot });

    const events = await readFile(join(runsRoot, loop.loopId, "events.jsonl"), "utf8");
    const lines = events.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"eventId":"evt_1"');
    expect(lines[1]).toContain('"eventId":"evt_2"');
  });
});
