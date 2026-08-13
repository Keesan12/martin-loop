/**
 * Context Handoff Store — A-CTX-2 persistence layer.
 *
 * Produces, writes, and reads ContextHandoffReceipt files so that
 * downstream processes can verify them without rerunning the upstream agent.
 *
 * Storage layout (under runsRoot/<runId>/):
 *   context-handoff.json        — the receipt produced by this run for the next hop
 *
 * The producerReceiptHash is computed as SHA-256 of the receipt-integrity.json
 * file written by writeLoopRecord. If that file is absent, upstreamIntegrity is
 * set to "evidence_boundary" — the receipt is still written but will not pass
 * verifyContextHandoff.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  ContextHandoffArtifact,
  ContextHandoffClaim,
  ContextHandoffReceipt
} from "@martin/contracts";
import { HANDOFF_SCHEMA_VERSION } from "@martin/contracts";

import { resolveReceiptIntegrityPath } from "./integrity.js";
import { runDir } from "./store.js";

// ─── Hash helpers ──────────────────────────────────────────────────────────────

/** Compute the SHA-256 hex digest of a file's raw bytes. */
export async function computeFileHash(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

/** Compute the SHA-256 hex digest of a UTF-8 string. */
function sha256String(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// ─── Paths ─────────────────────────────────────────────────────────────────────

export function contextHandoffPath(runsRoot: string, runId: string): string {
  return join(runDir(runsRoot, runId), "context-handoff.json");
}

// ─── Write ─────────────────────────────────────────────────────────────────────

/**
 * Persist a ContextHandoffReceipt for this run so the next hop can load it.
 * Overwrites any existing file — callers must not call this more than once per run.
 */
export async function writeContextHandoff(
  runsRoot: string,
  runId: string,
  receipt: ContextHandoffReceipt
): Promise<void> {
  const dir = runDir(runsRoot, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    contextHandoffPath(runsRoot, runId),
    JSON.stringify(receipt, null, 2),
    "utf8"
  );
}

// ─── Read ──────────────────────────────────────────────────────────────────────

/**
 * Load a ContextHandoffReceipt from a previous run.
 * Returns null when the file does not exist (not an error — the consumer
 * must treat absence as a hard gate failure).
 */
export async function readContextHandoff(
  runsRoot: string,
  runId: string
): Promise<ContextHandoffReceipt | null> {
  const path = contextHandoffPath(runsRoot, runId);
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return null;
  return JSON.parse(raw) as ContextHandoffReceipt;
}

// ─── Build ─────────────────────────────────────────────────────────────────────

export interface BuildHandoffReceiptInput {
  runsRoot: string;
  /** Run that is producing this handoff (the upstream/producer run). */
  producerRunId: string;
  /** Stable identifier for the chain. Shared across all hops. */
  chainId: string;
  /** Optional mission identifier shared across hops. */
  missionId?: string;
  /** Unique ID for this specific handoff crossing. Generated if absent. */
  handoffId?: string;
  /** Verified claims the producer is asserting. All must be state "verified". */
  claims?: ContextHandoffClaim[];
  /**
   * File paths whose SHA-256 hashes should be captured as artifacts.
   * Each file is hashed at call time — callers must call after writing artifacts.
   */
  artifactFiles?: Array<{ filePath: string; label?: string; required: boolean }>;
  /** Optional pre-computed artifacts (bypasses file hashing). */
  artifacts?: ContextHandoffArtifact[];
  /** Assumptions that are not yet resolved at handoff time. */
  unresolvedAssumptions?: string[];
  /** Parent handoff IDs for multi-hop lineage. */
  parentHandoffIds?: string[];
  /** Clock override (defaults to new Date().toISOString()). */
  now?: () => string;
}

/**
 * Build a ContextHandoffReceipt from a completed run.
 *
 * - producerReceiptHash is SHA-256 of the receipt-integrity.json file
 *   written by writeLoopRecord. If that file is absent, upstreamIntegrity
 *   is "evidence_boundary".
 * - Artifact hashes are computed from real files at call time.
 */
export async function buildContextHandoffReceipt(
  input: BuildHandoffReceiptInput
): Promise<ContextHandoffReceipt> {
  const {
    runsRoot,
    producerRunId,
    chainId,
    missionId,
    claims = [],
    unresolvedAssumptions = [],
    parentHandoffIds,
    now = () => new Date().toISOString()
  } = input;

  // Determine handoffId
  const handoffId =
    input.handoffId ??
    `hoff_${sha256String(`${chainId}:${producerRunId}:${now()}`).slice(0, 16)}`;

  // Hash the receipt-integrity.json file to obtain producerReceiptHash
  const integrityPath = resolveReceiptIntegrityPath(runsRoot, producerRunId);
  let producerReceiptHash: string;
  let upstreamIntegrity: ContextHandoffReceipt["upstreamIntegrity"];

  const integrityRaw = await readFile(integrityPath, "utf8").catch(() => null);
  if (integrityRaw === null) {
    // No integrity file — cannot establish upstream integrity
    producerReceiptHash = "";
    upstreamIntegrity = "evidence_boundary";
  } else {
    producerReceiptHash = sha256String(integrityRaw);
    upstreamIntegrity = "verified";
  }

  // Hash artifact files
  const artifactFiles = input.artifactFiles ?? [];
  const fileArtifacts: ContextHandoffArtifact[] = await Promise.all(
    artifactFiles.map(async (af) => ({
      path: af.filePath,
      sha256: await computeFileHash(af.filePath),
      required: af.required,
      label: af.label
    }))
  );

  const artifacts: ContextHandoffArtifact[] = [
    ...(input.artifacts ?? []),
    ...fileArtifacts
  ];

  const receipt: ContextHandoffReceipt = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    handoffId,
    chainId,
    ...(missionId !== undefined ? { missionId } : {}),
    producerRunId,
    producerReceiptHash,
    ...(parentHandoffIds !== undefined ? { parentHandoffIds } : {}),
    claims,
    artifacts,
    unresolvedAssumptions,
    upstreamIntegrity,
    createdAt: now()
  };

  return receipt;
}
