// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  acquireResourceSlot,
  acquireSingleFlight,
  appendJournalEvent,
  assertResourceSample,
  createProcessResourceSampler,
  deriveAcceptanceEvidence,
  heartbeatSingleFlight,
  persistAcceptanceBinding,
  persistIntegratedRunReceipt,
  recoverRestartJournal,
  releaseResourceSlot,
  releaseSingleFlight,
  writeAcceptanceDossier,
} from "./harness.mjs";
import { runIntegratedMissionFixture } from "./integrated-mission-fixture.mjs";

const REAL_MONOTONIC_NOW = () => Number(process.hrtime.bigint() / 1_000_000n);

function releaseAcceptanceCapacity(root, { observer, worker, provider, testSlot }) {
  const failures = [];
  for (const release of [
    () => { if (testSlot) releaseResourceSlot(root, testSlot); },
    () => { if (provider) releaseResourceSlot(root, provider); },
    () => { if (worker) releaseResourceSlot(root, worker); },
    () => { if (observer) releaseSingleFlight(root, observer); },
  ]) {
    try { release(); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "acceptance capacity release failed");
}

export async function runContinuousAcceptance({
  root,
  binding,
  policy,
  signal,
  heartbeatIntervalMs = 10_000,
  maxHeartbeatGapMs = 30_000,
  resourceSampler,
  // Injection is test-only. Acceptance evidence must always use the real fixture,
  // monotonic process clock, wall clock, and timer.
  fixture = runIntegratedMissionFixture,
  monotonicNow = REAL_MONOTONIC_NOW,
  wallNow = Date.now,
  sleep = delay,
  onBoundedRunCommitted,
}) {
  if (binding.evidenceKind === "acceptance"
    && (fixture !== runIntegratedMissionFixture || monotonicNow !== REAL_MONOTONIC_NOW
      || wallNow !== Date.now || sleep !== delay || resourceSampler !== undefined)) {
    throw new Error("production acceptance forbids synthetic fixture, clock, timer, or resource sampler injection");
  }
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1_000
    || heartbeatIntervalMs * 2 > maxHeartbeatGapMs) {
    throw new Error("heartbeat cadence must be bounded and fresher than the maximum gap");
  }
  persistAcceptanceBinding(root, binding);
  let observer;
  let worker;
  let provider;
  let testSlot;
  try {
    observer = acquireSingleFlight(root, "observer", `acceptance-${process.pid}`);
    worker = acquireResourceSlot(root, "workers", policy, `acceptance-${process.pid}`);
    provider = acquireResourceSlot(root, "providers", policy, `acceptance-${process.pid}`);
    testSlot = acquireResourceSlot(root, "tests", policy, `acceptance-${process.pid}`);
    const sample = resourceSampler ?? createProcessResourceSampler(root);
    const epochId = randomUUID();
    const startedMonotonicMs = monotonicNow();
    let nextRunAtMs = 0;
    const runCadenceMs = Math.max(heartbeatIntervalMs, Math.floor(binding.requiredDurationMs / binding.minimumBoundedRuns));
    appendJournalEvent(root, { type: "process_epoch_started", epochId, ...binding.authority, wallTimeMs: wallNow() });
    appendJournalEvent(root, { type: "capacity_acquired", epochId, domains: ["workers", "providers", "tests", "observer"] });
    for (;;) {
      const monotonicMs = monotonicNow() - startedMonotonicMs;
      const wallTimeMs = wallNow();
      heartbeatSingleFlight(root, observer, () => wallTimeMs);
      assertResourceSample(policy, sample());
      appendJournalEvent(root, { type: "heartbeat", epochId, monotonicMs, wallTimeMs });
      let evidence = deriveAcceptanceEvidence(root, binding, { maxHeartbeatGapMs });
      if (evidence.requirementsSatisfied) {
        return { status: "REQUIREMENTS_SATISFIED", evidence };
      }
      if (signal?.aborted) {
        const dossier = writeAcceptanceDossier(root, binding, evidence, "PAUSED");
        return { status: "PAUSED", evidence, stopReason: "signal", ...dossier };
      }
      const events = recoverRestartJournal(root).events;
      const committedRunIds = new Set(events.filter((event) => event.type === "bounded_run_committed").map((event) => event.runId));
      const pendingRun = events.find((event) => event.type === "bounded_run_started" && !committedRunIds.has(event.runId));
      if (pendingRun || monotonicMs >= nextRunAtMs) {
        const runId = pendingRun?.runId ?? `bounded-${String(evidence.boundedRuns + 1).padStart(6, "0")}`;
        if (!pendingRun) appendJournalEvent(root, { type: "bounded_run_started", runId, sourceSha: binding.authority.sourceSha });
        const receipt = await fixture({
          root,
          runId,
          sourceSha: binding.authority.sourceSha,
          coreRuntimeSha256: binding.authority.coreRuntimeSha256,
        });
        const persisted = persistIntegratedRunReceipt(root, binding, receipt);
        await onBoundedRunCommitted?.({ runId, receipt, persisted });
        evidence = deriveAcceptanceEvidence(root, binding, { maxHeartbeatGapMs });
        writeAcceptanceDossier(root, binding, evidence, "RUNNING");
        nextRunAtMs = monotonicMs + runCadenceMs;
      }
      await sleep(heartbeatIntervalMs, undefined, { signal }).catch((error) => {
        if (error?.name !== "AbortError") throw error;
      });
    }
  } finally {
    releaseAcceptanceCapacity(root, { observer, worker, provider, testSlot });
  }
}
