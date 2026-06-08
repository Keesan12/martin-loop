import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLoopRecord, type LoopRecord } from "@martin/contracts";
import { describe, expect, it } from "vitest";

import {
  buildVerificationSummary,
  findPersistedLoopEvidence,
  resolveCliEnvironment
} from "../src/run-store.js";

function makeLoopRecord(overrides: Partial<LoopRecord> = {}): LoopRecord {
  const loop = createLoopRecord({
    workspaceId: "ws_run_store",
    projectId: "proj_run_store",
    task: {
      title: "Repair verifier evidence handling",
      objective: "Repair verifier evidence handling",
      verificationPlan: ["npm test"]
    },
    budget: {
      maxUsd: 10,
      softLimitUsd: 6,
      maxIterations: 3,
      maxTokens: 10000
    },
    cost: {
      actualUsd: 1,
      avoidedUsd: 0,
      tokensIn: 100,
      tokensOut: 50
    }
  });

  return {
    ...loop,
    status: "completed" as const,
    lifecycleState: "completed" as const,
    attempts: [],
    events: [],
    ...overrides
  };
}

describe("resolveCliEnvironment", () => {
  it("preserves the openai engine selection", () => {
    const environment = resolveCliEnvironment({ engine: "openai" });

    expect(environment.engine).toBe("openai");
  });

  it("exposes MARTIN_LIVE=false as proof mode for public surfaces", () => {
    const environment = resolveCliEnvironment({ env: { ...process.env, MARTIN_LIVE: "false" } });

    expect(environment.liveMode).toBe("proof");
  });

  it("honors explicit proof mode without requiring environment mutation", () => {
    const environment = resolveCliEnvironment({ liveMode: "proof" });

    expect(environment.liveMode).toBe("proof");
  });
});

describe("buildVerificationSummary", () => {
  it("treats malformed verification payloads as failed evidence instead of throwing", () => {
    const loop = makeLoopRecord({
      events: [
        {
          eventId: "evt_malformed",
          timestamp: "2026-06-06T20:00:00.000Z",
          type: "verification.completed",
          lifecycleState: "verifying",
          payload: null as unknown as Record<string, unknown>
        }
      ]
    });

    expect(() => buildVerificationSummary(loop)).not.toThrow();
    expect(buildVerificationSummary(loop)).toMatchObject({
      status: "failed",
      eventCount: 1,
      steps: [],
      warnings: []
    });
  });

  it("does not invent timedOut or fastFail fields when persisted evidence omits them", () => {
    const loop = makeLoopRecord({
      events: [
        {
          eventId: "evt_sparse_step",
          timestamp: "2026-06-06T20:05:00.000Z",
          type: "verification.completed",
          lifecycleState: "verifying",
          payload: {
            passed: true,
            steps: [{ command: "npm test", launched: true }]
          }
        }
      ]
    });

    expect(buildVerificationSummary(loop).steps).toEqual([{ command: "npm test", launched: true }]);
  });

  it("surfaces reconciled change-observation evidence for the latest attempt", () => {
    const loop = createLoopRecord({
      workspaceId: "ws_cli",
      projectId: "proj_cli",
      task: {
        title: "Verify persisted evidence",
        objective: "Read verifier and observation receipts.",
        verificationPlan: ["pnpm test"]
      },
      attempts: [
        {
          attemptId: "att_001",
          index: 1,
          adapterId: "direct:test",
          model: "gpt-5-mini",
          startedAt: "2026-06-07T10:00:00.000Z",
          completedAt: "2026-06-07T10:01:00.000Z"
        }
      ],
      events: [
        {
          eventId: "evt_obs",
          type: "observation.reconciled",
          timestamp: "2026-06-07T10:01:00.000Z",
          lifecycleState: "running",
          payload: {
            attemptId: "att_001",
            attemptIndex: 1,
            observation: {
              status: "mismatch",
              summary: "Adapter-reported changes differed from repo observation.",
              adapterReported: { available: true, changedFiles: [] },
              repoObserved: { available: true, changedFiles: ["src/real.ts"] },
              effectiveChangedFiles: ["src/real.ts"],
              matchedFiles: [],
              adapterOnlyFiles: [],
              repoOnlyFiles: ["src/real.ts"]
            }
          }
        },
        {
          eventId: "evt_verify",
          type: "verification.completed",
          timestamp: "2026-06-07T10:01:01.000Z",
          lifecycleState: "completed",
          payload: {
            attemptId: "att_001",
            attemptIndex: 1,
            passed: true,
            summary: "Verification passed."
          }
        }
      ]
    });

    const summary = buildVerificationSummary(loop);

    expect(summary.status).toBe("passed");
    expect(summary.steps).toEqual([]);
    expect(summary.observation?.status).toBe("mismatch");
    expect(summary.observation?.repoOnlyFiles).toEqual(["src/real.ts"]);
    expect(summary.warnings).toContain(
      "Change observation mismatch: adapter-reported files differ from repo-observed files."
    );
  });
});

describe("findPersistedLoopEvidence", () => {
  async function withRunsRoot<T>(fn: (runsRoot: string) => Promise<T>): Promise<T> {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-run-store-"));
    try {
      return await fn(runsRoot);
    } finally {
      await rm(runsRoot, { force: true, recursive: true }).catch(() => {});
    }
  }

  it("ignores invalid timestamps in workspace indexes when choosing the latest run", async () => {
    await withRunsRoot(async (runsRoot) => {
      const invalidLoop = makeLoopRecord({
        loopId: "aaa_invalid",
        updatedAt: "not-a-date"
      });
      const validLoop = makeLoopRecord({
        loopId: "zzz_valid",
        updatedAt: "2026-06-06T20:10:00.000Z"
      });

      for (const loop of [invalidLoop, validLoop]) {
        const loopDir = join(runsRoot, loop.loopId);
        await mkdir(loopDir, { recursive: true });
        await writeFile(join(loopDir, "loop-record.json"), JSON.stringify(loop), "utf8");
      }

      await writeFile(
        join(runsRoot, "workspace-a.jsonl"),
        `${JSON.stringify({ loopId: invalidLoop.loopId, updatedAt: "not-a-date" })}\n`,
        "utf8"
      );
      await writeFile(
        join(runsRoot, "workspace-b.jsonl"),
        `${JSON.stringify({ loopId: validLoop.loopId, updatedAt: validLoop.updatedAt })}\n`,
        "utf8"
      );

      await expect(findPersistedLoopEvidence(runsRoot)).resolves.toMatchObject({
        runsRoot,
        loop: expect.objectContaining({ loopId: validLoop.loopId })
      });
    });
  });

  it("ignores invalid loop timestamps during directory fallback scanning", async () => {
    await withRunsRoot(async (runsRoot) => {
      const invalidLoop = makeLoopRecord({
        loopId: "aaa_invalid",
        updatedAt: "not-a-date"
      });
      const validLoop = makeLoopRecord({
        loopId: "zzz_valid",
        updatedAt: "2026-06-06T20:15:00.000Z"
      });

      for (const loop of [invalidLoop, validLoop]) {
        const loopDir = join(runsRoot, loop.loopId);
        await mkdir(loopDir, { recursive: true });
        await writeFile(join(loopDir, "loop-record.json"), JSON.stringify(loop), "utf8");
      }

      await expect(findPersistedLoopEvidence(runsRoot)).resolves.toMatchObject({
        runsRoot,
        loop: expect.objectContaining({ loopId: validLoop.loopId })
      });
    });
  });
});
