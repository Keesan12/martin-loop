// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildLoopRecordsRollup,
  type LoopRunRecord,
  readAllLoopRecords,
  readLatestLoopRecord
} from "../src/persistence/runs-reader.js";

function buildLoopRecord(input: {
  loopId: string;
  createdAt: string;
  updatedAt: string;
  status?: string;
}): LoopRunRecord {
  return {
    loopId: input.loopId,
    status: input.status ?? "completed",
    lifecycleState: "completed",
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    budget: {
      maxUsd: 2,
      softLimitUsd: 1,
      maxIterations: 2,
      maxTokens: 2000
    },
    cost: {
      actualUsd: 0.25,
      tokensIn: 100,
      tokensOut: 50
    },
    attempts: [],
    task: {
      title: "Reader test",
      objective: "Verify dedupe semantics."
    }
  };
}

describe("runs-reader dedupe", () => {
  it("prefers the most recently updated record for the same loopId across layouts", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-runs-reader-latest-"));

    try {
      const loopId = "loop_same";
      const legacy = buildLoopRecord({
        loopId,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:01:00.000Z",
        status: "failed"
      });
      const canonical = buildLoopRecord({
        loopId,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:03:00.000Z",
        status: "completed"
      });
      await writeFile(join(runsRoot, "workspace-alpha.jsonl"), `${JSON.stringify(legacy)}\n`, "utf8");
      await mkdir(join(runsRoot, loopId), { recursive: true });
      await writeFile(
        join(runsRoot, loopId, "loop-record.json"),
        `${JSON.stringify(canonical, null, 2)}\n`,
        "utf8"
      );

      const records = await readAllLoopRecords(runsRoot);
      expect(records).toHaveLength(1);
      expect(records[0]?.status).toBe("completed");
      expect(records[0]?.updatedAt).toBe("2026-06-01T00:03:00.000Z");
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it("prefers canonical records when timestamps tie", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-runs-reader-tie-"));

    try {
      const loopId = "loop_tie";
      const timestamp = "2026-06-01T00:02:00.000Z";
      const legacy = buildLoopRecord({
        loopId,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: timestamp,
        status: "failed"
      });
      const canonical = buildLoopRecord({
        loopId,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: timestamp,
        status: "completed"
      });
      await writeFile(join(runsRoot, "workspace-beta.jsonl"), `${JSON.stringify(legacy)}\n`, "utf8");
      await mkdir(join(runsRoot, loopId), { recursive: true });
      await writeFile(
        join(runsRoot, loopId, "loop-record.json"),
        `${JSON.stringify(canonical, null, 2)}\n`,
        "utf8"
      );

      const latest = await readLatestLoopRecord(runsRoot);
      expect(latest?.status).toBe("completed");
      expect(latest?.loopId).toBe(loopId);
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it("builds a derived rollup without mutating raw records", () => {
    const records: LoopRunRecord[] = [
      buildLoopRecord({
        loopId: "loop_rollup_a",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:02:00.000Z",
        status: "completed"
      }),
      buildLoopRecord({
        loopId: "loop_rollup_b",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:03:00.000Z",
        status: "failed"
      })
    ];
    const rollup = buildLoopRecordsRollup(records);

    expect(rollup.totalRuns).toBe(2);
    expect(rollup.statusBreakdown.completed).toBe(1);
    expect(rollup.statusBreakdown.failed).toBe(1);
    expect(rollup.latestByLoopId["loop_rollup_a"]?.status).toBe("completed");
  });
});
