import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { verifyReceiptIntegrityFromFiles } from "@martin/core";
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

  it("signs ledger.jsonl bytes — not events.jsonl — and events.jsonl remains timestamp-sorted", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-persist-integrity-"));
    const loop = createLoopRecord({
      workspaceId: "ws_integrity",
      projectId: "proj_integrity",
      task: {
        title: "Persist ordered events",
        objective: "Sign the same ledger bytes verifier reads.",
        verificationPlan: ["pnpm test"]
      },
      events: [
        {
          eventId: "evt_budget",
          type: "budget.updated",
          timestamp: "2026-08-04T00:28:23.460Z",
          lifecycleState: "running",
          payload: { actualUsd: 0 }
        },
        {
          eventId: "evt_verify",
          type: "verification.completed",
          timestamp: "2026-08-04T00:28:23.459Z",
          lifecycleState: "verifying",
          payload: { passed: false, summary: "No live provider request was attempted." }
        }
      ]
    });

    // Pre-populate ledger.jsonl — persistLoopArtifacts reads this to seal the receipt
    // (fix for P1: receipt-integrity-finalization-order).
    const loopRoot = join(runsRoot, loop.loopId);
    await mkdir(loopRoot, { recursive: true });
    const preLedgerEntries = [
      { kind: "contract.created", loopId: loop.loopId, timestamp: "2026-08-04T00:28:20.000Z" },
      { kind: "attempt.admitted", attemptId: "att_1", timestamp: "2026-08-04T00:28:21.000Z" },
      { kind: "run.terminated", loopId: loop.loopId, timestamp: "2026-08-04T00:28:23.461Z" }
    ];
    await writeFile(
      join(loopRoot, "ledger.jsonl"),
      preLedgerEntries.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8"
    );

    await persistLoopArtifacts(loop, { runsRoot });

    const base = join(runsRoot, loop.loopId);

    // events.jsonl is still sorted by timestamp regardless of input order
    const events = await readFile(join(base, "events.jsonl"), "utf8");
    expect(events.indexOf("evt_verify")).toBeLessThan(events.indexOf("evt_budget"));

    // Receipt now covers ledger.jsonl, not events.jsonl
    const integrity = await verifyReceiptIntegrityFromFiles({
      runId: loop.loopId,
      runsRoot,
      loopRecordPath: join(base, "loop-record.json"),
      ledgerPath: join(base, "ledger.jsonl")
    });
    expect(integrity.state).toBe("verified");
    expect(integrity.reason).not.toBe("ledger_hash_mismatch");
  });

  it("P1 regression — seals terminal ledger events in receipt and detects post-sign tampering", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-persist-p1-regression-"));
    const loop = createLoopRecord({
      workspaceId: "ws_p1_regression",
      projectId: "proj_p1_regression",
      task: {
        title: "P1 receipt regression",
        objective: "Verify receipt covers ledger.jsonl terminal events.",
        verificationPlan: ["pnpm test"]
      }
    });

    // Simulate what the run store writes: ledger.jsonl including terminal events
    const loopRoot = join(runsRoot, loop.loopId);
    await mkdir(loopRoot, { recursive: true });
    const ledgerEntries = [
      { kind: "contract.created", loopId: loop.loopId, timestamp: "2026-04-01T00:00:00.000Z" },
      { kind: "attempt.admitted", attemptId: "att_1", timestamp: "2026-04-01T00:00:01.000Z" },
      { kind: "verification.completed", loopId: loop.loopId, timestamp: "2026-04-01T00:01:00.000Z", passed: false },
      { kind: "run.terminated", loopId: loop.loopId, timestamp: "2026-04-01T00:01:01.000Z" },
      { kind: "run.exited", loopId: loop.loopId, timestamp: "2026-04-01T00:01:02.000Z" }
    ];
    const ledgerContent = ledgerEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const ledgerPath = join(loopRoot, "ledger.jsonl");
    await writeFile(ledgerPath, ledgerContent, "utf8");

    await persistLoopArtifacts(loop, { runsRoot });

    const base = join(runsRoot, loop.loopId);
    const receipt = JSON.parse(await readFile(join(base, "receipt-integrity.json"), "utf8"));

    // Signed entryCount must equal the number of ledger entries (including terminal events)
    expect(receipt.entryCount).toBe(ledgerEntries.length);

    // Signed ledgerSha256 must match — verifier returns verified
    const verifyResult = await verifyReceiptIntegrityFromFiles({
      runId: loop.loopId,
      runsRoot,
      loopRecordPath: join(base, "loop-record.json"),
      ledgerPath
    });
    expect(verifyResult.state).toBe("verified");

    // Post-sign mutation of ledger.jsonl must be detected (tamper_detected, not verified)
    await writeFile(
      ledgerPath,
      ledgerContent + '{"kind":"injected","timestamp":"2099-01-01T00:00:00.000Z"}\n',
      "utf8"
    );
    const tamperResult = await verifyReceiptIntegrityFromFiles({
      runId: loop.loopId,
      runsRoot,
      loopRecordPath: join(base, "loop-record.json"),
      ledgerPath
    });
    expect(tamperResult.state).toBe("tamper_detected");
  });
});
