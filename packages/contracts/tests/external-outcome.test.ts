import { describe, expect, it } from "vitest";

import {
  EXTERNAL_OUTCOME_SCHEMA_VERSION,
  externalOutcomeValuesEqual,
  resolveExternalOutcomeJsonPointer,
  validateExternalOutcomeContract,
  type ExternalOutcomeContract,
} from "../src/index.js";

function contract(): ExternalOutcomeContract {
  return {
    schemaVersion: EXTERNAL_OUTCOME_SCHEMA_VERSION,
    contractId: "booking-save",
    allowedOrigins: ["https://staging.example.com"],
    deadlineMs: 5000,
    pollIntervalMs: 500,
    requestTimeoutMs: 1500,
    actions: [{
      actionId: "booking-001",
      claimedDone: true,
      source: { url: "https://staging.example.com/api/bookings/by-request/nonce-1", authEnv: "BOOKING_READ_TOKEN" },
      recordPointer: "/records",
      identity: { pointer: "/requestNonce", equals: "nonce-1" },
      expectedCount: 1,
      assertions: [
        { pointer: "/tenantId", equals: "tenant-test" },
        { pointer: "/status", equals: "confirmed" },
        { pointer: "/guests", equals: 2 },
      ],
      freshness: { pointer: "/version", notEquals: 1 },
    }],
  };
}

describe("external outcome contracts", () => {
  it("accepts the strict v1 contract and rejects loose or unsafe variants", () => {
    expect(validateExternalOutcomeContract(contract())).toEqual([]);

    const invalid = structuredClone(contract()) as any;
    invalid.actions[0].source.url = "https://evil.example/api";
    invalid.actions.push(structuredClone(invalid.actions[0]));
    invalid.actions[1].actionId = invalid.actions[0].actionId;
    invalid.actions[0].identity.pointer = "$.requestNonce";
    invalid.actions[0].assertions[0].equals = { unsafe: true };
    const errors = validateExternalOutcomeContract(invalid);
    expect(errors.map((item) => item.path)).toEqual(expect.arrayContaining([
      "actions[0].source.url",
      "actions[0].identity.pointer",
      "actions[0].assertions[0].equals",
      "actions[1].actionId",
    ]));
  });

  it("rejects query strings and fragments so secrets cannot enter trusted contract snapshots", () => {
    const withQuery = contract();
    withQuery.actions[0]!.source.url = "https://staging.example.com/api/bookings?token=secret";
    expect(validateExternalOutcomeContract(withQuery)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "actions[0].source.url", message: expect.stringMatching(/query strings are forbidden/iu) }),
    ]));

    const withFragment = contract();
    withFragment.actions[0]!.source.url = "https://staging.example.com/api/bookings#secret";
    expect(validateExternalOutcomeContract(withFragment)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "actions[0].source.url", message: expect.stringMatching(/fragments are forbidden/iu) }),
    ]));
  });

  it("requires at least one claimed completion", () => {
    const value = contract();
    value.actions[0]!.claimedDone = false;
    expect(validateExternalOutcomeContract(value)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "actions" }),
    ]));
  });

  it("implements RFC 6901 pointers and type-sensitive equality", () => {
    const value = { records: [{ "a/b": { "~key": 2 } }] };
    expect(resolveExternalOutcomeJsonPointer(value, "/records/0/a~1b/~0key")).toEqual({ found: true, value: 2 });
    expect(resolveExternalOutcomeJsonPointer(value, "/records/2")).toEqual({ found: false });
    expect(externalOutcomeValuesEqual(2, 2)).toBe(true);
    expect(externalOutcomeValuesEqual("2", 2)).toBe(false);
  });
});
