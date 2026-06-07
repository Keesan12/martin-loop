import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  LoopRecord,
  ReceiptIntegritySummary,
  ReceiptScope
} from "@martin/contracts";

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

const RECEIPT_INTEGRITY_SCHEMA_VERSION = "martin.receipt-integrity.v1";
const RECEIPT_INTEGRITY_KEY_DIR_MODE = 0o700;
const RECEIPT_INTEGRITY_KEY_FILE_MODE = 0o600;

export async function writeReceiptIntegrityMaterial(input: {
  runId: string;
  runsRoot: string;
  loopRecord: LoopRecord;
  ledgerEntries: unknown[];
  scope?: ReceiptScope;
  signedAt?: string;
}): Promise<StoredReceiptIntegrityMaterial> {
  const signedAt = input.signedAt ?? new Date().toISOString();
  const [key, keyId] = await ensureReceiptIntegrityKey(input.runsRoot, input.runId);
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
  await writeFile(
    resolveReceiptIntegrityPath(input.runsRoot, input.runId),
    serializeStoredJson(material),
    "utf8"
  );

  return material;
}

export async function verifyReceiptIntegrityFromFiles(input: {
  runId: string;
  runsRoot: string;
  loopRecordPath: string;
  ledgerPath: string;
}): Promise<ReceiptIntegritySummary> {
  const integrityPath = resolveReceiptIntegrityPath(input.runsRoot, input.runId);
  const [rawMaterial, rawLoopRecord, rawLedger, key] = await Promise.all([
    readFile(integrityPath, "utf8").catch(() => null),
    readFile(input.loopRecordPath, "utf8").catch(() => null),
    readFile(input.ledgerPath, "utf8").catch(() => null),
    readReceiptIntegrityKey(input.runsRoot, input.runId).catch(() => null)
  ]);

  if (!rawMaterial || !rawLoopRecord || rawLedger === null || !key) {
    return {
      state: "unsigned",
      reason: "Receipt integrity material is missing for this run.",
      warnings: ["Receipts are local-only and unsigned; trust claims are unavailable."]
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
  return createHmac("sha256", key).update(JSON.stringify(material)).digest("hex");
}

async function ensureReceiptIntegrityKey(runsRoot: string, runId: string): Promise<[string, string]> {
  const keyPath = resolveReceiptIntegrityKeyPath(runsRoot, runId);
  const existing = await readFile(keyPath, "utf8").catch(() => null);
  if (existing) {
    const trimmed = existing.trim();
    return [trimmed, sha256(trimmed).slice(0, 16)];
  }

  const generated = randomBytes(32).toString("hex");
  await mkdir(dirname(keyPath), { recursive: true, mode: RECEIPT_INTEGRITY_KEY_DIR_MODE });
  await writeFile(keyPath, `${generated}\n`, {
    encoding: "utf8",
    mode: RECEIPT_INTEGRITY_KEY_FILE_MODE
  });
  return [generated, sha256(generated).slice(0, 16)];
}

async function readReceiptIntegrityKey(runsRoot: string, runId: string): Promise<string> {
  const raw = await readFile(resolveReceiptIntegrityKeyPath(runsRoot, runId), "utf8");
  return raw.trim();
}

function resolveReceiptIntegrityKeyPath(runsRoot: string, runId: string): string {
  const rootHash = sha256(runsRoot).slice(0, 16);
  return join(homedir(), ".martin", "receipt-integrity", rootHash, `${runId}.key`);
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
