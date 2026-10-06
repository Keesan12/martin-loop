import type { SwarmLiveEngineProfile, SwarmOutcome, SwarmParentReceipt } from "@martin/contracts";

import { redactSecretsFromText } from "../leash.js";
import { readSwarmReceiptProjection, type SwarmReceiptProjection } from "./receipt-projection.js";
import {
  readSwarmOperationalState,
  type SwarmOperationalSelector,
  type SwarmOperationalState,
} from "./operational-reader.js";

export type SwarmEvidenceSelector = SwarmOperationalSelector;

export interface SwarmDossierProjection {
  schemaVersion: "martin.swarm-dossier.v1";
  swarmId: string;
  planHash: string;
  receiptId: string;
  receiptSha256: string;
  objective: string;
  engine: SwarmLiveEngineProfile;
  baselineCommit: string;
  parentOutcome: SwarmParentReceipt["parentOutcome"];
  integrityState: "verified" | "material_missing" | "tamper_detected";
  taskVerificationState: "passed" | "failed" | "unknown";
  sealedAt: string;
  taskCounts: SwarmStatusCounts;
  agentCounts: SwarmStatusCounts;
  budget: {
    capUsd: number;
    capTokens?: number;
    settledUsd: number;
    settledTokens: number;
  };
  evidence: {
    files: number;
    childReceipts: number;
    events: number;
    blockedActions: number;
    reassignments: number;
  };
}

export interface SwarmEvidenceVerification {
  schemaVersion: "martin.swarm-verification.v1";
  swarmId: string;
  planHash: string;
  receiptId: string;
  receiptSha256: string;
  integrityState: SwarmDossierProjection["integrityState"];
  taskVerificationState: SwarmDossierProjection["taskVerificationState"];
  parentOutcomeState: SwarmParentReceipt["parentOutcome"]["state"];
  verified: boolean;
  verifiedAt: string;
}

/** Sanitized, deterministic input for the three-file local share bundle. */
export interface SwarmShareProjection {
  schemaVersion: "martin.swarm-share.v1";
  generatedAt: string;
  swarmId: string;
  planHash: string;
  receiptId: string;
  receiptSha256: string;
  baselineCommit: string;
  parentOutcomeState: "verified";
  integrityState: "verified";
  taskVerificationState: "passed";
  engine: SwarmLiveEngineProfile;
  taskCounts: SwarmStatusCounts;
  agentCounts: SwarmStatusCounts;
  budget: SwarmDossierProjection["budget"];
  evidence: SwarmDossierProjection["evidence"];
}

export interface SwarmStatusCounts {
  total: number;
  accepted?: number;
  verified?: number;
  stopped: number;
  needsReview: number;
  other: number;
}

export interface SwarmEvidenceProjectionDependencies {
  readOperationalState(input: SwarmOperationalSelector): Promise<SwarmOperationalState>;
  readReceiptProjection(input: { runsRoot: string; swarmId: string }): Promise<SwarmReceiptProjection>;
}

const productionDependencies: SwarmEvidenceProjectionDependencies = {
  readOperationalState: readSwarmOperationalState,
  readReceiptProjection: readSwarmReceiptProjection,
};

export function readSwarmDossier(input: SwarmEvidenceSelector): Promise<SwarmDossierProjection> {
  return readSwarmDossierWithDependencies(input, productionDependencies);
}

export function verifySwarmEvidence(input: SwarmEvidenceSelector): Promise<SwarmEvidenceVerification> {
  return verifySwarmEvidenceWithDependencies(input, productionDependencies);
}

export function buildSwarmShareProjection(input: SwarmEvidenceSelector): Promise<SwarmShareProjection> {
  return buildSwarmShareProjectionWithDependencies(input, productionDependencies);
}

/** Internal test seam; intentionally not re-exported from the Core package root. */
export async function readSwarmDossierWithDependencies(
  input: SwarmEvidenceSelector,
  dependencies: SwarmEvidenceProjectionDependencies,
): Promise<SwarmDossierProjection> {
  const state = await dependencies.readOperationalState(input);
  const swarmId = state.snapshot.swarmId;
  const projection = await dependencies.readReceiptProjection({ runsRoot: input.runsRoot, swarmId });
  return projectDossier(projection.receipt, projection.integrity.state);
}

/** Internal test seam; intentionally not re-exported from the Core package root. */
export async function verifySwarmEvidenceWithDependencies(
  input: SwarmEvidenceSelector,
  dependencies: SwarmEvidenceProjectionDependencies,
): Promise<SwarmEvidenceVerification> {
  const dossier = await readSwarmDossierWithDependencies(input, dependencies);
  return {
    schemaVersion: "martin.swarm-verification.v1",
    swarmId: dossier.swarmId,
    planHash: dossier.planHash,
    receiptId: dossier.receiptId,
    receiptSha256: dossier.receiptSha256,
    integrityState: dossier.integrityState,
    taskVerificationState: dossier.taskVerificationState,
    parentOutcomeState: dossier.parentOutcome.state,
    verified: dossier.integrityState === "verified"
      && dossier.taskVerificationState === "passed"
      && dossier.parentOutcome.state === "verified",
    verifiedAt: dossier.sealedAt,
  };
}

/** Internal test seam; intentionally not re-exported from the Core package root. */
export async function buildSwarmShareProjectionWithDependencies(
  input: SwarmEvidenceSelector,
  dependencies: SwarmEvidenceProjectionDependencies,
): Promise<SwarmShareProjection> {
  const dossier = await readSwarmDossierWithDependencies(input, dependencies);
  if (
    dossier.integrityState !== "verified"
    || dossier.taskVerificationState !== "passed"
    || dossier.parentOutcome.state !== "verified"
  ) {
    throw codedEvidenceError(
      "SWARM_SHARE_NOT_VERIFIED",
      "Swarm evidence is not fully verified and cannot be shared.",
    );
  }
  const share: SwarmShareProjection = {
    schemaVersion: "martin.swarm-share.v1",
    generatedAt: dossier.sealedAt,
    swarmId: dossier.swarmId,
    planHash: dossier.planHash,
    receiptId: dossier.receiptId,
    receiptSha256: dossier.receiptSha256,
    baselineCommit: dossier.baselineCommit,
    parentOutcomeState: "verified",
    integrityState: "verified",
    taskVerificationState: "passed",
    engine: structuredClone(dossier.engine),
    taskCounts: structuredClone(dossier.taskCounts),
    agentCounts: structuredClone(dossier.agentCounts),
    budget: structuredClone(dossier.budget),
    evidence: structuredClone(dossier.evidence),
  };
  return JSON.parse(redactSecretsFromText(JSON.stringify(share))) as SwarmShareProjection;
}

function projectDossier(
  receipt: SwarmParentReceipt,
  integrityState: SwarmDossierProjection["integrityState"],
): SwarmDossierProjection {
  const taskCounts = countStatuses(receipt.tasks.map((task) => task.status), "accepted");
  const agentCounts = countStatuses(receipt.agents.map((agent) => agent.status), "verified");
  return {
    schemaVersion: "martin.swarm-dossier.v1",
    swarmId: receipt.swarmId,
    planHash: receipt.planHash,
    receiptId: receipt.receiptId,
    receiptSha256: receipt.receiptSha256,
    objective: receipt.objective,
    engine: structuredClone(receipt.engine),
    baselineCommit: receipt.baselineCommit,
    parentOutcome: structuredClone(receipt.parentOutcome),
    integrityState,
    taskVerificationState: receipt.taskVerificationState,
    sealedAt: receipt.sealedAt,
    taskCounts,
    agentCounts,
    budget: {
      capUsd: receipt.budgetLedger.capUsd,
      ...(receipt.budgetLedger.capTokens === undefined ? {} : { capTokens: receipt.budgetLedger.capTokens }),
      settledUsd: receipt.budgetLedger.settledUsd,
      settledTokens: receipt.budgetLedger.settledTokens,
    },
    evidence: {
      files: receipt.evidenceFiles.length,
      childReceipts: receipt.childReceipts.length,
      events: receipt.events.length,
      blockedActions: receipt.blockedActions.length,
      reassignments: receipt.reassignments.length,
    },
  };
}

function countStatuses(values: readonly string[], successStatus: "accepted" | "verified"): SwarmStatusCounts {
  const counts: SwarmStatusCounts = {
    total: values.length,
    ...(successStatus === "accepted" ? { accepted: 0 } : { verified: 0 }),
    stopped: 0,
    needsReview: 0,
    other: 0,
  };
  for (const status of values) {
    if (status === successStatus) {
      if (successStatus === "accepted") counts.accepted = (counts.accepted ?? 0) + 1;
      else counts.verified = (counts.verified ?? 0) + 1;
    } else if (status === "stopped") counts.stopped += 1;
    else if (status === "needs_review") counts.needsReview += 1;
    else counts.other += 1;
  }
  return counts;
}

function codedEvidenceError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
