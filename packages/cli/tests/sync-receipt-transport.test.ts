import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LoopRecord } from "@martin/contracts";
import { persistLoopArtifacts } from "../src/persistence.js";
import { enqueueLoopForHostedSync } from "../src/sync-client.js";

describe("receipt-bound hosted sync transport", () => {
  let tempRoot: string;
  let runsRoot: string;
  let queueRoot: string;
  let integrityRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "martin-receipt-sync-"));
    runsRoot = join(tempRoot, "runs");
    queueRoot = join(tempRoot, "queue");
    integrityRoot = join(tempRoot, "integrity");

    process.env["MARTIN_SYNC_QUEUE_DIR"] = queueRoot;
    process.env["MARTIN_INTEGRITY_KEY_DIR"] = integrityRoot;
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = "http://127.0.0.1:1";
    process.env["MARTIN_API_TOKEN"] = "test-token";
  });

  afterEach(async () => {
    delete process.env["MARTIN_SYNC_QUEUE_DIR"];
    delete process.env["MARTIN_INTEGRITY_KEY_DIR"];
    delete process.env["MARTIN_TELEMETRY_ENDPOINT"];
    delete process.env["MARTIN_API_TOKEN"];
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("transports a re-signed privacy-safe receipt without changing the persisted local receipt", async () => {
    const sensitiveWindowsRoot = "C:\\Users\\Gobi\\Desktop\\MartinDashboard\\Marketifyall-design-Editor";
    const loop = makeLoop(runsRoot, {
      task: {
        title: "Update README proof line",
        objective: `Inspect ${sensitiveWindowsRoot} and make one deterministic source change`,
        verificationPlan: ["grep -q 'MartinLoop proof' README.md"],
        repoRoot: sensitiveWindowsRoot,
      },
      cost: {
        actualUsd: 0.01,
        avoidedUsd: 0.25,
        tokensIn: 100,
        tokensOut: 50,
      },
      artifacts: [
        {
          artifactId: "artifact-private-path",
          kind: "diff",
          label: "Private diff",
          uri: "file:///tmp/private-diff.patch",
        },
      ],
      events: [
        {
          eventId: "evt-core-complete",
          type: "loop.completed",
          lifecycleState: "completed",
          timestamp: "2026-08-23T12:00:00.000Z",
          payload: {
            verified: true,
            detail: `Verifier read ${sensitiveWindowsRoot}\\README.md`,
          },
        },
      ],
      receiptScope: {
        invocationRoot: sensitiveWindowsRoot,
        workingDirectory: sensitiveWindowsRoot,
        repoRoot: sensitiveWindowsRoot,
        runsRoot,
      },
    } as unknown as Partial<LoopRecord>);
    await persistLoopArtifacts(loop, { runsRoot });

    const localLoopPath = join(runsRoot, loop.loopId, "loop.json");
    const localIntegrityPath = join(runsRoot, loop.loopId, "receipt-integrity.json");
    const localLoopBefore = await readFile(localLoopPath, "utf8");
    const localIntegrityBefore = await readFile(localIntegrityPath, "utf8");
    expect(localLoopBefore).toContain(sensitiveWindowsRoot.replace(/\\/gu, "\\\\"));

    await enqueueLoopForHostedSync(loop, { runtimeVersion: "0.5.6" });

    const { item, raw } = await readOnlyQueuedItem(queueRoot);
    const payload = item.payload as Record<string, unknown>;
    const coreReceipt = payload.coreReceipt as {
      loopRecord: Record<string, unknown>;
      ledgerEntries: Array<Record<string, unknown>>;
      integrity: Record<string, unknown>;
    };
    const integrity = coreReceipt.integrity;
    const events = payload.events as Array<Record<string, unknown>>;

    expect(raw).not.toContain("C:\\\\Users\\\\Gobi");
    expect(raw).not.toContain(tempRoot);
    expect(raw).not.toContain("file:///tmp/private-diff.patch");
    expect(raw).toContain("[redacted-path]");

    expect(payload.budget).toEqual({ spentUsd: 0.01, avoidedUsd: 0.25 });
    expect(payload.receiptScope).toBeDefined();
    expect(payload.receiptIntegrity).toEqual(integrity);
    expect(coreReceipt.integrity.runId).toBe(loop.loopId);
    expect(coreReceipt.loopRecord.updatedAt).toBe(loop.updatedAt);
    expect(coreReceipt.loopRecord.workspaceId).toBe(loop.workspaceId);
    expect(coreReceipt.ledgerEntries.map((entry) => entry.eventId)).toEqual(["evt-core-complete"]);
    expect(payload.syncedAt).toBe(loop.updatedAt);
    expect(events.map((event) => event.eventId)).toEqual(["evt-core-complete"]);
    expect(events.map((event) => event.eventType)).toEqual(["loop.completed"]);

    const serializedLoop = `${JSON.stringify(coreReceipt.loopRecord, null, 2)}\n`;
    const serializedLedger = `${coreReceipt.ledgerEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    expect(integrity.loopRecordSha256).toBe(sha256(serializedLoop));
    expect(integrity.ledgerSha256).toBe(sha256(serializedLedger));

    const key = await readIntegrityKey(integrityRoot, runsRoot, loop.loopId);
    expect(integrity.keyId).toBe(sha256(key).slice(0, 16));
    const { signatureHmacSha256, ...signatureBase } = integrity as { signatureHmacSha256: string } & Record<string, unknown>;
    expect(signatureHmacSha256).toBe(
      createHmac("sha256", key).update(JSON.stringify(signatureBase)).digest("hex")
    );

    expect(await readFile(localLoopPath, "utf8")).toBe(localLoopBefore);
    expect(await readFile(localIntegrityPath, "utf8")).toBe(localIntegrityBefore);
  });

  it("enriches and redacts the legacy unverified snapshot path when no persisted receipt exists", async () => {
    const sensitiveWindowsRoot = "C:\\Users\\Gobi\\Desktop\\private-repo";
    const loop = makeLoop(runsRoot, {
      loopId: "loop-without-persisted-receipt",
      status: "failed",
      lifecycleState: "human_escalation",
      updatedAt: "2026-08-20T12:00:00.000Z",
      cost: {
        actualUsd: 0.27,
        avoidedUsd: 0.13,
        tokensIn: 200,
        tokensOut: 80,
        providerSettlement: {
          providerId: "claude",
          model: "claude-sonnet-5",
        },
      },
      attempts: [
        {
          attemptId: "att_8w318ieo",
          index: 0,
          adapterId: "agent-cli:claude",
          startedAt: "2026-08-20T11:58:00.000Z",
          completedAt: "2026-08-20T12:00:00.000Z",
          summary: `Read ${sensitiveWindowsRoot}\\package.json`,
        },
      ],
      events: [
        {
          eventId: "evt-started",
          type: "run.started",
          lifecycleState: "running",
          timestamp: "2026-08-20T11:58:00.000Z",
          payload: { adapterId: "agent-cli:claude", providerId: "claude" },
        },
        {
          eventId: "evt-completed",
          type: "run.completed",
          lifecycleState: "human_escalation",
          timestamp: "2026-08-20T12:00:00.000Z",
          payload: {
            failureClass: "safety_leash_blocked",
            reason: "Safety leash blocked dependency changes that require approval.",
            reasonCode: "dependency_approval_required",
          },
        },
      ],
      receiptScope: {
        invocationRoot: sensitiveWindowsRoot,
        workingDirectory: sensitiveWindowsRoot,
        repoRoot: sensitiveWindowsRoot,
        runsRoot,
      },
    } as unknown as Partial<LoopRecord>);

    await enqueueLoopForHostedSync(loop, { runtimeVersion: "0.5.6" });

    const { item, raw } = await readOnlyQueuedItem(queueRoot);
    const payload = item.payload as Record<string, unknown>;
    const events = payload.events as Array<{ eventId: string; payload?: Record<string, unknown> }>;
    const runEvent = events.find((event) => event.eventId === `evt_run_synced_${loop.loopId}`);
    const attemptEvent = events.find((event) => event.eventId === "evt_attempt_att_8w318ieo");

    expect(payload.coreReceipt).toBeUndefined();
    expect(payload.receiptIntegrity).toBeUndefined();
    expect(payload.syncedAt).not.toBe(loop.updatedAt);
    expect(payload.budget).toEqual({ spentUsd: 0.27, avoidedUsd: 0.13 });
    expect(runEvent?.payload).toMatchObject({
      lifecycleState: "human_escalation",
      status: "failed",
      failureClass: "safety_leash_blocked",
      failureReason: "Safety leash blocked dependency changes that require approval.",
      reasonCode: "dependency_approval_required",
      adapterId: "agent-cli:claude",
    });
    expect(attemptEvent?.payload).toMatchObject({
      model: "claude-sonnet-5",
      adapterId: "agent-cli:claude",
    });
    expect(raw).not.toContain("C:\\\\Users\\\\Gobi");
    expect(raw).not.toContain(tempRoot);
    expect(raw).toContain("[redacted-path]");
  });

  it("fails closed to the redacted unverified path instead of re-signing tampered persisted receipt bytes", async () => {
    const loop = makeLoop(runsRoot);
    await persistLoopArtifacts(loop, { runsRoot });

    const loopPath = join(runsRoot, loop.loopId, "loop.json");
    const tampered = JSON.parse(await readFile(loopPath, "utf8")) as Record<string, unknown>;
    tampered["status"] = "failed";
    await writeFile(loopPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

    await enqueueLoopForHostedSync(loop, { runtimeVersion: "0.5.6" });

    const { item } = await readOnlyQueuedItem(queueRoot);
    const payload = item.payload as Record<string, unknown>;
    const events = payload.events as Array<Record<string, unknown>>;

    expect(payload.coreReceipt).toBeUndefined();
    expect(payload.receiptIntegrity).toBeUndefined();
    expect(events[0]?.eventId).toBe(`evt_run_synced_${loop.loopId}`);
  });
});

async function readOnlyQueuedItem(queueRoot: string) {
  const files = (await readdir(queueRoot)).filter((name) => name.endsWith(".json"));
  expect(files).toHaveLength(1);
  const raw = await readFile(join(queueRoot, files[0]!), "utf8");
  return {
    raw,
    item: JSON.parse(raw) as { payload: unknown },
  };
}

async function readIntegrityKey(integrityRoot: string, runsRoot: string, loopId: string) {
  const rootHash = sha256(runsRoot).slice(0, 16);
  return (await readFile(join(integrityRoot, rootHash, `${loopId}.key`), "utf8")).trim();
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function makeLoop(runsRoot: string, overrides: Partial<LoopRecord> = {}): LoopRecord {
  const updatedAt = "2026-08-23T12:00:00.000Z";
  return {
    loopId: "loop-receipt-transport",
    workspaceId: "ws_local_repo_1234",
    projectId: "project-receipt-transport",
    status: "completed",
    lifecycleState: "completed",
    createdAt: "2026-08-23T11:59:00.000Z",
    updatedAt,
    task: {
      title: "Update README proof line",
      objective: "Make one deterministic source change and verify it",
      verificationPlan: ["grep -q 'MartinLoop proof' README.md"],
      repoRoot: join(tempRootForLoop(runsRoot), "repo"),
    },
    budget: {
      maxUsd: 1,
      softLimitUsd: 0.8,
      maxIterations: 2,
      maxTokens: 10_000,
    },
    cost: {
      actualUsd: 0.01,
      avoidedUsd: 0,
      tokensIn: 100,
      tokensOut: 50,
    },
    attempts: [],
    artifacts: [],
    events: [
      {
        eventId: "evt-core-complete",
        type: "loop.completed",
        lifecycleState: "completed",
        timestamp: updatedAt,
        payload: { verified: true },
      },
    ],
    metadata: {},
    receiptScope: {
      invocationRoot: tempRootForLoop(runsRoot),
      workingDirectory: tempRootForLoop(runsRoot),
      repoRoot: tempRootForLoop(runsRoot),
      runsRoot,
    },
    ...overrides,
  } as unknown as LoopRecord;
}

function tempRootForLoop(runsRoot: string) {
  return join(runsRoot, "..");
}
