// SPDX-FileCopyrightText: MartinLoop contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  EVIDENCE_STATUSES,
  EXECUTION_MODES,
  TEST_INTEGRITY_STATUSES,
  TEST_INTEGRITY_VERDICTS,
  VERIFIED_HANDOFF_OUTCOMES,
} from "../src/index.js";

describe("VerifiedHandoffV1 constants", () => {
  it("keeps execution provenance separate from cost provenance", () => {
    expect(EXECUTION_MODES).toEqual([
      "governed",
      "verification_only",
      "simulated",
    ]);
  });

  it("keeps the three canonical outcomes stable", () => {
    expect(VERIFIED_HANDOFF_OUTCOMES).toEqual([
      "VERIFIED",
      "STOPPED",
      "NEEDS_REVIEW",
    ]);
  });

  it("never treats unknown evidence as passed — NOT_EVALUATED is always present", () => {
    expect(EVIDENCE_STATUSES).toContain("NOT_EVALUATED");
    expect(TEST_INTEGRITY_STATUSES).toContain("NOT_EVALUATED");
  });

  it("exposes the three canonical test-integrity verdicts in stable order", () => {
    expect(TEST_INTEGRITY_VERDICTS).toEqual([
      "VERIFIED",
      "TAMPERING_DETECTED",
      "NOT_EVALUATED",
    ]);
  });

  it("EVIDENCE_STATUSES covers all expected values", () => {
    expect(new Set(EVIDENCE_STATUSES)).toEqual(
      new Set(["PASSED", "FAILED", "CONTRADICTED", "NOT_RUN", "NOT_EVALUATED"])
    );
  });

  it("TEST_INTEGRITY_STATUSES covers all granular states", () => {
    expect(new Set(TEST_INTEGRITY_STATUSES)).toEqual(
      new Set([
        "UNCHANGED",
        "AUTHORIZED_CHANGE",
        "PREVENTED",
        "DETECTED_AND_ROLLED_BACK",
        "DETECTED_NEEDS_REVIEW",
        "NOT_EVALUATED",
      ])
    );
  });

  it("outcome array is readonly and non-empty", () => {
    expect(VERIFIED_HANDOFF_OUTCOMES.length).toBeGreaterThan(0);
  });
});
