// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { resolveMartinHome } from "./home-dir.js";

export interface MartinMcpInstallRecord {
  id: string;
  host: string;
  scope: string;
  targetPath: string;
  installedSha256: string;
  backupPath: string | null;
  installedAt: string;
}

export interface MartinMcpInstallLedger {
  schemaVersion: 1;
  installs: MartinMcpInstallRecord[];
}

export interface RecordMartinMcpInstallInput {
  host: string;
  scope: string;
  targetPath: string;
  content: string;
  previousContent?: string;
  stateRoot?: string;
}

export interface MartinMcpInstallSelector {
  host: string;
  scope: string;
  targetPath: string;
  stateRoot?: string;
}

export interface MartinMcpInstallVerification {
  status: "ok" | "missing_record" | "missing" | "modified";
  targetPath: string;
  record: MartinMcpInstallRecord | null;
}

export async function recordMartinMcpInstall(
  input: RecordMartinMcpInstallInput
): Promise<MartinMcpInstallRecord> {
  const stateRoot = resolveMartinMcpInstallStateRoot(input.stateRoot);
  const recordId = randomUUID();
  const backupPath = input.previousContent === undefined
    ? null
    : join(stateRoot, "backups", `${recordId}.bak`);

  if (backupPath && input.previousContent !== undefined) {
    await writeFileAtomically(backupPath, input.previousContent);
  }

  await writeFileAtomically(input.targetPath, input.content);

  const ledger = await readMartinMcpInstallLedger(stateRoot);
  const record: MartinMcpInstallRecord = {
    id: recordId,
    host: input.host,
    scope: input.scope,
    targetPath: input.targetPath,
    installedSha256: sha256(input.content),
    backupPath,
    installedAt: new Date().toISOString()
  };
  ledger.installs.push(record);
  await writeLedger(stateRoot, ledger);
  return record;
}

export async function readMartinMcpInstallLedger(
  stateRoot = resolveMartinMcpInstallStateRoot()
): Promise<MartinMcpInstallLedger> {
  try {
    const parsed = JSON.parse(
      await readFile(join(stateRoot, "install-state.json"), "utf8")
    ) as MartinMcpInstallLedger;
    if (parsed.schemaVersion === 1 && Array.isArray(parsed.installs)) {
      return parsed;
    }
  } catch {
    // Missing or invalid state is an empty local ledger, never evidence of an install.
  }
  return { schemaVersion: 1, installs: [] };
}

export async function verifyMartinMcpInstall(
  selector: MartinMcpInstallSelector
): Promise<MartinMcpInstallVerification> {
  const stateRoot = resolveMartinMcpInstallStateRoot(selector.stateRoot);
  const ledger = await readMartinMcpInstallLedger(stateRoot);
  const record = matchingRecords(ledger, selector).at(-1) ?? null;
  if (!record) {
    return { status: "missing_record", targetPath: selector.targetPath, record };
  }

  try {
    const current = await readFile(selector.targetPath, "utf8");
    return {
      status: sha256(current) === record.installedSha256 ? "ok" : "modified",
      targetPath: selector.targetPath,
      record
    };
  } catch {
    return { status: "missing", targetPath: selector.targetPath, record };
  }
}

export async function rollbackMartinMcpInstall(
  selector: MartinMcpInstallSelector
): Promise<MartinMcpInstallRecord> {
  const stateRoot = resolveMartinMcpInstallStateRoot(selector.stateRoot);
  const ledger = await readMartinMcpInstallLedger(stateRoot);
  const record = matchingRecords(ledger, selector).at(-1);
  await requireUnmodifiedInstall(selector, record);
  await restoreRecordTarget(record!);
  ledger.installs = ledger.installs.filter((entry) => entry.id !== record!.id);
  await writeLedger(stateRoot, ledger);
  return record!;
}

export async function uninstallMartinMcp(
  selector: MartinMcpInstallSelector
): Promise<MartinMcpInstallRecord[]> {
  const stateRoot = resolveMartinMcpInstallStateRoot(selector.stateRoot);
  const ledger = await readMartinMcpInstallLedger(stateRoot);
  const records = matchingRecords(ledger, selector);
  const latest = records.at(-1);
  await requireUnmodifiedInstall(selector, latest);

  const original = records[0]!;
  await restoreRecordTarget(original);
  const recordIds = new Set(records.map((record) => record.id));
  ledger.installs = ledger.installs.filter((entry) => !recordIds.has(entry.id));
  await writeLedger(stateRoot, ledger);
  return records;
}

export async function writeFileAtomically(
  targetPath: string,
  content: string
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${randomUUID()}.tmp`
  );

  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function resolveMartinMcpInstallStateRoot(override?: string): string {
  return override ?? join(resolveMartinHome(), ".martin", "mcp-installs");
}

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function matchingRecords(
  ledger: MartinMcpInstallLedger,
  selector: MartinMcpInstallSelector
): MartinMcpInstallRecord[] {
  return ledger.installs.filter((record) =>
    record.host === selector.host &&
    record.scope === selector.scope &&
    record.targetPath === selector.targetPath
  );
}

async function requireUnmodifiedInstall(
  selector: MartinMcpInstallSelector,
  record: MartinMcpInstallRecord | undefined
): Promise<void> {
  if (!record) {
    throw new Error(`No recorded MartinLoop MCP install for ${selector.targetPath}.`);
  }
  const verification = await verifyMartinMcpInstall(selector);
  if (verification.status !== "ok") {
    throw new Error(
      `Refusing to modify ${selector.targetPath}: install verification is ${verification.status}.`
    );
  }
}

async function restoreRecordTarget(record: MartinMcpInstallRecord): Promise<void> {
  if (record.backupPath) {
    await writeFileAtomically(record.targetPath, await readFile(record.backupPath, "utf8"));
    return;
  }
  await rm(record.targetPath, { force: true });
}

async function writeLedger(
  stateRoot: string,
  ledger: MartinMcpInstallLedger
): Promise<void> {
  await writeFileAtomically(
    join(stateRoot, "install-state.json"),
    `${JSON.stringify(ledger, null, 2)}\n`
  );
}
