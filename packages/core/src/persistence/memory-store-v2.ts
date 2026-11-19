import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { runContextIntegrityPrecheck } from "../context-integrity.js";
import { evaluateSecretLeash } from "../leash.js";
import { retryTransientWindowsFileSystemOperation } from "./atomic-replace.js";

export type MemoryKindV2 =
  | "consent"
  | "feedback"
  | "pattern"
  | "preference"
  | "compaction"
  | "promotion"
  | "revocation";

export type MemorySensitivityV2 = "public" | "internal" | "confidential" | "secret";
export type MemorySourceV2 = "human" | "inferred" | "tool" | "imported";
export type MemoryTrustLevelV2 = "authoritative" | "trusted" | "untrusted";

export interface MemoryScopeV2 {
  workspaceId: string;
  projectId?: string;
  missionId?: string;
  taskId?: string;
  runId?: string;
  subject: string;
}

export interface MemoryProvenanceV2 {
  source: MemorySourceV2;
  actorId: string;
  observedAt: string;
  sourceRefs: string[];
}

export interface MemoryTrustV2 {
  level: MemoryTrustLevelV2;
  confidence: number;
}

export interface MemoryCandidateV2 {
  id: string;
  kind: MemoryKindV2;
  scope: MemoryScopeV2;
  provenance: MemoryProvenanceV2;
  trust: MemoryTrustV2;
  sensitivity: MemorySensitivityV2;
  content: unknown;
  expiresAt?: string;
  supersedesId?: string;
  sourceState?: "fresh" | "stale";
}

export interface MemoryRecordV2 extends MemoryCandidateV2 {
  schemaVersion: "2.0.0";
  sequence: number;
  createdAt: string;
  contentHash: string;
  previousHash: string | null;
  entryHash: string;
  authority?: VerifiedMemoryApprovalV2;
}

export type MemoryApprovalActionV2 = "consent" | "promotion" | "revocation";

export interface MemoryApprovalReceiptInputV2 {
  receiptId: string;
  contextId: string;
  action: MemoryApprovalActionV2;
  actorId: string;
  workspaceId: string;
  projectId?: string;
  missionId?: string;
  taskId?: string;
  runId?: string;
  subject: string;
  targetId?: string;
  sourceHash: string;
  issuedAt: string;
  expiresAt: string;
}

export interface MemoryApprovalReceiptV2 extends MemoryApprovalReceiptInputV2 {
  schemaVersion: "memory-approval/1";
  signature: string;
}

export interface VerifiedMemoryApprovalV2 {
  verifierId: string;
  receiptId: string;
  action: MemoryApprovalActionV2;
  actorId: string;
  workspaceId: string;
  projectId?: string;
  missionId?: string;
  taskId?: string;
  runId?: string;
  subject: string;
  targetId?: string;
  sourceHash: string;
  expiresAt: string;
}

export interface MemoryApprovalAuthorityV2 {
  verifierId: string;
  verify(receipt: MemoryApprovalReceiptV2): boolean;
}

export interface MemoryStoreV2Options {
  approvalAuthority?: MemoryApprovalAuthorityV2;
  sourceFreshnessVerifier?: MemorySourceFreshnessVerifierV2;
  now?: () => string;
}

export interface MemorySourceFreshnessVerifierV2 {
  verifierId: string;
  verify(record: MemoryRecordV2, asOf: string): Promise<boolean>;
}

export type MemoryScopeSelectorV2 = Pick<
  MemoryScopeV2,
  "workspaceId" | "projectId" | "missionId" | "taskId" | "runId"
>;

export interface MemoryIndexV2 {
  schemaVersion: "2.0.0";
  entryCount: number;
  headHash: string | null;
  byId: Record<string, { sequence: number; entryHash: string }>;
}

export interface MemoryCompactionV2 {
  schemaVersion: "2.0.0";
  asOf: string;
  sourceHeadHash: string | null;
  records: MemoryRecordV2[];
  snapshotHash: string;
}

export type MemoryStoreV2ErrorCode =
  | "not_found"
  | "unreadable"
  | "corrupt"
  | "conflict"
  | "replay"
  | "secret_denied"
  | "quarantined"
  | "authority_denied"
  | "invalid";

export class MemoryStoreV2Error extends Error {
  readonly code: MemoryStoreV2ErrorCode;

  constructor(code: MemoryStoreV2ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MemoryStoreV2Error";
    this.code = code;
  }
}

export interface MemoryStoreV2Paths {
  directory: string;
  ledger: string;
  index: string;
  anchor: string;
  lock: string;
  quarantine: string;
  denials: string;
  compaction: string;
}

interface MemoryAnchorV2 {
  schemaVersion: "2.0.0";
  entryCount: number;
  headHash: string | null;
}

interface MemoryLockOwnerV2 {
  schemaVersion: "2.0.0";
  pid: number;
  nonce: string;
  createdAt: string;
}

interface PromotionApprovalV2 {
  sourceRef: string;
  receipt: MemoryApprovalReceiptV2;
}

interface RevocationApprovalV2 {
  sourceRef: string;
  receipt: MemoryApprovalReceiptV2;
}

const SCHEMA_VERSION = "2.0.0" as const;
const APPROVAL_SCHEMA_VERSION = "memory-approval/1" as const;
const DEFAULT_APPROVAL_MAX_AGE_MS = 5 * 60 * 1_000;

export function signMemoryApprovalReceiptV2(
  input: MemoryApprovalReceiptInputV2,
  secret: string
): MemoryApprovalReceiptV2 {
  assertApprovalSecret(secret);
  const unsigned = { schemaVersion: APPROVAL_SCHEMA_VERSION, ...input };
  return {
    ...unsigned,
    signature: createHmac("sha256", secret).update(stableStringify(unsigned)).digest("hex")
  };
}

export function createHmacMemoryApprovalAuthorityV2(input: {
  secret: string;
  contextId: string;
  verifierId?: string;
  maxAgeMs?: number;
  now?: () => string;
}): MemoryApprovalAuthorityV2 {
  assertApprovalSecret(input.secret);
  const now = input.now ?? (() => new Date().toISOString());
  const maxAgeMs = input.maxAgeMs ?? DEFAULT_APPROVAL_MAX_AGE_MS;
  return {
    verifierId: input.verifierId ?? `hmac:${sha256(input.contextId).slice(0, 16)}`,
    verify(receipt): boolean {
      if (receipt.schemaVersion !== APPROVAL_SCHEMA_VERSION || receipt.contextId !== input.contextId) return false;
      if (!receipt.receiptId.trim()
        || !receipt.actorId.trim()
        || !receipt.workspaceId.trim()
        || !receipt.subject.trim()
        || !/^[a-f0-9]{64}$/u.test(receipt.sourceHash)
        || !["consent", "promotion", "revocation"].includes(receipt.action)) return false;
      const issuedAt = Date.parse(receipt.issuedAt);
      const expiresAt = Date.parse(receipt.expiresAt);
      const current = Date.parse(now());
      if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || !Number.isFinite(current)) return false;
      if (issuedAt > current || current - issuedAt > maxAgeMs || expiresAt <= current) return false;
      if (!/^[a-f0-9]{64}$/u.test(receipt.signature)) return false;
      const { signature, ...unsigned } = receipt;
      const expected = createHmac("sha256", input.secret).update(stableStringify(unsigned)).digest();
      const actual = Buffer.from(signature, "hex");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    }
  };
}

export function memoryApprovalSourceHashV2(candidate: MemoryCandidateV2): string {
  return sha256(stableStringify({
    id: candidate.id,
    kind: candidate.kind,
    scope: candidate.scope,
    content: candidate.content,
    sourceRefs: candidate.provenance.sourceRefs
  }));
}

export function memoryApprovalActionSourceHashV2(targetEntryHash: string, sourceRef: string): string {
  return sha256(stableStringify({ targetEntryHash, sourceRef }));
}

export class MemoryStoreV2 {
  readonly paths: MemoryStoreV2Paths;
  private readonly approvalAuthority?: MemoryApprovalAuthorityV2;
  private readonly sourceFreshnessVerifier?: MemorySourceFreshnessVerifierV2;
  private readonly now: () => string;

  constructor(root: string, options: MemoryStoreV2Options = {}) {
    const directory = join(resolve(root), "_martin", "memory-v2");
    this.paths = {
      directory,
      ledger: join(directory, "ledger.jsonl"),
      index: join(directory, "index.json"),
      anchor: join(directory, "anchor.json"),
      lock: join(directory, ".write.lock"),
      quarantine: join(directory, "quarantine.jsonl"),
      denials: join(directory, "denials.jsonl"),
      compaction: join(directory, "compaction.json")
    };
    this.approvalAuthority = options.approvalAuthority;
    this.sourceFreshnessVerifier = options.sourceFreshnessVerifier;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async append(
    candidate: MemoryCandidateV2,
    options: { expectedHeadHash?: string | null; approvalReceipt?: MemoryApprovalReceiptV2 } = {}
  ): Promise<MemoryRecordV2> {
    validateCandidate(candidate);
    candidate = normalizeCandidateAuthority(candidate);
    await this.assertSecretFree(candidate);
    await this.assertPoisonFree(candidate);
    const authority = await this.authorizeCandidate(candidate, options.approvalReceipt);

    return await this.withLock(async () => {
      const records = await this.readLedgerIfPresent();
      const verified = verifyRecords(records);
      await this.assertAnchor(records);
      if (options.expectedHeadHash !== undefined && options.expectedHeadHash !== verified.headHash) {
        throw new MemoryStoreV2Error("conflict", "The memory ledger head changed before append.");
      }
      if (records.some((record) => record.id === candidate.id)) {
        throw new MemoryStoreV2Error("replay", "A memory record with this id already exists.");
      }
      if (authority && records.some((record) => record.authority?.receiptId === authority.receiptId)) {
        throw new MemoryStoreV2Error("replay", "An approval receipt cannot authorize more than one memory event.");
      }

      const withoutEntryHash = {
        ...candidate,
        ...(authority ? { authority } : {}),
        sourceState: candidate.sourceState ?? "fresh",
        schemaVersion: SCHEMA_VERSION,
        sequence: records.length + 1,
        createdAt: candidate.provenance.observedAt,
        contentHash: sha256(stableStringify(candidate.content)),
        previousHash: verified.headHash
      };
      const record: MemoryRecordV2 = {
        ...withoutEntryHash,
        entryHash: sha256(stableStringify(withoutEntryHash))
      };

      await appendFile(this.paths.ledger, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
      const nextRecords = [...records, record];
      await this.writeIndex(buildIndex(nextRecords));
      await atomicJsonWrite(this.paths.anchor, buildAnchor(nextRecords));
      return record;
    });
  }

  async readAll(): Promise<MemoryRecordV2[]> {
    return await this.withLock(async () => {
      const records = await this.readLedgerRequired();
      verifyRecords(records);
      await this.assertAnchor(records);
      return records;
    });
  }

  async verify(): Promise<{ valid: true; entryCount: number; headHash: string | null }> {
    const records = await this.readAll();
    const result = verifyRecords(records);
    return { valid: true, entryCount: records.length, headHash: result.headHash };
  }

  async readIndex(): Promise<MemoryIndexV2> {
    return await readJsonFile<MemoryIndexV2>(this.paths.index, "memory index");
  }

  async rebuildIndex(): Promise<MemoryIndexV2> {
    return await this.withLock(async () => {
      const records = await this.readLedgerRequired();
      verifyRecords(records);
      await this.assertAnchor(records);
      const index = buildIndex(records);
      await this.writeIndex(index);
      return index;
    });
  }

  async listActive(asOf: string): Promise<MemoryRecordV2[]> {
    throw new MemoryStoreV2Error(
      "invalid",
      `Caller scope is required for active retrieval at ${asOf}; use listActiveForScope().`
    );
  }

  async listActiveForScope(scope: MemoryScopeSelectorV2, asOf: string): Promise<MemoryRecordV2[]> {
    const records = await this.readAll();
    const active = activeRecords(records, asOf, scope);
    if (this.sourceFreshnessVerifier === undefined) return active;
    const freshness = await Promise.all(active.map(async (record) => {
      try {
        return await this.sourceFreshnessVerifier!.verify(record, asOf);
      } catch (error) {
        throw new MemoryStoreV2Error("unreadable", `Source freshness verification failed for ${record.id}.`, {
          cause: error
        });
      }
    }));
    return active.filter((_record, index) => freshness[index]);
  }

  async resolveAuthority(exactScope: string, asOf: string): Promise<boolean> {
    throw new MemoryStoreV2Error(
      "invalid",
      `Caller scope is required for authority resolution of ${exactScope} at ${asOf}; use resolveAuthorityForScope().`
    );
  }

  async resolveAuthorityForScope(
    scope: MemoryScopeSelectorV2,
    exactScope: string,
    asOf: string
  ): Promise<boolean> {
    let records: MemoryRecordV2[];
    try {
      records = await this.readAll();
    } catch (error) {
      if (error instanceof MemoryStoreV2Error && error.code === "not_found") return false;
      throw error;
    }
    const revoked = new Set(
      records
        .filter(isAuthoritativeHumanRevocation)
        .map((record) => readStringField(record.content, "targetId"))
        .filter((value): value is string => Boolean(value))
    );
    const superseded = new Set(
      records
        .filter((record) => record.provenance.source === "human"
          && record.trust.level === "authoritative"
          && record.trust.confidence === 1)
        .map((record) => record.supersedesId)
        .filter((value): value is string => Boolean(value))
    );
    const now = Date.parse(asOf);
    if (!Number.isFinite(now)) throw new MemoryStoreV2Error("invalid", "asOf must be an ISO-8601 timestamp.");
    return records.some((record) => {
      if (record.kind !== "consent") return false;
      if (!sameScope(record.scope, scope)) return false;
      if (record.scope.subject !== exactScope) return false;
      if (record.sourceState === "stale" || revoked.has(record.id) || superseded.has(record.id)) return false;
      if (record.expiresAt && Date.parse(record.expiresAt) <= now) return false;
      if (record.authority?.action !== "consent"
        || record.authority.actorId !== record.provenance.actorId
        || record.authority.subject !== exactScope
        || record.authority.sourceHash !== memoryApprovalSourceHashV2(record)) return false;
      if (record.provenance.source !== "human" || !record.provenance.actorId.startsWith("human:")) return false;
      if (record.trust.level !== "authoritative" || record.trust.confidence !== 1) return false;
      return readStringField(record.content, "decision") === "grant"
        && readStringField(record.content, "exactScope") === exactScope
        && isAfter(readStringField(record.content, "expiresAt"), asOf);
    });
  }

  async promote(id: string, approval: PromotionApprovalV2): Promise<MemoryRecordV2> {
    if (!approval?.receipt || typeof approval.sourceRef !== "string") {
      throw new MemoryStoreV2Error("authority_denied", "Promotion requires a host-authenticated approval receipt.");
    }
    const records = await this.readAll();
    const target = records.find((record) => record.id === id);
    if (!target) throw new MemoryStoreV2Error("not_found", "The memory selected for promotion was not found.");
    return await this.append({
      id: `${id}:promotion:${sha256(approval.sourceRef).slice(0, 12)}`,
      kind: "promotion",
      scope: target.scope,
      provenance: {
        source: "human",
        actorId: approval.receipt.actorId,
        observedAt: approval.receipt.issuedAt,
        sourceRefs: [approval.sourceRef, ...target.provenance.sourceRefs]
      },
      trust: { level: "trusted", confidence: 1 },
      sensitivity: target.sensitivity,
      content: {
        targetId: target.id,
        targetContentHash: target.contentHash,
        targetSourceHash: memoryApprovalActionSourceHashV2(target.entryHash, approval.sourceRef),
        exactScope: approval.receipt.subject,
        expiresAt: approval.receipt.expiresAt,
        originalSource: target.provenance.source
      },
      expiresAt: approval.receipt.expiresAt,
      sourceState: "fresh"
    }, { approvalReceipt: approval.receipt });
  }

  async revoke(id: string, approval: RevocationApprovalV2): Promise<MemoryRecordV2> {
    if (!approval?.receipt || typeof approval.sourceRef !== "string") {
      throw new MemoryStoreV2Error("authority_denied", "Revocation requires a host-authenticated approval receipt.");
    }
    const records = await this.readAll();
    const target = records.find((record) => record.id === id);
    if (!target) throw new MemoryStoreV2Error("not_found", "The memory selected for revocation was not found.");
    return await this.append({
      id: `${id}:revocation:${sha256(approval.sourceRef).slice(0, 12)}`,
      kind: "revocation",
      scope: target.scope,
      provenance: {
        source: "human",
        actorId: approval.receipt.actorId,
        observedAt: approval.receipt.issuedAt,
        sourceRefs: [approval.sourceRef]
      },
      trust: { level: "authoritative", confidence: 1 },
      sensitivity: "internal",
      content: {
        targetId: id,
        targetSourceHash: memoryApprovalActionSourceHashV2(target.entryHash, approval.sourceRef)
      },
      sourceState: "fresh"
    }, { approvalReceipt: approval.receipt });
  }

  async compact(asOf: string): Promise<MemoryCompactionV2> {
    const ledger = await this.readAll();
    const records = activeRecords(ledger, asOf).sort((left, right) => left.id.localeCompare(right.id));
    const sourceHeadHash = ledger.filter((record) => record.kind !== "compaction").at(-1)?.entryHash ?? null;
    const withoutHash = { schemaVersion: SCHEMA_VERSION, asOf, sourceHeadHash, records };
    const result: MemoryCompactionV2 = {
      ...withoutHash,
      snapshotHash: sha256(stableStringify(withoutHash))
    };
    await atomicJsonWrite(this.paths.compaction, result);
    const archiveName = `compaction-${result.snapshotHash}.json`;
    await atomicJsonWrite(join(this.paths.directory, archiveName), result);
    const eventId = `compaction:${result.snapshotHash}`;
    if (!ledger.some((record) => record.id === eventId)) {
      const sourceRefs = [...new Set(ledger.flatMap((record) => record.provenance.sourceRefs))].sort();
      await this.append({
        id: eventId,
        kind: "compaction",
        scope: { workspaceId: "*", subject: "memory.compaction" },
        provenance: {
          source: "tool",
          actorId: "system:memory-compactor",
          observedAt: asOf,
          sourceRefs
        },
        trust: { level: "trusted", confidence: 1 },
        sensitivity: "internal",
        content: {
          snapshotHash: result.snapshotHash,
          sourceHeadHash,
          archive: archiveName,
          recordIds: records.map((record) => record.id)
        },
        sourceState: "fresh"
      }, { expectedHeadHash: ledger.at(-1)?.entryHash ?? null });
    }
    return result;
  }

  private async authorizeCandidate(
    candidate: MemoryCandidateV2,
    receipt: MemoryApprovalReceiptV2 | undefined
  ): Promise<VerifiedMemoryApprovalV2 | undefined> {
    const action = approvalActionForKind(candidate.kind);
    if (!action) return undefined;
    if (!receipt || !this.approvalAuthority || !receipt.actorId.startsWith("human:")) {
      throw new MemoryStoreV2Error("authority_denied", `${action} requires a host-authenticated approval receipt.`);
    }

    let targetId: string | undefined;
    let sourceHash: string;
    let scope = candidate.scope;
    if (action === "consent") {
      sourceHash = memoryApprovalSourceHashV2(candidate);
      const consentExpiry = readStringField(candidate.content, "expiresAt");
      if (!consentExpiry || consentExpiry !== receipt.expiresAt) {
        throw new MemoryStoreV2Error("authority_denied", "Consent approval expiry is not bound to the memory content.");
      }
    } else {
      targetId = readStringField(candidate.content, "targetId");
      const sourceRef = candidate.provenance.sourceRefs[0];
      if (!targetId || !sourceRef) {
        throw new MemoryStoreV2Error("authority_denied", `${action} approval is missing its target binding.`);
      }
      let records: MemoryRecordV2[];
      try {
        records = await this.readAll();
      } catch {
        throw new MemoryStoreV2Error("authority_denied", `${action} approval target could not be verified.`);
      }
      const target = records.find((record) => record.id === targetId);
      if (!target || !sameScope(candidate.scope, target.scope) || candidate.scope.subject !== target.scope.subject) {
        throw new MemoryStoreV2Error("authority_denied", `${action} approval target scope does not match.`);
      }
      scope = target.scope;
      sourceHash = memoryApprovalActionSourceHashV2(target.entryHash, sourceRef);
      if (readStringField(candidate.content, "targetSourceHash") !== sourceHash) {
        throw new MemoryStoreV2Error("authority_denied", `${action} approval source binding does not match.`);
      }
      if (action === "promotion" && candidate.expiresAt !== receipt.expiresAt) {
        throw new MemoryStoreV2Error("authority_denied", "Promotion approval expiry is not bound to the activation event.");
      }
    }

    const expected = {
      action,
      actorId: candidate.provenance.actorId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      missionId: scope.missionId,
      taskId: scope.taskId,
      runId: scope.runId,
      subject: scope.subject,
      targetId,
      sourceHash
    };
    if (!approvalReceiptMatches(receipt, expected) || !this.approvalAuthority.verify(receipt)) {
      throw new MemoryStoreV2Error("authority_denied", `${action} approval receipt is invalid or stale.`);
    }
    return {
      verifierId: this.approvalAuthority.verifierId,
      receiptId: receipt.receiptId,
      action,
      actorId: receipt.actorId,
      workspaceId: receipt.workspaceId,
      ...(receipt.projectId ? { projectId: receipt.projectId } : {}),
      ...(receipt.missionId ? { missionId: receipt.missionId } : {}),
      ...(receipt.taskId ? { taskId: receipt.taskId } : {}),
      ...(receipt.runId ? { runId: receipt.runId } : {}),
      subject: receipt.subject,
      ...(receipt.targetId ? { targetId: receipt.targetId } : {}),
      sourceHash: receipt.sourceHash,
      expiresAt: receipt.expiresAt
    };
  }

  private async assertSecretFree(candidate: MemoryCandidateV2): Promise<void> {
    const memorySecret = containsMemorySpecificSecret(candidate);
    const serialized = memorySecret ? "" : stableStringify(candidate);
    if (candidate.sensitivity === "secret"
      || memorySecret
      || !evaluateSecretLeash({ values: [serialized] }).allowed) {
      await mkdir(this.paths.directory, { recursive: true });
      await appendFile(
        this.paths.denials,
        `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, reason: "secret_material_denied" })}\n`,
        "utf8"
      );
      throw new MemoryStoreV2Error("secret_denied", "Secret-like material is forbidden in governed memory.");
    }
  }

  private async assertPoisonFree(candidate: MemoryCandidateV2): Promise<void> {
    const artifactDirectory = join(this.paths.directory, `.admission-check-${process.pid}-${randomUUID()}`);
    const check = await runContextIntegrityPrecheck(candidate.id, 0, artifactDirectory, {
      retrievedContext: stableStringify({
        scope: candidate.scope,
        provenance: candidate.provenance,
        content: candidate.content
      })
    });
    await rm(artifactDirectory, { recursive: true, force: true });
    if (check.verdict !== "context_poisoning_block") return;
    await mkdir(this.paths.directory, { recursive: true });
    const quarantineRecord = {
      schemaVersion: SCHEMA_VERSION,
      id: candidate.id,
      observedAt: candidate.provenance.observedAt,
      source: candidate.provenance.source,
      reason: "context_poisoning"
    };
    await appendFile(this.paths.quarantine, `${JSON.stringify(quarantineRecord)}\n`, "utf8");
    throw new MemoryStoreV2Error("quarantined", "Candidate memory was quarantined by the context-integrity gate.");
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.paths.directory, { recursive: true });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    const owner: MemoryLockOwnerV2 = {
      schemaVersion: SCHEMA_VERSION,
      pid: process.pid,
      nonce: randomUUID(),
      createdAt: new Date().toISOString()
    };
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        handle = await retryTransientWindowsFileSystemOperation(
          () => open(this.paths.lock, "wx", 0o600)
        );
        await handle.writeFile(JSON.stringify(owner), "utf8");
        break;
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw classifyIo(error, "memory lock");
        await this.recoverDeadOwnerLock();
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
    }
    if (!handle) throw new MemoryStoreV2Error("conflict", "The memory ledger is locked by another writer.");
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      const currentOwner = await readLockOwner(this.paths.lock);
      if (currentOwner?.nonce === owner.nonce) await unlink(this.paths.lock).catch(() => undefined);
    }
  }

  private async recoverDeadOwnerLock(): Promise<void> {
    const owner = await readLockOwner(this.paths.lock);
    if (!owner || isProcessAlive(owner.pid)) return;
    const isolated = `${this.paths.lock}.stale.${owner.nonce}.${randomUUID()}`;
    try {
      await rename(this.paths.lock, isolated);
    } catch (error) {
      if (hasCode(error, "ENOENT") || hasCode(error, "EEXIST")) return;
      throw classifyIo(error, "stale memory lock");
    }
    const isolatedOwner = await readLockOwner(isolated);
    if (isolatedOwner?.nonce !== owner.nonce) {
      await rename(isolated, this.paths.lock).catch(() => undefined);
      return;
    }
    await unlink(isolated).catch(() => undefined);
  }

  private async readLedgerIfPresent(): Promise<MemoryRecordV2[]> {
    try {
      return await this.readLedgerRequired();
    } catch (error) {
      if (error instanceof MemoryStoreV2Error && error.code === "not_found") return [];
      throw error;
    }
  }

  private async readLedgerRequired(): Promise<MemoryRecordV2[]> {
    let raw: string;
    try {
      raw = await readFile(this.paths.ledger, "utf8");
    } catch (error) {
      throw classifyIo(error, "memory ledger");
    }
    const records: MemoryRecordV2[] = [];
    for (const [index, line] of raw.split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as MemoryRecordV2);
      } catch (error) {
        throw new MemoryStoreV2Error("corrupt", `Memory ledger line ${index + 1} is not valid JSON.`, { cause: error });
      }
    }
    return records;
  }

  private async assertAnchor(records: MemoryRecordV2[]): Promise<void> {
    if (records.length === 0) return;
    const anchor = await readJsonFile<MemoryAnchorV2>(this.paths.anchor, "memory anchor");
    if (anchor.schemaVersion === SCHEMA_VERSION
      && Number.isInteger(anchor.entryCount)
      && anchor.entryCount >= 0
      && anchor.entryCount < records.length) {
      const anchoredPrefixHash = anchor.entryCount === 0 ? null : records[anchor.entryCount - 1]?.entryHash;
      if (anchor.headHash === anchoredPrefixHash) {
        await this.writeIndex(buildIndex(records));
        await atomicJsonWrite(this.paths.anchor, buildAnchor(records));
        return;
      }
    }
    if (anchor.schemaVersion !== SCHEMA_VERSION
      || anchor.entryCount !== records.length
      || anchor.headHash !== records.at(-1)?.entryHash) {
      throw new MemoryStoreV2Error("corrupt", "Memory ledger rollback or anchor mismatch detected.");
    }
  }

  private async writeIndex(index: MemoryIndexV2): Promise<void> {
    await atomicJsonWrite(this.paths.index, index);
  }
}

function validateCandidate(candidate: MemoryCandidateV2): void {
  if (!candidate.id.trim() || !candidate.scope.workspaceId.trim() || !candidate.scope.subject.trim()) {
    throw new MemoryStoreV2Error("invalid", "Memory id and scope fields are required.");
  }
  if ([candidate.scope.projectId, candidate.scope.missionId, candidate.scope.taskId, candidate.scope.runId]
    .some((value) => value !== undefined && value.trim().length === 0)) {
    throw new MemoryStoreV2Error("invalid", "Optional memory scope fields must be non-empty when present.");
  }
  if (!Number.isFinite(Date.parse(candidate.provenance.observedAt))) {
    throw new MemoryStoreV2Error("invalid", "Memory provenance observedAt must be an ISO-8601 timestamp.");
  }
  if (!Number.isFinite(candidate.trust.confidence) || candidate.trust.confidence < 0 || candidate.trust.confidence > 1) {
    throw new MemoryStoreV2Error("invalid", "Memory trust confidence must be between zero and one.");
  }
}

function normalizeCandidateAuthority(candidate: MemoryCandidateV2): MemoryCandidateV2 {
  if (candidate.provenance.source !== "inferred") {
    if (candidate.provenance.source === "human" || candidate.trust.level !== "authoritative") return candidate;
    return { ...candidate, trust: { ...candidate.trust, level: "untrusted" } };
  }
  return {
    ...candidate,
    trust: { level: "untrusted", confidence: Math.min(candidate.trust.confidence, 0.79) }
  };
}

function approvalActionForKind(kind: MemoryKindV2): MemoryApprovalActionV2 | undefined {
  if (kind === "consent" || kind === "promotion" || kind === "revocation") return kind;
  return undefined;
}

function approvalReceiptMatches(
  receipt: MemoryApprovalReceiptV2,
  expected: {
    action: MemoryApprovalActionV2;
    actorId: string;
    workspaceId: string;
    projectId?: string;
    missionId?: string;
    taskId?: string;
    runId?: string;
    subject: string;
    targetId?: string;
    sourceHash: string;
  }
): boolean {
  return receipt.action === expected.action
    && receipt.actorId === expected.actorId
    && receipt.workspaceId === expected.workspaceId
    && (receipt.projectId ?? null) === (expected.projectId ?? null)
    && (receipt.missionId ?? null) === (expected.missionId ?? null)
    && (receipt.taskId ?? null) === (expected.taskId ?? null)
    && (receipt.runId ?? null) === (expected.runId ?? null)
    && receipt.subject === expected.subject
    && (receipt.targetId ?? null) === (expected.targetId ?? null)
    && receipt.sourceHash === expected.sourceHash;
}

function assertApprovalSecret(secret: string): void {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new MemoryStoreV2Error("invalid", "Memory approval HMAC secrets must be at least 32 bytes.");
  }
}

const MEMORY_SECRET_KEYS = new Set([
  "password",
  "passwd",
  "pwd",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "token",
  "secret",
  "oauthtoken",
  "authorization",
  "cookie",
  "setcookie",
  "sessionid",
  "sessiontoken",
  "clientsecret",
  "privatekey",
  "credentials",
  "databaseurl",
  "dburl",
  "connectionstring"
]);

const MEMORY_SECRET_VALUE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:@/]+:[^\s@/]+@/iu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/iu,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u
];

function containsMemorySpecificSecret(value: unknown): boolean {
  if (typeof value === "string") return MEMORY_SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
  if (Array.isArray(value)) return value.some(containsMemorySpecificSecret);
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
    if (MEMORY_SECRET_KEYS.has(normalizedKey) && child !== undefined && child !== null && child !== "") return true;
    if (containsMemorySpecificSecret(child)) return true;
  }
  return false;
}

function activeRecords(
  records: MemoryRecordV2[],
  asOf: string,
  scope?: MemoryScopeSelectorV2
): MemoryRecordV2[] {
  const now = Date.parse(asOf);
  if (!Number.isFinite(now)) throw new MemoryStoreV2Error("invalid", "asOf must be an ISO-8601 timestamp.");
  const byId = new Map(records.map((record) => [record.id, record]));
  const promoted = new Set<string>();
  for (const event of records) {
    if (event.kind !== "promotion") continue;
    if (event.authority?.action !== "promotion") continue;
    if (event.provenance.source !== "human" || !event.provenance.actorId.startsWith("human:")) continue;
    if (event.trust.level === "untrusted" || event.trust.confidence !== 1) continue;
    if (event.expiresAt && Date.parse(event.expiresAt) <= now) continue;
    const targetId = readStringField(event.content, "targetId");
    const exactScope = readStringField(event.content, "exactScope");
    const target = targetId ? byId.get(targetId) : undefined;
    if (!target || exactScope !== target.scope.subject || !sameScope(event.scope, target.scope)) continue;
    const sourceRef = event.provenance.sourceRefs[0];
    if (!sourceRef
      || event.authority.targetId !== target.id
      || event.authority.sourceHash !== memoryApprovalActionSourceHashV2(target.entryHash, sourceRef)) continue;
    promoted.add(target.id);
  }
  const revoked = new Set(
    records
      .filter(isAuthoritativeHumanRevocation)
      .map((record) => readStringField(record.content, "targetId"))
      .filter((value): value is string => Boolean(value))
  );
  const superseded = new Set(
    records
      .filter((record) => promoted.has(record.id))
      .map((record) => record.supersedesId)
      .filter((value): value is string => Boolean(value))
  );
  return records.filter((record) => {
    if (!promoted.has(record.id)) return false;
    if (scope && !sameScope(record.scope, scope)) return false;
    if (record.kind === "consent" || record.kind === "revocation" || record.kind === "promotion" || record.kind === "compaction") return false;
    if (record.sourceState === "stale" || revoked.has(record.id) || superseded.has(record.id)) return false;
    if (record.expiresAt && Date.parse(record.expiresAt) <= now) return false;
    return true;
  });
}

function isAuthoritativeHumanRevocation(record: MemoryRecordV2): boolean {
  return record.kind === "revocation"
    && record.authority?.action === "revocation"
    && record.provenance.source === "human"
    && record.provenance.actorId.startsWith("human:")
    && record.trust.level === "authoritative"
    && record.trust.confidence === 1;
}

function sameScope(
  left: MemoryScopeSelectorV2,
  right: MemoryScopeSelectorV2
): boolean {
  return left.workspaceId === right.workspaceId
    && (left.projectId ?? null) === (right.projectId ?? null)
    && (left.missionId ?? null) === (right.missionId ?? null)
    && (left.taskId ?? null) === (right.taskId ?? null)
    && (left.runId ?? null) === (right.runId ?? null);
}

async function readLockOwner(path: string): Promise<MemoryLockOwnerV2 | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<MemoryLockOwnerV2>;
    if (parsed.schemaVersion !== SCHEMA_VERSION
      || !Number.isInteger(parsed.pid)
      || typeof parsed.nonce !== "string"
      || parsed.nonce.length === 0
      || typeof parsed.createdAt !== "string"
      || !Number.isFinite(Date.parse(parsed.createdAt))) return undefined;
    return parsed as MemoryLockOwnerV2;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0 || !Number.isInteger(pid)) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

function verifyRecords(records: MemoryRecordV2[]): { headHash: string | null } {
  let previousHash: string | null = null;
  const ids = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (record.schemaVersion !== SCHEMA_VERSION || record.sequence !== index + 1) {
      throw new MemoryStoreV2Error("corrupt", "Memory ledger sequence or schema is invalid.");
    }
    if (ids.has(record.id)) throw new MemoryStoreV2Error("corrupt", "Memory ledger contains a replayed id.");
    ids.add(record.id);
    if (record.previousHash !== previousHash) {
      throw new MemoryStoreV2Error("corrupt", "Memory ledger chain order is invalid.");
    }
    if (record.contentHash !== sha256(stableStringify(record.content))) {
      throw new MemoryStoreV2Error("corrupt", "Memory ledger content hash mismatch detected.");
    }
    const { entryHash, ...withoutEntryHash } = record;
    if (entryHash !== sha256(stableStringify(withoutEntryHash))) {
      throw new MemoryStoreV2Error("corrupt", "Memory ledger entry hash mismatch detected.");
    }
    previousHash = entryHash;
  }
  return { headHash: previousHash };
}

function buildIndex(records: MemoryRecordV2[]): MemoryIndexV2 {
  const byId: MemoryIndexV2["byId"] = {};
  for (const record of records) byId[record.id] = { sequence: record.sequence, entryHash: record.entryHash };
  return {
    schemaVersion: SCHEMA_VERSION,
    entryCount: records.length,
    headHash: records.at(-1)?.entryHash ?? null,
    byId
  };
}

function buildAnchor(records: MemoryRecordV2[]): MemoryAnchorV2 {
  return {
    schemaVersion: SCHEMA_VERSION,
    entryCount: records.length,
    headHash: records.at(-1)?.entryHash ?? null
  };
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw classifyIo(error, "memory state");
  }
}

async function readJsonFile<T>(path: string, label: string): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw classifyIo(error, label);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new MemoryStoreV2Error("corrupt", `${label} is not valid JSON.`, { cause: error });
  }
}

function classifyIo(error: unknown, label: string): MemoryStoreV2Error {
  if (hasCode(error, "ENOENT")) return new MemoryStoreV2Error("not_found", `${label} was not found.`, { cause: error });
  return new MemoryStoreV2Error("unreadable", `${label} could not be read or written.`, { cause: error });
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function isAfter(value: string | undefined, reference: string): boolean {
  return Boolean(value) && Number.isFinite(Date.parse(value!)) && Date.parse(value!) > Date.parse(reference);
}

function readStringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === "string" ? fieldValue : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)])
    );
  }
  return value;
}
