import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CoreReceiptIntegrityMaterial {
  schemaVersion: "martin.receipt-integrity.v1";
  runId: string;
  keyId: string;
  signedAt: string;
  scope?: Record<string, unknown>;
  loopRecordSha256: string;
  ledgerSha256: string;
  ledgerHeadHash: string;
  entryCount: number;
  chain: Array<Record<string, unknown>>;
  signatureHmacSha256: string;
}

export interface CoreReceiptBundle {
  loopRecord: Record<string, unknown>;
  ledgerEntries: Array<Record<string, unknown>>;
  integrity: CoreReceiptIntegrityMaterial;
}

/**
 * Mirrors the share-command privacy convention without coupling hosted sync to
 * non-sync command code. Local persisted receipts remain byte-for-byte unchanged.
 */
export function redactHostedSyncValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactAbsolutePaths(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactHostedSyncValue(entry));
  }

  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactHostedSyncValue(entry)])
    );
  }

  return value;
}

/**
 * Builds a privacy-safe transport projection of a persisted Core receipt.
 *
 * Fail closed: the raw persisted receipt must verify against its existing local
 * HMAC before any transformed receipt is signed. If the key is unavailable,
 * mismatched, or the persisted receipt is tampered, no receipt is transported.
 */
export async function buildPrivacySafeCoreReceiptBundle(input: {
  runsRoot: string;
  loopRecord: Record<string, unknown>;
  ledgerEntries: Array<Record<string, unknown>>;
  integrity: CoreReceiptIntegrityMaterial;
}): Promise<CoreReceiptBundle | undefined> {
  const { runsRoot, loopRecord, ledgerEntries, integrity } = input;
  const key = await readReceiptIntegrityKey(runsRoot, integrity.runId).catch(() => undefined);
  if (!key) return undefined;

  const keyId = sha256(key).slice(0, 16);
  if (keyId !== integrity.keyId) return undefined;
  if (!verifyRawReceipt(loopRecord, ledgerEntries, integrity, key)) return undefined;

  const sanitizedLoopRecord = redactHostedSyncValue(loopRecord);
  const sanitizedLedgerEntries = redactHostedSyncValue(ledgerEntries);
  const sanitizedScope = integrity.scope === undefined
    ? undefined
    : redactHostedSyncValue(integrity.scope);

  if (!isPlainRecord(sanitizedLoopRecord) || !Array.isArray(sanitizedLedgerEntries)) {
    return undefined;
  }
  if (sanitizedLedgerEntries.some((entry) => !isPlainRecord(entry))) {
    return undefined;
  }
  if (sanitizedScope !== undefined && !isPlainRecord(sanitizedScope)) {
    return undefined;
  }

  const safeLedger = sanitizedLedgerEntries as Array<Record<string, unknown>>;
  const chain = buildReceiptIntegrityChain(safeLedger);
  const materialBase = {
    schemaVersion: integrity.schemaVersion,
    runId: integrity.runId,
    keyId,
    signedAt: integrity.signedAt,
    ...(sanitizedScope ? { scope: sanitizedScope } : {}),
    loopRecordSha256: sha256(serializeStoredJson(sanitizedLoopRecord)),
    ledgerSha256: sha256(serializeStoredJsonl(safeLedger)),
    ledgerHeadHash: chain.at(-1)?.entryHash ?? "root",
    entryCount: chain.length,
    chain,
  } satisfies Omit<CoreReceiptIntegrityMaterial, "signatureHmacSha256">;

  return {
    loopRecord: sanitizedLoopRecord,
    ledgerEntries: safeLedger,
    integrity: {
      ...materialBase,
      signatureHmacSha256: createHmac("sha256", key)
        .update(JSON.stringify(materialBase))
        .digest("hex"),
    },
  };
}

function verifyRawReceipt(
  loopRecord: Record<string, unknown>,
  ledgerEntries: Array<Record<string, unknown>>,
  integrity: CoreReceiptIntegrityMaterial,
  key: string
): boolean {
  if (integrity.schemaVersion !== "martin.receipt-integrity.v1") return false;
  if (loopRecord["loopId"] !== integrity.runId) return false;
  if (sha256(serializeStoredJson(loopRecord)) !== integrity.loopRecordSha256) return false;
  if (sha256(serializeStoredJsonl(ledgerEntries)) !== integrity.ledgerSha256) return false;

  const chain = buildReceiptIntegrityChain(ledgerEntries);
  if (
    integrity.entryCount !== chain.length ||
    integrity.chain.length !== chain.length ||
    integrity.ledgerHeadHash !== (chain.at(-1)?.entryHash ?? "root") ||
    chain.some((entry, index) => {
      const signed = integrity.chain[index];
      return !signed ||
        signed["entryHash"] !== entry["entryHash"] ||
        signed["prevHash"] !== entry["prevHash"];
    })
  ) {
    return false;
  }

  const signatureBase = {
    schemaVersion: integrity.schemaVersion,
    runId: integrity.runId,
    keyId: integrity.keyId,
    signedAt: integrity.signedAt,
    ...(integrity.scope ? { scope: integrity.scope } : {}),
    loopRecordSha256: integrity.loopRecordSha256,
    ledgerSha256: integrity.ledgerSha256,
    ledgerHeadHash: integrity.ledgerHeadHash,
    entryCount: integrity.entryCount,
    chain: integrity.chain,
  };
  const expectedSignature = createHmac("sha256", key)
    .update(JSON.stringify(signatureBase))
    .digest("hex");

  return safeEqualHex(expectedSignature, integrity.signatureHmacSha256);
}

interface ReceiptIntegrityChainEntry extends Record<string, unknown> {
  index: number;
  prevHash: string;
  entryHash: string;
  eventId?: string;
  type?: string;
  kind?: string;
  timestamp?: string;
}

function buildReceiptIntegrityChain(entries: Array<Record<string, unknown>>): ReceiptIntegrityChainEntry[] {
  let previousHash = "root";
  return entries.map((entry, index) => {
    const entryHash = sha256(`${previousHash}\n${JSON.stringify(entry)}`);
    const chainEntry: ReceiptIntegrityChainEntry = {
      index,
      prevHash: previousHash,
      entryHash,
    };

    if (typeof entry["eventId"] === "string") chainEntry["eventId"] = entry["eventId"];
    if (typeof entry["type"] === "string") chainEntry["type"] = entry["type"];
    if (typeof entry["kind"] === "string") chainEntry["kind"] = entry["kind"];
    if (typeof entry["timestamp"] === "string") chainEntry["timestamp"] = entry["timestamp"];

    previousHash = entryHash;
    return chainEntry;
  });
}

async function readReceiptIntegrityKey(runsRoot: string, runId: string): Promise<string> {
  const rootHash = sha256(runsRoot).slice(0, 16);
  const keyRoot = process.env["MARTIN_INTEGRITY_KEY_DIR"]?.trim() ??
    join(homedir(), ".martin", "receipt-integrity");
  const raw = await readFile(join(keyRoot, rootHash, `${runId}.key`), "utf8");
  return raw.trim();
}

function redactAbsolutePaths(text: string): string {
  return text
    .replace(/file:\/\/\/[^\s")\]]+/gu, redactPathMatch)
    .replace(/\\\\[^\\/\r\n]+[\\/][^\r\n]+/gu, redactPathMatch)
    .replace(/[A-Za-z]:[\\/][^\r\n]+/gu, redactPathMatch)
    .replace(/\/(?:Users|home|tmp|var|private|mnt|workspace|repo|opt)\/[^\r\n]+/gu, redactPathMatch);
}

function redactPathMatch(match: string): string {
  const normalized = match.replace(/^file:\/\/\//u, "").replace(/\\/gu, "/").trim();
  const trimmed = normalized.replace(/[),.;:]+$/u, "");
  const suffix = normalized.slice(trimmed.length);
  const basename = trimmed.split("/").filter(Boolean).at(-1) ?? "artifact";
  return `[redacted-path]/${basename}${suffix}`;
}

function serializeStoredJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function serializeStoredJsonl(entries: Array<Record<string, unknown>>): string {
  if (entries.length === 0) return "";
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
