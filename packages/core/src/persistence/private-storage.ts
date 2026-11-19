import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveReceiptIntegrityRoot(env: NodeJS.ProcessEnv = process.env): string {
  return (env["MARTIN_INTEGRITY_KEY_DIR"] as string | undefined)?.trim()
    ?? join(homedir(), ".martin", "receipt-integrity");
}

export function resolvePersistenceLeaseRoot(env: NodeJS.ProcessEnv = process.env): string {
  return (env["MARTIN_PERSISTENCE_LEASE_DIR"] as string | undefined)?.trim()
    ?? join(homedir(), ".martin", "persistence-leases");
}

export function resolvePrivateIntegrityKeyPath(runsRoot: string, keyFileName: string): string {
  const rootHash = createHash("sha256").update(runsRoot).digest("hex").slice(0, 16);
  return join(resolveReceiptIntegrityRoot(), rootHash, keyFileName);
}

export function resolvePrivatePersistenceLeasePath(runsRoot: string, leaseFileName: string): string {
  const rootHash = createHash("sha256").update(runsRoot).digest("hex").slice(0, 16);
  return join(resolvePersistenceLeaseRoot(), rootHash, leaseFileName);
}
