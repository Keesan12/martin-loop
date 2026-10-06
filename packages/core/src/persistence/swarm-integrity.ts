import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { SwarmParentReceipt } from "@martin/contracts";

import { verifyParentSwarmReceipt } from "../swarm/parent-receipt.js";
import { assertSwarmPathIdentifier } from "../swarm/workspaces.js";
import {
  createPrivateIntegrityHmac,
  ensurePrivateIntegrityKey,
  readPrivateIntegrityKey
} from "./integrity.js";

const SWARM_RECEIPT_INTEGRITY_SCHEMA_VERSION = "martin.swarm-receipt-integrity.v1" as const;

export interface SwarmReceiptIntegrityArtifact {
  path: string;
  sha256: string;
  bytes: number;
}

export interface StoredSwarmReceiptIntegrityMaterial {
  schemaVersion: typeof SWARM_RECEIPT_INTEGRITY_SCHEMA_VERSION;
  swarmId: string;
  planHash: string;
  receiptSchemaVersion: string;
  receiptSha256: string;
  evidenceIndexSha256: string;
  eventChainHead: string;
  rootBindingSha256: string;
  keyId: string;
  signedAt: string;
  taskVerificationState: "passed" | "failed" | "unknown";
  artifacts: SwarmReceiptIntegrityArtifact[];
  signatureHmacSha256: string;
}

export interface SwarmReceiptIntegritySummary {
  state: "verified" | "material_missing" | "tamper_detected";
  taskVerificationState?: "passed" | "failed" | "unknown";
  keyId?: string;
  signedAt?: string;
  receiptSha256?: string;
  evidenceIndexSha256?: string;
  eventChainHead?: string;
  reason?: string;
}

export interface SwarmReceiptSealCommitBase {
  schemaVersion: "martin.swarm-receipt-seal.v1";
  swarmId: string;
  planHash: string;
  receiptSha256: string;
  evidenceIndexSha256: string;
  integrityMaterialSha256: string;
  committedAt: string;
}

export async function authenticateSwarmReceiptSealCommit(input: {
  runsRoot: string;
  swarmId: string;
  commit: SwarmReceiptSealCommitBase;
}): Promise<string> {
  const runsRoot = await realpath(resolve(input.runsRoot));
  const key = await readPrivateIntegrityKey(runsRoot, keyFileName(input.swarmId));
  if (!key) throw new Error("SWARM_SEAL_KEY_UNAVAILABLE");
  return createPrivateIntegrityHmac(key, sealAuthenticationBase(runsRoot, input.commit));
}

export async function verifySwarmReceiptSealCommitAuthentication(input: {
  runsRoot: string;
  swarmId: string;
  commit: SwarmReceiptSealCommitBase & { commitHmacSha256?: string };
}): Promise<boolean> {
  const runsRoot = await realpath(resolve(input.runsRoot));
  const key = await readPrivateIntegrityKey(runsRoot, keyFileName(input.swarmId));
  if (!key || typeof input.commit.commitHmacSha256 !== "string") return false;
  const { commitHmacSha256, ...commit } = input.commit;
  const expected = createPrivateIntegrityHmac(key, sealAuthenticationBase(runsRoot, commit));
  return constantTimeHexEqual(commitHmacSha256, expected);
}

export async function writeSwarmReceiptIntegrityMaterial(input: {
  runsRoot: string;
  swarmId: string;
  signedAt?: string;
}): Promise<StoredSwarmReceiptIntegrityMaterial | undefined> {
  const bundle = await resolveCanonicalSwarmIntegrityBundle(input.runsRoot, input.swarmId);
  const receipt = parseParentReceipt(bundle.receiptRaw);
  const evidenceIndex = parseEvidenceIndex(bundle.indexRaw);
  validateArtifactIdentities(input.swarmId, receipt, evidenceIndex, bundle.indexRaw, bundle.eventsRaw);
  const keyMaterial = await ensurePrivateIntegrityKey(bundle.runsRoot, keyFileName(input.swarmId));
  if (!keyMaterial) return undefined;
  const [key, keyId] = keyMaterial;
  const artifacts = canonicalArtifactManifest(bundle);
  const base = {
    schemaVersion: SWARM_RECEIPT_INTEGRITY_SCHEMA_VERSION,
    swarmId: input.swarmId,
    planHash: receipt.planHash,
    receiptSchemaVersion: receipt.schemaVersion,
    receiptSha256: receipt.receiptSha256,
    evidenceIndexSha256: sha256(bundle.indexRaw),
    eventChainHead: sha256(bundle.eventsRaw),
    rootBindingSha256: sha256(bundle.runsRoot),
    keyId,
    signedAt: input.signedAt ?? new Date().toISOString(),
    taskVerificationState: receipt.taskVerificationState,
    artifacts
  } satisfies Omit<StoredSwarmReceiptIntegrityMaterial, "signatureHmacSha256">;
  const material: StoredSwarmReceiptIntegrityMaterial = {
    ...base,
    signatureHmacSha256: createPrivateIntegrityHmac(key, base)
  };
  await writeExactOnce(bundle.integrityPath, serializeJson(material));
  return material;
}

export async function verifySwarmReceiptIntegrityFromFiles(input: {
  runsRoot: string;
  swarmId: string;
}): Promise<SwarmReceiptIntegritySummary> {
  let bundle: CanonicalSwarmIntegrityBundle;
  try {
    bundle = await resolveCanonicalSwarmIntegrityBundle(input.runsRoot, input.swarmId);
  } catch {
    return { state: "material_missing", reason: "canonical_swarm_bundle_missing" };
  }
  const [materialRaw, key] = await Promise.all([
    readFile(bundle.integrityPath, "utf8").catch(() => null),
    readPrivateIntegrityKey(bundle.runsRoot, keyFileName(input.swarmId)).catch(() => null)
  ]);
  if (!materialRaw || !key) {
    return { state: "material_missing", reason: "swarm_receipt_integrity_material_incomplete" };
  }
  let material: StoredSwarmReceiptIntegrityMaterial;
  let receipt: SwarmParentReceipt;
  let evidenceIndex: Record<string, unknown>;
  try {
    material = JSON.parse(materialRaw) as StoredSwarmReceiptIntegrityMaterial;
    receipt = parseParentReceipt(bundle.receiptRaw);
    evidenceIndex = parseEvidenceIndex(bundle.indexRaw);
    validateArtifactIdentities(input.swarmId, receipt, evidenceIndex, bundle.indexRaw, bundle.eventsRaw);
  } catch {
    return { state: "tamper_detected", reason: "malformed_integrity_or_artifact_material" };
  }
  const actualArtifacts = canonicalArtifactManifest(bundle);
  if (!validMaterialShape(material) || !sameManifest(material.artifacts, actualArtifacts)) {
    return tamper(material, "artifact_manifest_mismatch");
  }
  if (material.rootBindingSha256 !== sha256(bundle.runsRoot)) {
    return tamper(material, "root_binding_mismatch");
  }
  if (
    material.swarmId !== input.swarmId
    || material.planHash !== receipt.planHash
    || material.receiptSchemaVersion !== receipt.schemaVersion
    || material.receiptSha256 !== receipt.receiptSha256
    || material.evidenceIndexSha256 !== sha256(bundle.indexRaw)
    || material.eventChainHead !== sha256(bundle.eventsRaw)
    || material.taskVerificationState !== receipt.taskVerificationState
  ) {
    return tamper(material, "canonical_binding_mismatch");
  }
  const { signatureHmacSha256, ...base } = material;
  const expected = createPrivateIntegrityHmac(key, base);
  if (!constantTimeHexEqual(signatureHmacSha256, expected)) {
    return tamper(material, "signature_mismatch");
  }
  return {
    state: "verified",
    taskVerificationState: receipt.taskVerificationState,
    keyId: material.keyId,
    signedAt: material.signedAt,
    receiptSha256: material.receiptSha256,
    evidenceIndexSha256: material.evidenceIndexSha256,
    eventChainHead: material.eventChainHead
  };
}

export function resolveSwarmReceiptIntegrityPath(runsRoot: string, swarmId: string): string {
  assertSwarmPathIdentifier(swarmId, "swarm ID");
  return join(runsRoot, "_swarms", swarmId, "evidence", "swarm-receipt-integrity.json");
}

interface CanonicalSwarmIntegrityBundle {
  runsRoot: string;
  swarmRoot: string;
  evidenceRoot: string;
  integrityPath: string;
  receiptRaw: string;
  indexRaw: string;
  eventsRaw: string;
}

async function resolveCanonicalSwarmIntegrityBundle(
  runsRootInput: string,
  swarmId: string
): Promise<CanonicalSwarmIntegrityBundle> {
  assertSwarmPathIdentifier(swarmId, "swarm ID");
  const runsRoot = await realpath(resolve(runsRootInput));
  const swarmsRoot = await resolveExactDirectory(runsRoot, join(runsRoot, "_swarms"));
  assertContained(runsRoot, swarmsRoot);
  const swarmRoot = await resolveExactDirectory(swarmsRoot, join(swarmsRoot, swarmId));
  assertContained(swarmsRoot, swarmRoot);
  const evidenceRoot = await resolveExactDirectory(swarmRoot, join(swarmRoot, "evidence"));
  assertContained(swarmRoot, evidenceRoot);
  const receiptPath = await resolveExactRegularFile(evidenceRoot, join(evidenceRoot, "parent-receipt.json"));
  const indexPath = await resolveExactRegularFile(evidenceRoot, join(evidenceRoot, "evidence-index.json"));
  const eventsPath = await resolveExactRegularFile(swarmRoot, join(swarmRoot, "events.jsonl"));
  assertContained(evidenceRoot, receiptPath);
  assertContained(evidenceRoot, indexPath);
  assertContained(swarmRoot, eventsPath);
  const [receiptRaw, indexRaw, eventsRaw] = await Promise.all([
    readFile(receiptPath, "utf8"),
    readFile(indexPath, "utf8"),
    readFile(eventsPath, "utf8")
  ]);
  return {
    runsRoot,
    swarmRoot,
    evidenceRoot,
    integrityPath: join(evidenceRoot, "swarm-receipt-integrity.json"),
    receiptRaw,
    indexRaw,
    eventsRaw
  };
}

function canonicalArtifactManifest(bundle: CanonicalSwarmIntegrityBundle): SwarmReceiptIntegrityArtifact[] {
  return [
    { path: "evidence/evidence-index.json", sha256: sha256(bundle.indexRaw), bytes: Buffer.byteLength(bundle.indexRaw) },
    { path: "evidence/parent-receipt.json", sha256: sha256(bundle.receiptRaw), bytes: Buffer.byteLength(bundle.receiptRaw) }
  ];
}

function parseParentReceipt(raw: string): SwarmParentReceipt {
  const receipt = JSON.parse(raw) as SwarmParentReceipt;
  if (verifyParentSwarmReceipt(receipt).ok !== true) {
    throw new Error("INVALID_PARENT_SWARM_RECEIPT");
  }
  return receipt;
}

function parseEvidenceIndex(raw: string): Record<string, unknown> {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value) || value.schemaVersion !== "martin.swarm-evidence-index.v1") {
    throw new Error("INVALID_SWARM_EVIDENCE_INDEX");
  }
  return value;
}

function validateArtifactIdentities(
  swarmId: string,
  receipt: SwarmParentReceipt,
  evidenceIndex: Record<string, unknown>,
  indexRaw: string,
  eventsRaw: string
): void {
  if (
    receipt.swarmId !== swarmId
    || evidenceIndex.swarmId !== swarmId
    || evidenceIndex.planHash !== receipt.planHash
  ) {
    throw new Error("SWARM_ARTIFACT_IDENTITY_MISMATCH");
  }
  if (
    receipt.evidenceIndexSha256 !== sha256(indexRaw)
    || stableJson(receipt.evidenceFiles) !== stableJson(evidenceIndex.files)
    || `${receipt.events.map((event) => JSON.stringify(event)).join("\n")}\n` !== eventsRaw
  ) {
    throw new Error("SWARM_ARTIFACT_RELATION_MISMATCH");
  }
}

async function resolveExactDirectory(parent: string, expected: string): Promise<string> {
  const metadata = await lstat(expected);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("SWARM_INTEGRITY_PATH_ALIAS");
  const canonical = await realpath(expected);
  assertContained(parent, canonical);
  if (!sameFilesystemPath(canonical, resolve(expected))) throw new Error("SWARM_INTEGRITY_PATH_ALIAS");
  return canonical;
}

async function resolveExactRegularFile(parent: string, expected: string): Promise<string> {
  const metadata = await lstat(expected);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("SWARM_INTEGRITY_PATH_ALIAS");
  const canonical = await realpath(expected);
  assertContained(parent, canonical);
  if (!sameFilesystemPath(canonical, resolve(expected))) throw new Error("SWARM_INTEGRITY_PATH_ALIAS");
  return canonical;
}

function sealAuthenticationBase(runsRoot: string, commit: SwarmReceiptSealCommitBase) {
  return {
    purpose: "martin.swarm-receipt-seal-commit.v1",
    rootBindingSha256: sha256(runsRoot),
    ...commit
  };
}

function sameFilesystemPath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function validMaterialShape(value: StoredSwarmReceiptIntegrityMaterial): boolean {
  return value.schemaVersion === SWARM_RECEIPT_INTEGRITY_SCHEMA_VERSION
    && typeof value.signatureHmacSha256 === "string"
    && typeof value.keyId === "string"
    && typeof value.signedAt === "string"
    && Array.isArray(value.artifacts);
}

function sameManifest(
  stored: readonly SwarmReceiptIntegrityArtifact[],
  actual: readonly SwarmReceiptIntegrityArtifact[]
): boolean {
  if (stored.length !== actual.length) return false;
  const seen = new Set<string>();
  return stored.every((entry, index) => {
    if (entry.path.includes("..") || entry.path.includes("\\") || seen.has(entry.path)) return false;
    seen.add(entry.path);
    const expected = actual[index];
    return expected !== undefined
      && entry.path === expected.path
      && entry.sha256 === expected.sha256
      && entry.bytes === expected.bytes;
  });
}

function tamper(
  material: Partial<StoredSwarmReceiptIntegrityMaterial>,
  reason: string
): SwarmReceiptIntegritySummary {
  return {
    state: "tamper_detected",
    ...(typeof material.taskVerificationState === "string"
      ? { taskVerificationState: material.taskVerificationState }
      : {}),
    ...(typeof material.keyId === "string" ? { keyId: material.keyId } : {}),
    ...(typeof material.signedAt === "string" ? { signedAt: material.signedAt } : {}),
    reason
  };
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function keyFileName(swarmId: string): string {
  return `swarm-${swarmId}.key`;
}

function assertContained(parent: string, child: string): void {
  const value = relative(parent, child);
  if (value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value))) return;
  throw new Error("SWARM_INTEGRITY_PATH_ESCAPE");
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeExactOnce(path: string, contents: string): Promise<void> {
  const existing = await lstat(path).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error("UNSAFE_SWARM_INTEGRITY_PATH");
  if (existing) {
    if (await readFile(path, "utf8") === contents) return;
    throw new Error("SWARM_INTEGRITY_IDENTITY_CONFLICT");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
    if (await readFile(path, "utf8") === contents) return;
    throw new Error("SWARM_INTEGRITY_IDENTITY_CONFLICT");
  } finally {
    await handle?.close();
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
