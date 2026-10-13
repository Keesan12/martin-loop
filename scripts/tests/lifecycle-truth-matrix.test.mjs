import assert from "node:assert/strict";
import test from "node:test";

import {
  REQUIRED_CASE_IDS,
  REQUIRED_SURFACES,
  assertSurfaceAgreement,
  validateFixtureCorpus,
  verifyFixtureChecksumBytes,
} from "../lifecycle-truth-matrix.mjs";

function expected(overrides = {}) {
  return {
    outcome: "NEEDS_REVIEW",
    executionMode: "governed",
    governanceClaimEligible: true,
    sourceStatus: { status: "completed", lifecycleState: "completed" },
    verification: { status: "FAILED" },
    receiptIntegrity: { state: "verified" },
    lifecycleTruth: {
      executionStatus: "completed",
      lifecycleState: "completed",
      terminationClass: "operational_exit",
      reasonCode: "goal_met",
      reason: "Configured verification goal passed.",
      matchedReasons: ["goal_met"],
      exhaustedLimits: [],
      evidenceAvailable: true,
    },
    fileEffects: {
      observationStatus: "observed",
      touchedDuringExecution: ["src/example.ts"],
      netChangedAtCompletion: ["src/example.ts"],
      revertedBeforeCompletion: [],
    },
    ...overrides,
  };
}

function corpus(ids = REQUIRED_CASE_IDS) {
  return {
    schemaVersion: "martin.lifecycle-truth-fixtures.v1",
    cases: ids.map((id) => ({
      id,
      loop: { loopId: `loop_lifecycle_${id}` },
      expected: expected(),
    })),
  };
}

test("fixture validation requires exactly the frozen eight unique case IDs", () => {
  assert.doesNotThrow(() => validateFixtureCorpus(corpus()));

  assert.throws(
    () => validateFixtureCorpus(corpus(REQUIRED_CASE_IDS.slice(0, -1))),
    /missing.*forged_success/iu,
  );
  assert.throws(
    () => validateFixtureCorpus(corpus([...REQUIRED_CASE_IDS, "positive"])),
    /duplicate.*positive/iu,
  );
});

test("fixture checksum mismatch fails closed", () => {
  const bytes = Buffer.from('{"schemaVersion":"martin.lifecycle-truth-fixtures.v1"}\n');
  assert.throws(
    () => verifyFixtureChecksumBytes(bytes, "0".repeat(64)),
    /checksum mismatch/iu,
  );
});

test("surface omission fails with case and surface diagnostics", () => {
  const authority = expected();
  const surfaces = Object.fromEntries(
    REQUIRED_SURFACES.slice(1).map((surface) => [surface, structuredClone(authority)]),
  );

  assert.throws(
    () => assertSurfaceAgreement("positive", authority, surfaces),
    /positive.*missing surface.*cli_dossier/iu,
  );
});

test("canonical disagreements name the exact case, surface, and field", () => {
  const authority = expected();
  const surfaces = Object.fromEntries(
    REQUIRED_SURFACES.map((surface) => [surface, structuredClone(authority)]),
  );

  surfaces.cli_runs_verify.outcome = "VERIFIED";
  assert.throws(
    () => assertSurfaceAgreement("verifier_failed", authority, surfaces),
    /verifier_failed.*cli_runs_verify.*outcome/iu,
  );

  surfaces.cli_runs_verify = structuredClone(authority);
  surfaces.mcp_dossier.lifecycleTruth.exhaustedLimits = ["iterations"];
  assert.throws(
    () => assertSurfaceAgreement("denied", authority, surfaces),
    /denied.*mcp_dossier.*lifecycleTruth\.exhaustedLimits/iu,
  );

  surfaces.mcp_dossier = structuredClone(authority);
  surfaces.markdown_handoff.fileEffects.netChangedAtCompletion = ["src/forged.ts"];
  assert.throws(
    () => assertSurfaceAgreement("forged_success", authority, surfaces),
    /forged_success.*markdown_handoff.*fileEffects\.netChangedAtCompletion/iu,
  );
});

test("negative fixtures cannot be upgraded to an optimistic outcome", () => {
  const authority = expected();
  const surfaces = Object.fromEntries(
    REQUIRED_SURFACES.map((surface) => [surface, structuredClone(authority)]),
  );
  surfaces.cli_share_json.outcome = "VERIFIED";

  assert.throws(
    () => assertSurfaceAgreement("tampered", authority, surfaces),
    /tampered.*cli_share_json.*outcome/iu,
  );
});
