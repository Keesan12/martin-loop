// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertCoreRuntimeBuildAuthority } from "./harness.mjs";

function hash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function runIntegratedMissionFixture({
  root, runId, sourceSha, coreRuntimeSha256, now = () => new Date().toISOString(),
}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) throw new Error("fixture runId is unsafe");
  assertCoreRuntimeBuildAuthority(
    fileURLToPath(new URL("../../packages/core/dist", import.meta.url)),
    coreRuntimeSha256,
  );
  const missionModule = await import("../../packages/core/dist/mission/index.js");
  const persistenceModule = await import("../../packages/core/dist/persistence/index.js");
  if (typeof missionModule.createMissionRuntime !== "function" || typeof persistenceModule.MemoryStoreV2 !== "function") {
    throw new Error("built @martin/core does not expose the integrated overnight fixture authorities");
  }
  const missionId = `overnight-${runId}`;
  const runRoot = join(root, "integrated-runs", runId);
  await mkdir(runRoot, { recursive: true });
  const instant = now();

  const memory = new persistenceModule.MemoryStoreV2(runRoot, { now: () => instant });
  const memoryRecords = await memory.readAll().catch((error) => {
    if (error?.code === "ENOENT" || error?.code === "not_found") return [];
    throw error;
  });
  if (!memoryRecords.some((record) => record.id === `observation-${runId}`)) {
    await memory.append({
      id: `observation-${runId}`,
      kind: "preference",
      scope: { workspaceId: "overnight-provider-free", projectId: "acceptance", subject: "fixture.boundary" },
      provenance: { source: "system", actorId: "overnight-harness", observedAt: instant, sourceRefs: [`run:${runId}`] },
      trust: { level: "untrusted", confidence: 1 },
      sensitivity: "internal",
      content: { providerFree: true, runId },
    });
  }
  const memoryAuthority = await memory.verify();
  const candidateHash = hash(`candidate\0${runId}`);
  const receiptHash = hash(`receipt\0${runId}`);
  const verifierEvidenceHash = hash(`verifier\0${runId}`);
  const integratedHash = hash(`integration\0${runId}`);
  let launches = 0;
  let verifications = 0;
  let integrations = 0;
  let providerAttempts = 0;
  const runtimeSourceBindingHash = hash(sourceSha);
  const workspaceIdentityHash = hash("overnight-provider-free");
  const candidateResult = (input) => {
    if (input.provider !== "provider-free-fixture") {
      providerAttempts += 1;
      throw new Error("provider-free fixture selected an external provider");
    }
    const manifestHash = hash(`handoff\0${runId}`);
    return {
      kind: "candidate", runId: input.runId, receiptHash, candidateHash, actualUsd: 0, tokens: 0,
      handoff: {
        manifestHash, summary: "provider-free integrated fixture", tokenCount: 0,
        receipt: {
          schemaVersion: "martin.handoff.v1", handoffId: `handoff:${input.runId}`,
          chainId: `chain:${input.missionId}`, missionId: input.missionId,
          producerRunId: input.runId, producerReceiptHash: receiptHash,
          claims: [], artifacts: [{ sha256: manifestHash, required: true }], unresolvedAssumptions: [],
          upstreamIntegrity: "verified", createdAt: instant,
        },
        producerReceiptVerified: true,
        availableArtifactHashes: [manifestHash],
      },
    };
  };
  const runtime = missionModule.createMissionRuntime({
    root: runRoot,
    missionId,
    now,
    bindingAuthority: {
      authorityId: "overnight-exact-source-workspace-v1",
      async verify(binding) {
        return binding.sourceSha === runtimeSourceBindingHash
          && binding.workspaceId === "overnight-provider-free"
          && binding.workspaceIdentityHash === workspaceIdentityHash;
      },
    },
    childRuns: {
      async launch(input) {
        launches += 1;
        return candidateResult(input);
      },
      async recover(input) { return candidateResult(input); },
    },
    verifier: {
      async verify() {
        verifications += 1;
        return { passed: true, verifierId: "overnight-fixture-verifier", evidenceHash: verifierEvidenceHash, source: "integrated-fixture" };
      },
    },
    integrator: {
      async integrate(input) {
        integrations += 1;
        return { integrationId: input.integrationId, integratedHash };
      },
      async recover(input) { return { integrationId: input.integrationId, integratedHash }; },
    },
  });
  if (await runtime.load() === null) await runtime.initialize({
    objective: "Exercise provider-free checkpoint, memory, verifier, settlement, and integration authorities",
    sourceSha: runtimeSourceBindingHash,
    workspace: { workspaceId: "overnight-provider-free", identityHash: workspaceIdentityHash },
    context: { manifestHash: hash(`context\0${runId}`), tokenCount: 0, compactAtTokens: 100 },
    memory: { ledgerHeadHash: memoryAuthority.headHash, snapshotHash: null },
    budget: {
      maxUsd: 0.01, spentUsd: 0, maxRuns: 1, runsUsed: 0, maxTokens: 1, tokensUsed: 0,
      maxConcurrency: 1, activeConcurrency: 0, maxNoProgressIntervals: 1, noProgressIntervals: 0,
      startedAt: instant, wallClockDeadline: new Date(Date.parse(instant) + 60_000).toISOString(),
    },
    workItems: [{ id: "integrated-fixture", title: "Integrated provider-free fixture", dependsOn: [], maxAttempts: 1 }],
    providerPolicy: { primary: "provider-free-fixture", allowFallback: false },
    writerId: "overnight-harness",
    now: instant,
  });
  const state = await runtime.runUntilBlocked();
  const dossier = await runtime.morningDossier();
  const runtimeDossierSha256 = hash(JSON.stringify(dossier));
  const verified = Object.values(state.verifications).length === 1
    && Object.values(state.verifications).every((item) => item.passed === true);
  const integrated = state.queue.length === 1 && state.queue.every((item) => item.phase === "integrated");
  const settled = state.settlement.settlementIds.length === 1;
  if (!verified || !integrated || !settled || launches > 1 || verifications > 1 || integrations > 1
    || state.settlement.budget.spentUsd !== 0 || providerAttempts !== 0) {
    throw new Error("integrated MissionRuntime fixture did not satisfy provider-free acceptance invariants");
  }
  const dossierPath = join(runRoot, "runtime-dossier.json");
  const dossierText = `${JSON.stringify(dossier, null, 2)}\n`;
  const existingDossier = await readFile(dossierPath, "utf8").catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (existingDossier !== null && existingDossier !== dossierText) throw new Error("integrated runtime dossier conflict");
  if (existingDossier === null) await writeFile(dossierPath, dossierText, { flag: "wx" });
  return {
    schemaVersion: "martin.overnight.integrated-run.v1",
    runId,
    missionId,
    sourceSha,
    runtimeSourceBindingHash,
    bindingAuthorityId: "overnight-exact-source-workspace-v1",
    executionModel: "in-process-governed-runtime",
    providerAdapterKind: "provider-free-fixture",
    providerAttempts,
    providerCalls: 0,
    verified,
    integrated,
    settled,
    runtimeDossierSha256,
    memoryHeadHash: memoryAuthority.headHash,
    checkpointHeadHash: state.bindings.missionLedgerHeadHash,
    handoffManifestHash: hash(`handoff\0${runId}`),
    settlementIds: [...state.settlement.settlementIds],
    verifierEvidenceHash,
    integratedHash,
  };
}
