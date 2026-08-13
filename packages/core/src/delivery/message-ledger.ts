import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DELIVERY_RECORD_SCHEMA_VERSION, type DeliveryMessage, type DeliveryRecord } from "@martin/contracts";

const EMPTY_RECORD: DeliveryRecord = {
  schemaVersion: DELIVERY_RECORD_SCHEMA_VERSION,
  dismissedIds: [],
};

/**
 * Load DeliveryRecord from disk. Returns empty record on any read/parse failure — never throws.
 */
export function loadDeliveryRecord(ledgerPath: string): DeliveryRecord {
  try {
    const raw = fs.readFileSync(ledgerPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>)["schemaVersion"] === DELIVERY_RECORD_SCHEMA_VERSION
    ) {
      return parsed as DeliveryRecord;
    }
  } catch {
    // file missing or corrupt — start fresh
  }
  return { ...EMPTY_RECORD, dismissedIds: [] };
}

/**
 * Persist DeliveryRecord atomically via temp-file + rename.
 */
export function saveDeliveryRecord(ledgerPath: string, record: DeliveryRecord): void {
  const dir = path.dirname(ledgerPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(os.tmpdir(), `martin-dlv-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
  fs.renameSync(tmp, ledgerPath);
}

/**
 * Returns true when the cooldown period has elapsed and the message should be shown.
 * Clock-skew safe: if now < lastShownAtEpochMs (clock jumped back), treat cooldown as expired.
 */
export function isCooldownExpired(record: DeliveryRecord, nowMs: number): boolean {
  const until = record.cooldownUntilEpochMs;
  if (until === undefined) return true;
  const last = record.lastShownAtEpochMs ?? 0;
  // If clock appears to have gone backwards past last-shown, treat as expired
  if (nowMs < last) return true;
  return nowMs >= until;
}

/**
 * Returns true if this message id was permanently dismissed.
 */
export function isDismissed(record: DeliveryRecord, messageId: string): boolean {
  return record.dismissedIds.includes(messageId);
}

/**
 * Record that a message was shown. Updates cooldown window.
 */
export function recordShown(
  record: DeliveryRecord,
  message: DeliveryMessage,
  nowMs: number
): DeliveryRecord {
  return {
    ...record,
    lastMessageId: message.id,
    lastShownAtEpochMs: nowMs,
    cooldownUntilEpochMs: nowMs + message.cooldownHours * 60 * 60 * 1000,
  };
}

/**
 * Record that a message was permanently dismissed.
 */
export function recordDismissed(record: DeliveryRecord, messageId: string): DeliveryRecord {
  if (record.dismissedIds.includes(messageId)) return record;
  return {
    ...record,
    dismissedIds: [...record.dismissedIds, messageId],
  };
}

/**
 * Cache a fetched message for offline use.
 */
export function cacheMessage(
  record: DeliveryRecord,
  message: DeliveryMessage,
  nowMs: number
): DeliveryRecord {
  return {
    ...record,
    cachedMessage: message,
    cachedAtEpochMs: nowMs,
  };
}

/**
 * Resolve the default ledger path: $MARTIN_STATE_DIR/delivery-record.json
 * or ~/.martin/delivery-record.json.
 */
export function resolveDefaultLedgerPath(): string {
  const stateDir = process.env["MARTIN_STATE_DIR"] ?? path.join(os.homedir(), ".martin");
  return path.join(stateDir, "delivery-record.json");
}
