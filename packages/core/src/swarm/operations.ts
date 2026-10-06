import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { SwarmLiveEvent, SwarmLivePlan } from "@martin/contracts";

import {
  openSwarmLiveStoreAtDirectory,
  SwarmLiveStoreError,
  type SwarmLiveSnapshot,
  type SwarmLiveStore,
} from "./live-store.js";
import { assertSwarmPathIdentifier } from "./workspaces.js";
import { readSwarmReceiptProjection } from "./receipt-projection.js";

export type SwarmOperationalSelector =
  | { runsRoot: string; swarmId: string; latest?: never }
  | { runsRoot: string; latest: true; swarmId?: never };

export interface SwarmOperationalState {
  plan: SwarmLivePlan;
  snapshot: SwarmLiveSnapshot;
  events: SwarmLiveEvent[];
}

export interface SwarmOperationalCancellationResult {
  outcome: "created" | "already_requested" | "already_terminal";
  state: SwarmOperationalState;
}

export async function readSwarmOperationalState(
  input: SwarmOperationalSelector,
): Promise<SwarmOperationalState> {
  const store = await selectOperationalStore(input);
  return readOperationalState(store);
}

export async function waitForSwarmOperationalRevision(
  input: SwarmOperationalSelector & { afterRevision: number; signal?: AbortSignal },
): Promise<SwarmOperationalState> {
  const store = await selectOperationalStore(input);
  await store.waitForRevision(input.afterRevision, input.signal);
  return readOperationalState(store);
}

export async function requestSwarmOperationalCancellation(
  input: SwarmOperationalSelector & {
    reason: string;
    requestedBy?: string;
  },
): Promise<SwarmOperationalCancellationResult> {
  const store = await selectOperationalStore(input);
  const requestedAt = new Date().toISOString();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const state = await readOperationalState(store);
    if (state.snapshot.outcome.state !== "running") return { outcome: "already_terminal", state };
    if (state.snapshot.cancellation) return { outcome: "already_requested", state };
    try {
      await store.requestCancellation({
        idempotencyKey: "cancel:operator",
        requestedAt,
        reason: input.reason,
        ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
      }, { expectedRevision: state.snapshot.revision });
      return { outcome: "created", state: await readOperationalState(store) };
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "") : "";
      if (code !== "STALE_REVISION" && code !== "IDEMPOTENCY_CONFLICT") throw error;
    }
  }
  throw new SwarmLiveStoreError("CANCEL_CONTENTION", "Cancellation could not acquire an authoritative revision.");
}

async function readOperationalState(store: SwarmLiveStore): Promise<SwarmOperationalState> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const before = await store.readSnapshot();
    const events = await store.readEvents();
    const snapshot = await store.readSnapshot();
    if (before.revision === snapshot.revision && events.length === snapshot.eventCount) {
      return { plan: structuredClone(store.plan), snapshot: await projectCommittedOutcome(store, snapshot), events };
    }
  }
  throw new SwarmLiveStoreError("STORE_READ_CONTENTION", "Swarm state changed continuously during inspection.");
}

async function projectCommittedOutcome(store: SwarmLiveStore, snapshot: SwarmLiveSnapshot): Promise<SwarmLiveSnapshot> {
  const directory = store.paths().directory;
  const runsRoot = dirname(dirname(directory));
  const statusPath = join(directory, "evidence", "swarm-receipt-seal-status.json");
  const status = await readExactJson(statusPath).catch(() => undefined);
  if (
    status?.schemaVersion === "martin.swarm-receipt-seal-status.v1"
    && status.swarmId === store.plan.swarmId
    && status.planHash === store.plan.planHash
    && status.state === "needs_review"
  ) {
    return {
      ...snapshot,
      outcome: { state: "needs_review", reason: typeof status.reason === "string" ? status.reason : "terminal_evidence_sealing_failed" }
    };
  }
  if (snapshot.outcome.state !== "verified") return snapshot;
  try {
    await readSwarmReceiptProjection({ runsRoot, swarmId: store.plan.swarmId });
    return snapshot;
  } catch {
    return { ...snapshot, outcome: { state: "needs_review", reason: "terminal_evidence_sealing_pending" } };
  }
}

async function readExactJson(path: string): Promise<Record<string, unknown>> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("UNSAFE_SEAL_STATUS_PATH");
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("INVALID_SEAL_STATUS");
  return parsed as Record<string, unknown>;
}

async function selectOperationalStore(input: SwarmOperationalSelector): Promise<SwarmLiveStore> {
  if ("swarmId" in input && input.swarmId !== undefined) {
    assertSwarmPathIdentifier(input.swarmId, "swarm ID");
  }
  const runsRoot = await realpath(resolve(input.runsRoot)).catch((error: unknown) => {
    throw new SwarmLiveStoreError("MISSING_SWARM_STORE", "Swarm runs root does not exist.", { cause: error });
  });
  const swarmsPath = join(runsRoot, "_swarms");
  const swarmsRoot = await realpath(swarmsPath).catch((error: unknown) => {
    throw new SwarmLiveStoreError("MISSING_SWARM_STORE", "No live swarm store exists.", { cause: error });
  });
  assertContained(runsRoot, swarmsRoot);

  if ("swarmId" in input && input.swarmId !== undefined) {
    const directory = await realpath(join(swarmsRoot, input.swarmId)).catch((error: unknown) => {
      throw new SwarmLiveStoreError("MISSING_SWARM_STORE", `Swarm store not found: ${input.swarmId}.`, { cause: error });
    });
    assertContained(swarmsRoot, directory);
    return openSwarmLiveStoreAtDirectory({ directory, swarmId: input.swarmId });
  }

  const entries = await readdir(swarmsRoot, { withFileTypes: true });
  const candidates: Array<{ store: SwarmLiveStore; snapshot: SwarmLiveSnapshot }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    assertSwarmPathIdentifier(entry.name, "swarm ID");
    const directory = await realpath(join(swarmsRoot, entry.name));
    assertContained(swarmsRoot, directory);
    const store = await openSwarmLiveStoreAtDirectory({ directory, swarmId: entry.name });
    candidates.push({ store, snapshot: await store.readSnapshot() });
  }
  candidates.sort((left, right) =>
    right.snapshot.updatedAt.localeCompare(left.snapshot.updatedAt)
      || left.snapshot.swarmId.localeCompare(right.snapshot.swarmId));
  const selected = candidates[0];
  if (!selected) throw new SwarmLiveStoreError("MISSING_SWARM_STORE", "No live swarm store exists.");
  return selected.store;
}

function assertContained(parent: string, child: string): void {
  const rel = relative(parent, child);
  if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new SwarmLiveStoreError("STORE_PATH_ESCAPE", "Swarm store path escapes the real runs root.");
}
