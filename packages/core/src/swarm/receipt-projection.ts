import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { SwarmParentReceipt } from "@martin/contracts";
import {
  resolveSwarmReceiptIntegrityPath,
  verifySwarmReceiptSealCommitAuthentication,
  verifySwarmReceiptIntegrityFromFiles,
  type SwarmReceiptIntegritySummary,
} from "../persistence/swarm-integrity.js";
import { readAndSealSwarmEvidence } from "./evidence.js";
import { buildParentSwarmReceipt } from "./parent-receipt.js";
import { assertSwarmPathIdentifier } from "./workspaces.js";

interface SwarmReceiptSealCommit {
  schemaVersion: "martin.swarm-receipt-seal.v1";
  swarmId: string;
  planHash: string;
  receiptSha256: string;
  evidenceIndexSha256: string;
  integrityMaterialSha256: string;
  committedAt: string;
  commitHmacSha256: string;
}

export interface SwarmReceiptProjection {
  receipt: SwarmParentReceipt;
  integrity: SwarmReceiptIntegritySummary;
  seal: SwarmReceiptSealCommit;
}

export async function readSwarmReceiptProjection(input: {
  runsRoot: string;
  swarmId: string;
}): Promise<SwarmReceiptProjection> {
  assertSwarmPathIdentifier(input.swarmId, "swarm ID");
  const runsRoot = await realpath(resolve(input.runsRoot));
  const swarmsRoot = await realpath(join(runsRoot, "_swarms"));
  assertContainedOrSame(runsRoot, swarmsRoot, "Swarm projection escaped the runs root.");
  const swarmRoot = await realpath(join(swarmsRoot, input.swarmId));
  assertStrictlyContained(swarmsRoot, swarmRoot, "Swarm projection escaped the swarm root.");
  const evidenceRootExpected = join(swarmRoot, "evidence");
  const evidenceRoot = await resolveExactDirectory(swarmRoot, evidenceRootExpected);
  assertStrictlyContained(swarmRoot, evidenceRoot, "Swarm projection escaped the evidence root.");
  const receiptPath = await resolveExactRegularFile(evidenceRoot, join(evidenceRoot, "parent-receipt.json"));
  const indexPath = await resolveExactRegularFile(evidenceRoot, join(evidenceRoot, "evidence-index.json"));
  const integrityPath = await resolveExactRegularFile(evidenceRoot, resolveSwarmReceiptIntegrityPath(runsRoot, input.swarmId));
  const sealPath = await resolveExactRegularFile(evidenceRoot, join(evidenceRoot, "swarm-receipt-seal.json"));
  for (const path of [receiptPath, indexPath, integrityPath, sealPath]) {
    assertStrictlyContained(evidenceRoot, path, "Swarm projection artifact escaped the evidence root.");
  }
  const [receiptRaw, indexRaw, integrityRaw, sealRaw] = await Promise.all([
    readFile(receiptPath, "utf8"),
    readFile(indexPath, "utf8"),
    readFile(integrityPath, "utf8"),
    readFile(sealPath, "utf8")
  ]);
  const receipt = parseCommittedProjectionJson<SwarmReceiptProjection["receipt"]>(receiptRaw, "parent receipt");
  const seal = parseCommittedProjectionJson<SwarmReceiptSealCommit>(sealRaw, "receipt seal");
  if (
    seal.schemaVersion !== "martin.swarm-receipt-seal.v1"
    || seal.swarmId !== input.swarmId
    || seal.planHash !== receipt.planHash
    || seal.receiptSha256 !== sha256Text(receiptRaw)
    || seal.evidenceIndexSha256 !== sha256Text(indexRaw)
    || seal.integrityMaterialSha256 !== sha256Text(integrityRaw)
    || !await verifySwarmReceiptSealCommitAuthentication({
      runsRoot,
      swarmId: input.swarmId,
      commit: seal
    })
  ) {
    throw codedRuntimeError("SWARM_SEAL_COMMIT_MISMATCH", "Committed swarm receipt seal is missing or tampered.");
  }
  const integrity = await verifySwarmReceiptIntegrityFromFiles({ runsRoot, swarmId: input.swarmId });
  if (integrity.state !== "verified") {
    throw codedRuntimeError("SWARM_SEAL_INTEGRITY_FAILED", "Committed swarm receipt integrity did not verify.");
  }
  const canonical = await readAndSealSwarmEvidence({ rootDir: runsRoot, swarmId: input.swarmId });
  const canonicalReceipt = buildParentSwarmReceipt(canonical);
  if (receiptRaw !== `${JSON.stringify(canonicalReceipt, null, 2)}\n`) {
    throw codedRuntimeError("SWARM_SEAL_COMMIT_MISMATCH", "Committed swarm receipt disagrees with canonical evidence.");
  }
  return { receipt, integrity, seal };
}

async function resolveExactDirectory(parent: string, expected: string): Promise<string> {
  const metadata = await lstat(expected);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw codedRuntimeError("SWARM_SEAL_PATH_ALIAS", "Swarm seal directory is not an exact canonical directory.");
  }
  const canonical = await realpath(expected);
  assertStrictlyContained(parent, canonical, "Swarm seal directory escaped its parent.");
  if (!sameFilesystemPath(canonical, resolve(expected))) {
    throw codedRuntimeError("SWARM_SEAL_PATH_ALIAS", "Swarm seal directory is aliased.");
  }
  return canonical;
}

async function resolveExactRegularFile(parent: string, expected: string): Promise<string> {
  const metadata = await lstat(expected);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw codedRuntimeError("SWARM_SEAL_PATH_ALIAS", "Swarm seal artifact is not an exact regular file.");
  }
  const canonical = await realpath(expected);
  assertStrictlyContained(parent, canonical, "Swarm seal artifact escaped its parent.");
  if (!sameFilesystemPath(canonical, resolve(expected))) {
    throw codedRuntimeError("SWARM_SEAL_PATH_ALIAS", "Swarm seal artifact is aliased.");
  }
  return canonical;
}

function sameFilesystemPath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export async function verifySwarmReceiptProjection(input: {
  runsRoot: string;
  swarmId: string;
}): Promise<SwarmReceiptIntegritySummary> {
  try {
    return (await readSwarmReceiptProjection(input)).integrity;
  } catch (error) {
    return {
      state: "tamper_detected",
      reason: error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "swarm_seal_unavailable"
    };
  }
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertContainedOrSame(parent: string, candidate: string, message: string): void {
  const relation = relative(parent, candidate);
  if (relation === "") return;
  assertStrictlyContained(parent, candidate, message);
}

function assertStrictlyContained(parent: string, candidate: string, message: string): void {
  const relation = relative(parent, candidate);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw codedRuntimeError("LIVE_SWARM_PATH_ESCAPE", message);
  }
}


function codedRuntimeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function parseCommittedProjectionJson<T>(source: string, label: string): T {
  try {
    return JSON.parse(source) as T;
  } catch {
    throw codedRuntimeError("MALFORMED_JSON", `Committed swarm ${label} is malformed.`);
  }
}
