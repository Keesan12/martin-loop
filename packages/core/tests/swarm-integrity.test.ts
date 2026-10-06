import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createSwarmLivePlan, type SwarmParentReceipt } from "@martin/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ReadAndSealSwarmEvidenceResult } from "../src/swarm/evidence.js";
import { buildParentSwarmReceipt } from "../src/swarm/parent-receipt.js";
import {
  resolveSwarmReceiptIntegrityPath,
  verifySwarmReceiptIntegrityFromFiles,
  writeSwarmReceiptIntegrityMaterial
} from "../src/persistence/swarm-integrity.js";

let root = "";
let keyRoot = "";
let previousKeyRoot: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "martin-swarm-integrity-"));
  keyRoot = join(root, "keys");
  previousKeyRoot = process.env.MARTIN_INTEGRITY_KEY_DIR;
  process.env.MARTIN_INTEGRITY_KEY_DIR = keyRoot;
});

afterEach(async () => {
  if (previousKeyRoot === undefined) delete process.env.MARTIN_INTEGRITY_KEY_DIR;
  else process.env.MARTIN_INTEGRITY_KEY_DIR = previousKeyRoot;
  await rm(root, { recursive: true, force: true });
});

describe("canonical swarm receipt integrity", () => {
  it("creates a real key, signs only canonical artifacts, and keeps task failure separate", async () => {
    const fixture = await writeBundle(join(root, "runs"), "swarm-integrity", "needs_review");
    const material = await writeSwarmReceiptIntegrityMaterial({
      runsRoot: fixture.runsRoot,
      swarmId: fixture.swarmId,
      signedAt: "2026-10-03T13:00:00.000Z"
    });

    expect(material).toMatchObject({
      schemaVersion: "martin.swarm-receipt-integrity.v1",
      swarmId: fixture.swarmId,
      planHash: fixture.receipt.planHash,
      receiptSha256: fixture.receipt.receiptSha256,
      taskVerificationState: "unknown",
      artifacts: [
        expect.objectContaining({ path: "evidence/evidence-index.json" }),
        expect.objectContaining({ path: "evidence/parent-receipt.json" })
      ]
    });
    expect(await verifySwarmReceiptIntegrityFromFiles({
      runsRoot: fixture.runsRoot,
      swarmId: fixture.swarmId
    })).toMatchObject({ state: "verified", taskVerificationState: "unknown" });

    if (process.platform !== "win32") {
      const keyPath = await findOnlyKey(keyRoot);
      expect((await stat(dirname(keyPath))).mode & 0o777).toBe(0o700);
      expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
    }
  });

  it.each([
    ["receipt byte", "receipt"],
    ["index byte", "index"],
    ["event chain", "events"]
  ])("rejects %s tamper", async (_label, target) => {
    const fixture = await writeBundle(join(root, "runs"), "swarm-tamper", "verified");
    await writeSwarmReceiptIntegrityMaterial({ runsRoot: fixture.runsRoot, swarmId: fixture.swarmId });
    const path = target === "receipt" ? fixture.receiptPath : target === "index" ? fixture.indexPath : fixture.eventsPath;
    await writeFile(path, `${await readFile(path, "utf8")} `, "utf8");
    expect(await verifySwarmReceiptIntegrityFromFiles({ runsRoot: fixture.runsRoot, swarmId: fixture.swarmId }))
      .toMatchObject({ state: "tamper_detected" });
  });

  it.each(["reorder", "duplicate", "alias"])("rejects %s manifest tamper", async (mode) => {
    const fixture = await writeBundle(join(root, "runs"), "swarm-manifest", "verified");
    await writeSwarmReceiptIntegrityMaterial({ runsRoot: fixture.runsRoot, swarmId: fixture.swarmId });
    const integrityPath = resolveSwarmReceiptIntegrityPath(fixture.runsRoot, fixture.swarmId);
    const value = JSON.parse(await readFile(integrityPath, "utf8")) as any;
    if (mode === "reorder") value.artifacts.reverse();
    else if (mode === "duplicate") value.artifacts.push(value.artifacts[0]);
    else value.artifacts[0].path = "evidence/../evidence/evidence-index.json";
    await writeFile(integrityPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    expect(await verifySwarmReceiptIntegrityFromFiles({ runsRoot: fixture.runsRoot, swarmId: fixture.swarmId }))
      .toMatchObject({ state: "tamper_detected" });
  });

  it("rejects wrong or missing key and missing or malformed material", async () => {
    const fixture = await writeBundle(join(root, "runs"), "swarm-key", "verified");
    await writeSwarmReceiptIntegrityMaterial({ runsRoot: fixture.runsRoot, swarmId: fixture.swarmId });
    const keyPath = await findOnlyKey(keyRoot);
    await writeFile(keyPath, `${"f".repeat(64)}\n`, "utf8");
    expect(await verifySwarmReceiptIntegrityFromFiles({ runsRoot: fixture.runsRoot, swarmId: fixture.swarmId }))
      .toMatchObject({ state: "tamper_detected" });
    await rm(keyPath);
    expect(await verifySwarmReceiptIntegrityFromFiles({ runsRoot: fixture.runsRoot, swarmId: fixture.swarmId }))
      .toMatchObject({ state: "material_missing" });
    const integrityPath = resolveSwarmReceiptIntegrityPath(fixture.runsRoot, fixture.swarmId);
    await writeFile(integrityPath, "{", "utf8");
    expect(await verifySwarmReceiptIntegrityFromFiles({ runsRoot: fixture.runsRoot, swarmId: fixture.swarmId }))
      .toMatchObject({ state: "material_missing" });
  });

  it("rejects relocation even when the bundle and key are copied", async () => {
    const source = await writeBundle(join(root, "source-runs"), "swarm-copy", "verified");
    await writeSwarmReceiptIntegrityMaterial({ runsRoot: source.runsRoot, swarmId: source.swarmId });
    const target = await writeBundle(join(root, "target-runs"), "swarm-copy", "verified");
    await copyFile(resolveSwarmReceiptIntegrityPath(source.runsRoot, source.swarmId), resolveSwarmReceiptIntegrityPath(target.runsRoot, target.swarmId));
    const sourceKey = await findOnlyKey(keyRoot);
    const targetKey = swarmKeyPath(keyRoot, target.runsRoot, target.swarmId);
    await mkdir(dirname(targetKey), { recursive: true });
    await copyFile(sourceKey, targetKey);
    await chmod(targetKey, 0o600).catch(() => undefined);
    expect(await verifySwarmReceiptIntegrityFromFiles({ runsRoot: target.runsRoot, swarmId: target.swarmId }))
      .toMatchObject({ state: "tamper_detected", reason: "root_binding_mismatch" });
    expect(await verifySwarmReceiptIntegrityFromFiles({ runsRoot: target.runsRoot, swarmId: "different-swarm" }))
      .toMatchObject({ state: "material_missing" });
  });

  it("rejects a canonical evidence-directory junction alias instead of following it", async () => {
    const fixture = await writeBundle(join(root, "runs"), "swarm-alias", "verified");
    const evidenceRoot = dirname(fixture.receiptPath);
    const actualEvidenceRoot = `${evidenceRoot}-actual`;
    await rename(evidenceRoot, actualEvidenceRoot);
    await symlink(actualEvidenceRoot, evidenceRoot, process.platform === "win32" ? "junction" : "dir");

    await expect(writeSwarmReceiptIntegrityMaterial({ runsRoot: fixture.runsRoot, swarmId: fixture.swarmId }))
      .rejects.toThrow(/PATH|ALIAS|canonical/iu);
    expect(await verifySwarmReceiptIntegrityFromFiles({ runsRoot: fixture.runsRoot, swarmId: fixture.swarmId }))
      .toMatchObject({ state: "material_missing" });
  });
});

async function writeBundle(
  runsRoot: string,
  swarmId: string,
  outcome: "verified" | "needs_review"
): Promise<{
  runsRoot: string; swarmId: string; receipt: SwarmParentReceipt;
  receiptPath: string; indexPath: string; eventsPath: string;
}> {
  const swarmRoot = join(runsRoot, "_swarms", swarmId);
  const evidenceRoot = join(swarmRoot, "evidence");
  await mkdir(evidenceRoot, { recursive: true });
  const plan = createSwarmLivePlan({
    planId: "plan-integrity", swarmId, workspaceId: "workspace", projectId: "project",
    baselineCommit: "a".repeat(40),
    parentContract: {
      policyVersion: "policy-v1", objective: "Bind a swarm receipt", definitionOfDone: ["sealed"],
      budget: { maxUsd: 1, softLimitUsd: 0.8, maxIterations: 1, maxTokens: 100 },
      maxWallClockMs: 1000, maxConcurrency: 1,
      scope: { allowedPaths: ["src/**"], deniedPaths: [".git/**"] },
      permissions: { networkDomains: [], commands: ["pnpm test"] },
      integrationStrategy: "parent_fan_in", globalVerifierStack: [{ command: "pnpm test", type: "test_full" }],
      stopPolicy: { budgetExhausted: "stop", blockingFailure: "needs_review", verifierFailure: "stop" },
      recoveryPolicy: { maxReassignmentsPerTask: 0, dependencyWaiversAllowed: false },
      approvalPolicy: {}, orchestrationStrategy: "hierarchical_dag"
    },
    tasks: [], agents: [], engine: { engine: "codex", model: "gpt-test" }, childMaxIterations: 1,
    createdAt: "2026-10-03T12:00:00.000Z"
  });
  const finalType = outcome === "verified" ? "SWARM_VERIFIED" : "SWARM_NEEDS_REVIEW";
  const events = [{
    schemaVersion: "martin.swarm.v1" as const, sequence: 1, idempotencyKey: "final-1", type: finalType,
    swarmId, timestamp: "2026-10-03T12:01:00.000Z", parentPolicyVersion: "policy-v1", planHash: plan.planHash,
    payload: { reason: outcome }
  }];
  const index = {
    schemaVersion: "martin.swarm-evidence-index.v1" as const, swarmId, planHash: plan.planHash, revision: 1,
    outcome: { state: outcome, reason: outcome }, sealedAt: "2026-10-03T12:01:00.000Z",
    files: []
  };
  const sealed = {
    index,
    indexPath: join(evidenceRoot, "evidence-index.json"),
    indexBytes: `${JSON.stringify(index, null, 2)}\n`,
    model: {
      plan, events,
      snapshot: { ...index, schemaVersion: "martin.swarm.v1", lastSequence: 1, eventCount: 1, updatedAt: index.sealedAt },
      artifacts: []
    }
  } as unknown as ReadAndSealSwarmEvidenceResult;
  const receipt = buildParentSwarmReceipt(sealed);
  const receiptPath = join(evidenceRoot, "parent-receipt.json");
  const indexPath = join(evidenceRoot, "evidence-index.json");
  const eventsPath = join(swarmRoot, "events.jsonl");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  return { runsRoot, swarmId, receipt, receiptPath, indexPath, eventsPath };
}

async function findOnlyKey(rootDir: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const roots = await readdir(rootDir);
  const files = await readdir(join(rootDir, roots[0]!));
  return join(rootDir, roots[0]!, files[0]!);
}

function swarmKeyPath(keyDir: string, runsRoot: string, swarmId: string): string {
  const rootHash = createHash("sha256").update(runsRoot).digest("hex").slice(0, 16);
  return join(keyDir, rootHash, `swarm-${swarmId}.key`);
}
