import { createHash, createHmac, randomBytes } from "node:crypto";
import { link, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  LoopRecord,
  ReceiptIntegritySummary,
  ReceiptScope
} from "@martin/contracts";

import { acquirePersistenceLease } from "./lease.js";
import { renameAtomically } from "./atomic-replace.js";
import {
  resolvePrivateIntegrityKeyPath,
  resolveReceiptIntegrityRoot
} from "./private-storage.js";

export { resolvePrivateIntegrityKeyPath, resolveReceiptIntegrityRoot } from "./private-storage.js";

export interface ReceiptIntegrityChainEntry {
  index: number;
  eventId?: string;
  type?: string;
  kind?: string;
  timestamp?: string;
  prevHash: string;
  entryHash: string;
}

export interface StoredReceiptIntegrityMaterial {
  schemaVersion: "martin.receipt-integrity.v1";
  runId: string;
  keyId: string;
  signedAt: string;
  scope?: ReceiptScope;
  loopRecordSha256: string;
  ledgerSha256: string;
  ledgerHeadHash: string;
  entryCount: number;
  chain: ReceiptIntegrityChainEntry[];
  signatureHmacSha256: string;
}

export interface ReceiptIntegrityTransaction {
  schemaVersion: "martin.receipt-transaction.v1";
  runId: string;
  createdAt: string;
  baseLoopRecordSha256: string;
  baseLedgerSha256: string;
  targetLoopRecord: LoopRecord;
  targetLedgerEntries: unknown[];
  scope?: ReceiptScope;
  signatureHmacSha256: string;
}

const RECEIPT_INTEGRITY_SCHEMA_VERSION = "martin.receipt-integrity.v1";
const RECEIPT_TRANSACTION_SCHEMA_VERSION = "martin.receipt-transaction.v1";
const RECEIPT_INTEGRITY_KEY_DIR_MODE = 0o700;
const RECEIPT_INTEGRITY_KEY_FILE_MODE = 0o600;

export async function writeReceiptIntegrityMaterial(input: {
  runId: string;
  runsRoot: string;
  loopRecord: LoopRecord;
  ledgerEntries: unknown[];
  scope?: ReceiptScope;
  signedAt?: string;
}): Promise<StoredReceiptIntegrityMaterial | undefined> {
  const signedAt = input.signedAt ?? new Date().toISOString();
  const keyMaterial = await ensureReceiptIntegrityKey(input.runsRoot, input.runId);
  if (!keyMaterial) {
    return undefined;
  }
  const [key, keyId] = keyMaterial;
  const chain = buildReceiptIntegrityChain(input.ledgerEntries);
  const loopRecordRaw = serializeStoredJson(input.loopRecord);
  const ledgerRaw = serializeStoredJsonl(input.ledgerEntries);
  const materialBase = {
    schemaVersion: RECEIPT_INTEGRITY_SCHEMA_VERSION,
    runId: input.runId,
    keyId,
    signedAt,
    ...(input.scope ? { scope: input.scope } : {}),
    loopRecordSha256: sha256(loopRecordRaw),
    ledgerSha256: sha256(ledgerRaw),
    ledgerHeadHash: chain.at(-1)?.entryHash ?? "root",
    entryCount: chain.length,
    chain
  } satisfies Omit<StoredReceiptIntegrityMaterial, "signatureHmacSha256">;

  const material: StoredReceiptIntegrityMaterial = {
    ...materialBase,
    signatureHmacSha256: createReceiptIntegritySignature(key, materialBase)
  };

  await mkdir(join(input.runsRoot, input.runId), { recursive: true });
  await writeFileAtomically(
    resolveReceiptIntegrityPath(input.runsRoot, input.runId),
    serializeStoredJson(material)
  );

  return material;
}

export async function verifyReceiptIntegrityFromFiles(input: {
  runId: string;
  runsRoot: string;
  loopRecordPath: string;
  ledgerPath: string;
  integrityPath?: string;
}): Promise<ReceiptIntegritySummary> {
  const release = await acquirePersistenceLease(input.runsRoot, input.runId);
  try {
    return await verifyReceiptIntegrityFromFilesAssumeLeaseHeld(input);
  } finally {
    await release();
  }
}

async function verifyReceiptIntegrityFromFilesAssumeLeaseHeld(input: {
  runId: string;
  runsRoot: string;
  loopRecordPath: string;
  ledgerPath: string;
  integrityPath?: string;
}): Promise<ReceiptIntegritySummary> {
  try {
    await recoverReceiptIntegrityTransactionAssumeLeaseHeld({ runId: input.runId, runsRoot: input.runsRoot });
  } catch (error) {
    return {
      state: "tamper_detected",
      reason: error instanceof Error ? error.message : "receipt_transaction_recovery_failed"
    };
  }
  const integrityPath = input.integrityPath ?? resolveReceiptIntegrityPath(input.runsRoot, input.runId);
  const [rawMaterial, rawLoopRecord, rawLedger, key] = await Promise.all([
    readFile(integrityPath, "utf8").catch(() => null),
    readFile(input.loopRecordPath, "utf8").catch(() => null),
    readFile(input.ledgerPath, "utf8").catch(() => null),
    readReceiptIntegrityKey(input.runsRoot, input.runId).catch(() => null)
  ]);

  if (!rawMaterial || !rawLoopRecord || rawLedger === null || !key) {
    return {
      state: "material_missing",
      reason: "Receipt integrity material is missing for this run.",
      warnings: ["Receipt integrity material is incomplete; trust claims are unavailable."]
    };
  }

  let material: StoredReceiptIntegrityMaterial;
  try {
    material = JSON.parse(rawMaterial) as StoredReceiptIntegrityMaterial;
  } catch {
    return {
      state: "tamper_detected",
      reason: "Receipt integrity metadata is unreadable."
    };
  }

  const actualLoopRecordSha256 = sha256(rawLoopRecord);
  if (actualLoopRecordSha256 !== material.loopRecordSha256) {
    return {
      state: "tamper_detected",
      keyId: material.keyId,
      signedAt: material.signedAt,
      loopRecordSha256: material.loopRecordSha256,
      ledgerSha256: material.ledgerSha256,
      ledgerHeadHash: material.ledgerHeadHash,
      entryCount: material.entryCount,
      reason: "loop_record_hash_mismatch"
    };
  }

  const actualLedgerSha256 = sha256(rawLedger);
  if (actualLedgerSha256 !== material.ledgerSha256) {
    return {
      state: "tamper_detected",
      keyId: material.keyId,
      signedAt: material.signedAt,
      loopRecordSha256: material.loopRecordSha256,
      ledgerSha256: material.ledgerSha256,
      ledgerHeadHash: material.ledgerHeadHash,
      entryCount: material.entryCount,
      reason: "ledger_hash_mismatch"
    };
  }

  let parsedLedgerEntries: unknown[];
  try {
    parsedLedgerEntries = rawLedger
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    return {
      state: "tamper_detected",
      keyId: material.keyId,
      signedAt: material.signedAt,
      loopRecordSha256: material.loopRecordSha256,
      ledgerSha256: material.ledgerSha256,
      ledgerHeadHash: material.ledgerHeadHash,
      entryCount: material.entryCount,
      reason: "ledger_entry_parse_error"
    };
  }
  const actualChain = buildReceiptIntegrityChain(parsedLedgerEntries);
  if (actualChain.length !== material.chain.length) {
    return {
      state: "tamper_detected",
      keyId: material.keyId,
      signedAt: material.signedAt,
      loopRecordSha256: material.loopRecordSha256,
      ledgerSha256: material.ledgerSha256,
      ledgerHeadHash: material.ledgerHeadHash,
      entryCount: material.entryCount,
      reason: "ledger_entry_count_mismatch"
    };
  }

  for (let index = 0; index < actualChain.length; index += 1) {
    const expected = material.chain[index];
    const actual = actualChain[index];
    if (
      !expected ||
      !actual ||
      expected.entryHash !== actual.entryHash ||
      expected.prevHash !== actual.prevHash
    ) {
      return {
        state: "tamper_detected",
        keyId: material.keyId,
        signedAt: material.signedAt,
        loopRecordSha256: material.loopRecordSha256,
        ledgerSha256: material.ledgerSha256,
        ledgerHeadHash: material.ledgerHeadHash,
        entryCount: material.entryCount,
        reason: `ledger_chain_mismatch:${index}`
      };
    }
  }

  const signatureBase = {
    schemaVersion: material.schemaVersion,
    runId: material.runId,
    keyId: material.keyId,
    signedAt: material.signedAt,
    ...(material.scope ? { scope: material.scope } : {}),
    loopRecordSha256: material.loopRecordSha256,
    ledgerSha256: material.ledgerSha256,
    ledgerHeadHash: material.ledgerHeadHash,
    entryCount: material.entryCount,
    chain: material.chain
  };
  const expectedSignature = createReceiptIntegritySignature(key, signatureBase);
  if (expectedSignature !== material.signatureHmacSha256) {
    return {
      state: "tamper_detected",
      keyId: material.keyId,
      signedAt: material.signedAt,
      loopRecordSha256: material.loopRecordSha256,
      ledgerSha256: material.ledgerSha256,
      ledgerHeadHash: material.ledgerHeadHash,
      entryCount: material.entryCount,
      reason: "signature_mismatch"
    };
  }

  return {
    state: "verified",
    keyId: material.keyId,
    signedAt: material.signedAt,
    loopRecordSha256: material.loopRecordSha256,
    ledgerSha256: material.ledgerSha256,
    ledgerHeadHash: material.ledgerHeadHash,
    entryCount: material.entryCount
  };
}

export async function writeReceiptIntegrityTransaction(input: {
  runId: string;
  runsRoot: string;
  targetLoopRecord: LoopRecord;
  targetLedgerEntries: unknown[];
  scope?: ReceiptScope;
  createdAt?: string;
}): Promise<ReceiptIntegrityTransaction> {
  const release = await acquirePersistenceLease(input.runsRoot, input.runId);
  try {
    return await writeReceiptIntegrityTransactionAssumeLeaseHeld(input);
  } finally {
    await release();
  }
}

export async function writeReceiptIntegrityTransactionAssumeLeaseHeld(input: {
  runId: string;
  runsRoot: string;
  targetLoopRecord: LoopRecord;
  targetLedgerEntries: unknown[];
  scope?: ReceiptScope;
  createdAt?: string;
}): Promise<ReceiptIntegrityTransaction> {
  const dir = runDirForIntegrity(input.runsRoot, input.runId);
  const loopRecordPath = join(dir, "loop-record.json");
  const ledgerPath = join(dir, "ledger.jsonl");
  const baseIntegrity = await verifyReceiptIntegrityFromFilesAssumeLeaseHeld({
    runId: input.runId,
    runsRoot: input.runsRoot,
    loopRecordPath,
    ledgerPath
  });
  if (baseIntegrity.state !== "verified") {
    throw new Error(`receipt_transaction_base_untrusted:${baseIntegrity.state}:${baseIntegrity.reason ?? "unknown"}`);
  }
  const keyMaterial = await ensureReceiptIntegrityKey(input.runsRoot, input.runId);
  if (!keyMaterial) throw new Error("receipt_transaction_key_unavailable");
  const [key] = keyMaterial;
  const [baseLoopRaw, baseLedgerRaw] = await Promise.all([
    readFile(loopRecordPath, "utf8"),
    readFile(ledgerPath, "utf8").catch(() => "")
  ]);
  if (
    sha256(baseLoopRaw) !== baseIntegrity.loopRecordSha256
    || sha256(baseLedgerRaw) !== baseIntegrity.ledgerSha256
  ) {
    throw new Error("receipt_transaction_base_changed");
  }
  const base = {
    schemaVersion: RECEIPT_TRANSACTION_SCHEMA_VERSION,
    runId: input.runId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    baseLoopRecordSha256: sha256(baseLoopRaw),
    baseLedgerSha256: sha256(baseLedgerRaw),
    targetLoopRecord: input.targetLoopRecord,
    targetLedgerEntries: input.targetLedgerEntries,
    ...(input.scope ? { scope: input.scope } : {})
  } satisfies Omit<ReceiptIntegrityTransaction, "signatureHmacSha256">;
  const transaction: ReceiptIntegrityTransaction = {
    ...base,
    signatureHmacSha256: createPrivateIntegrityHmac(key, base)
  };
  const path = resolveReceiptIntegrityTransactionPath(input.runsRoot, input.runId);
  await mkdir(dirname(path), { recursive: true, mode: RECEIPT_INTEGRITY_KEY_DIR_MODE });
  await writeFileAtomically(path, serializeStoredJson(transaction), RECEIPT_INTEGRITY_KEY_FILE_MODE, true);
  return transaction;
}

export async function recoverReceiptIntegrityTransaction(input: {
  runId: string;
  runsRoot: string;
}): Promise<boolean> {
  const release = await acquirePersistenceLease(input.runsRoot, input.runId);
  try {
    return await recoverReceiptIntegrityTransactionAssumeLeaseHeld(input);
  } finally {
    await release();
  }
}

export async function recoverReceiptIntegrityTransactionAssumeLeaseHeld(input: {
  runId: string;
  runsRoot: string;
}): Promise<boolean> {
  const path = resolveReceiptIntegrityTransactionPath(input.runsRoot, input.runId);
  const transactionStat = await lstat(path).catch(() => undefined);
  if (!transactionStat) return false;
  if (transactionStat.isSymbolicLink() || !transactionStat.isFile()) {
    throw new Error("receipt_transaction_path_invalid");
  }
  const [raw, key] = await Promise.all([
    readFile(path, "utf8"),
    readReceiptIntegrityKey(input.runsRoot, input.runId)
  ]);
  let transaction: ReceiptIntegrityTransaction;
  try {
    transaction = JSON.parse(raw) as ReceiptIntegrityTransaction;
  } catch {
    throw new Error("receipt_transaction_unreadable");
  }
  if (transaction.schemaVersion !== RECEIPT_TRANSACTION_SCHEMA_VERSION || transaction.runId !== input.runId) {
    throw new Error("receipt_transaction_binding_mismatch");
  }
  const { signatureHmacSha256, ...base } = transaction;
  if (createPrivateIntegrityHmac(key, base) !== signatureHmacSha256) {
    throw new Error("receipt_transaction_signature_mismatch");
  }
  const dir = runDirForIntegrity(input.runsRoot, input.runId);
  const [actualLoopRaw, actualLedgerRaw] = await Promise.all([
    readFile(join(dir, "loop-record.json"), "utf8"),
    readFile(join(dir, "ledger.jsonl"), "utf8").catch(() => "")
  ]);
  const targetLoopRaw = serializeStoredJson(transaction.targetLoopRecord);
  const targetLedgerRaw = serializeStoredJsonl(transaction.targetLedgerEntries);
  const allowedLoopHashes = new Set([transaction.baseLoopRecordSha256, sha256(targetLoopRaw)]);
  const allowedLedgerHashes = new Set([transaction.baseLedgerSha256, sha256(targetLedgerRaw)]);
  if (!allowedLoopHashes.has(sha256(actualLoopRaw)) || !allowedLedgerHashes.has(sha256(actualLedgerRaw))) {
    throw new Error("receipt_transaction_state_mismatch");
  }
  await writeFileAtomically(join(dir, "ledger.jsonl"), targetLedgerRaw);
  await writeFileAtomically(join(dir, "loop-record.json"), targetLoopRaw);
  await writeReceiptIntegrityMaterial({
    runId: input.runId,
    runsRoot: input.runsRoot,
    loopRecord: transaction.targetLoopRecord,
    ledgerEntries: transaction.targetLedgerEntries,
    ...(transaction.scope ? { scope: transaction.scope } : {}),
    signedAt: transaction.targetLoopRecord.updatedAt
  });
  await rm(path, { force: true });
  return true;
}

export function resolveReceiptIntegrityTransactionPath(runsRoot: string, runId: string): string {
  return resolvePrivateIntegrityKeyPath(runsRoot, `${runId}.transaction.json`);
}

function runDirForIntegrity(runsRoot: string, runId: string): string {
  return join(runsRoot, runId);
}

export function resolveReceiptIntegrityPath(runsRoot: string, runId: string): string {
  return join(runsRoot, runId, "receipt-integrity.json");
}

function buildReceiptIntegrityChain(entries: unknown[]): ReceiptIntegrityChainEntry[] {
  let previousHash = "root";
  return entries.map((entry, index) => {
    const normalizedEntry = JSON.stringify(entry);
    const entryHash = sha256(`${previousHash}\n${normalizedEntry}`);
    const candidate = entry as { eventId?: unknown; type?: unknown; kind?: unknown; timestamp?: unknown };
    const chainEntry: ReceiptIntegrityChainEntry = {
      index,
      prevHash: previousHash,
      entryHash
    };

    if (typeof candidate.eventId === "string") {
      chainEntry.eventId = candidate.eventId;
    }
    if (typeof candidate.type === "string") {
      chainEntry.type = candidate.type;
    }
    if (typeof candidate.kind === "string") {
      chainEntry.kind = candidate.kind;
    }
    if (typeof candidate.timestamp === "string") {
      chainEntry.timestamp = candidate.timestamp;
    }

    previousHash = entryHash;
    return chainEntry;
  });
}

function createReceiptIntegritySignature(
  key: string,
  material: Omit<StoredReceiptIntegrityMaterial, "signatureHmacSha256">
): string {
  return createPrivateIntegrityHmac(key, material);
}

async function ensureReceiptIntegrityKey(runsRoot: string, runId: string): Promise<[string, string] | undefined> {
  return ensurePrivateIntegrityKey(runsRoot, `${runId}.key`);
}

export async function ensurePrivateIntegrityKey(
  runsRoot: string,
  keyFileName: string
): Promise<[string, string] | undefined> {
  const keyPath = resolvePrivateIntegrityKeyPath(runsRoot, keyFileName);
  const existingStat = await lstat(keyPath).catch(() => undefined);
  if (existingStat?.isSymbolicLink() || (existingStat && !existingStat.isFile())) {
    return undefined;
  }
  const existing = await readFile(keyPath, "utf8").catch(() => null);
  if (existing) {
    const trimmed = existing.trim();
    return [trimmed, sha256(trimmed).slice(0, 16)];
  }

  const generated = randomBytes(32).toString("hex");
  try {
    await mkdir(dirname(keyPath), { recursive: true, mode: RECEIPT_INTEGRITY_KEY_DIR_MODE });
    await writeFile(keyPath, `${generated}\n`, {
      encoding: "utf8",
      mode: RECEIPT_INTEGRITY_KEY_FILE_MODE
    });
  } catch {
    return undefined;
  }
  return [generated, sha256(generated).slice(0, 16)];
}

async function readReceiptIntegrityKey(runsRoot: string, runId: string): Promise<string> {
  return readPrivateIntegrityKey(runsRoot, `${runId}.key`);
}

export async function readPrivateIntegrityKey(runsRoot: string, keyFileName: string): Promise<string> {
  const raw = await readFile(resolvePrivateIntegrityKeyPath(runsRoot, keyFileName), "utf8");
  return raw.trim();
}

export function createPrivateIntegrityHmac(key: string, material: unknown): string {
  return createHmac("sha256", key).update(JSON.stringify(material)).digest("hex");
}

function serializeStoredJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function serializeStoredJsonl(entries: unknown[]): string {
  if (entries.length === 0) {
    return "";
  }
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeFileAtomically(path: string, value: string, mode?: number, publishIfAbsent = false): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, value, {
      encoding: "utf8",
      ...(mode === undefined ? {} : { mode })
    });
    if (publishIfAbsent) await link(temporaryPath, path);
    else await renameAtomically(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}
