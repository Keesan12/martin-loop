import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { resolvePrivatePersistenceLeasePath } from "./private-storage.js";

interface LeaseAcquireRecord {
  type: "acquire";
  token: string;
  pid: number;
  acquiredAt: string;
}

interface LeaseReleaseRecord {
  type: "release";
  token: string;
  releasedAt: string;
}

interface LeaseTornTailRecoveryRecord {
  type: "recover-torn-tail";
  recoveredAt: string;
}

type LeaseRecord = LeaseAcquireRecord | LeaseReleaseRecord;

const LEASE_WAIT_TIMEOUT_MS = 30_000;
const TIMEOUT_RELEASE_RETRY_MS = 5_000;

type LeaseAppend = (path: string, value: string) => Promise<void>;
let leaseAppend: LeaseAppend = async (path, value) => {
  await appendFile(path, value, { encoding: "utf8", flag: "a" });
};

export function __setPersistenceLeaseAppendForTests(append: LeaseAppend | undefined): void {
  leaseAppend = append ?? (async (path, value) => {
    await appendFile(path, value, { encoding: "utf8", flag: "a" });
  });
}

export function resolvePersistenceLeasePath(runsRoot: string, runId: string): string {
  const runIdHash = createHash("sha256").update(runId).digest("hex");
  return resolvePrivatePersistenceLeasePath(runsRoot, `lease-${runIdHash}.jsonl`);
}

export async function acquirePersistenceLease(runsRoot: string, runId: string): Promise<() => Promise<void>> {
  const queuePath = resolvePersistenceLeasePath(runsRoot, runId);
  await mkdir(dirname(queuePath), { recursive: true, mode: 0o700 });
  const owner: LeaseAcquireRecord = {
    type: "acquire",
    token: randomUUID(),
    pid: process.pid,
    acquiredAt: new Date().toISOString()
  };
  await appendLeaseRecord(queuePath, owner);
  const deadline = Date.now() + LEASE_WAIT_TIMEOUT_MS;
  while (true) {
    const currentOwner = await readCurrentLeaseOwner(queuePath);
    if (currentOwner?.token === owner.token) {
      let releasePromise: Promise<void> | undefined;
      return async () => {
        if (!releasePromise) {
          const current = appendLeaseRecord(queuePath, {
            type: "release",
            token: owner.token,
            releasedAt: new Date().toISOString()
          });
          releasePromise = current;
          current.catch(() => {
            if (releasePromise === current) releasePromise = undefined;
          });
        }
        await releasePromise;
      };
    }
    if (Date.now() >= deadline) {
      await appendReleaseWithRetry(queuePath, {
        type: "release",
        token: owner.token,
        releasedAt: new Date().toISOString()
      });
      throw Object.assign(new Error(`Timed out waiting for persistence lease: ${runId}`), {
        code: "RUN_STORE_PERSISTENCE_LEASE_TIMEOUT"
      });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function appendLeaseRecord(path: string, record: LeaseRecord): Promise<void> {
  const current = await readFile(path, "utf8").catch(() => "");
  let recoveryBoundary = "";
  if (current.length > 0 && !/\r?\n$/u.test(current)) {
    const finalFragment = current.slice(Math.max(current.lastIndexOf("\n"), current.lastIndexOf("\r")) + 1);
    recoveryBoundary = isCompleteLeaseRecord(finalFragment)
      ? "\n"
      : `\n${JSON.stringify({ type: "recover-torn-tail", recoveredAt: new Date().toISOString() } satisfies LeaseTornTailRecoveryRecord)}\n`;
  }
  await leaseAppend(path, `${recoveryBoundary}${JSON.stringify(record)}\n`);
}

function isCompleteLeaseRecord(fragment: string): boolean {
  try {
    validateLeaseRecord(JSON.parse(fragment));
    return true;
  } catch {
    return false;
  }
}

async function appendReleaseWithRetry(path: string, record: LeaseReleaseRecord): Promise<void> {
  const deadline = Date.now() + TIMEOUT_RELEASE_RETRY_MS;
  while (true) {
    try {
      await appendLeaseRecord(path, record);
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function readCurrentLeaseOwner(path: string): Promise<LeaseAcquireRecord | undefined> {
  const raw = await readFile(path, "utf8");
  const lines = raw.split(/\r?\n/u);
  const acquisitions: LeaseAcquireRecord[] = [];
  const released = new Set<string>();
  const acquiredTokens = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      const recovery = parseTornTailRecoveryRecord(lines[index + 1]);
      if (recovery) {
        index += 1;
        continue;
      }
      throw Object.assign(new Error("Malformed persistence lease queue."), {
        code: "RUN_STORE_PERSISTENCE_LEASE_CORRUPT"
      });
    }
    if (parseTornTailRecoveryRecord(line)) continue;
    const record = validateLeaseRecord(value);
    if (record.type === "acquire") {
      if (acquiredTokens.has(record.token)) {
        throw Object.assign(new Error("Duplicate persistence lease acquisition token."), {
          code: "RUN_STORE_PERSISTENCE_LEASE_CORRUPT"
        });
      }
      acquiredTokens.add(record.token);
      acquisitions.push(record);
    } else {
      if (!acquiredTokens.has(record.token)) {
        throw Object.assign(new Error("Persistence lease released before acquisition."), {
          code: "RUN_STORE_PERSISTENCE_LEASE_CORRUPT"
        });
      }
      released.add(record.token);
    }
  }
  return acquisitions.find((record) => !released.has(record.token) && isProcessAlive(record.pid));
}

function parseTornTailRecoveryRecord(line: string | undefined): LeaseTornTailRecoveryRecord | undefined {
  if (!line) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record["type"] !== "recover-torn-tail" || typeof record["recoveredAt"] !== "string") {
    return undefined;
  }
  return record as unknown as LeaseTornTailRecoveryRecord;
}

function validateLeaseRecord(value: unknown): LeaseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw corruptLeaseRecord();
  }
  const record = value as Record<string, unknown>;
  if (
    record["type"] === "acquire"
    && typeof record["token"] === "string"
    && Number.isInteger(record["pid"])
    && typeof record["acquiredAt"] === "string"
  ) {
    return record as unknown as LeaseAcquireRecord;
  }
  if (
    record["type"] === "release"
    && typeof record["token"] === "string"
    && typeof record["releasedAt"] === "string"
  ) {
    return record as unknown as LeaseReleaseRecord;
  }
  throw corruptLeaseRecord();
}

function corruptLeaseRecord(): Error {
  return Object.assign(new Error("Invalid persistence lease queue record."), {
    code: "RUN_STORE_PERSISTENCE_LEASE_CORRUPT"
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
