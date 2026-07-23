import test from "node:test";
import assert from "node:assert/strict";

import { evaluateReceipt, parseBoolean, parseMoney } from "../../action/gate.mjs";

test("parses money and booleans without coercing invalid values", () => {
  assert.equal(parseMoney("$3.25"), 3.25);
  assert.equal(parseMoney("1,024.50 USD"), 1024.5);
  assert.equal(parseMoney("unknown"), null);
  assert.equal(parseBoolean("true"), true);
  assert.equal(parseBoolean("off"), false);
  assert.throws(() => parseBoolean("sometimes"), /Invalid boolean/);
});

test("passes the legacy public proof-receipt shape", () => {
  const result = evaluateReceipt({
    costSpend: "$0.51",
    budget: "$3.00",
    verifier: "passed",
    receiptIntegrity: "signed",
  }, { maxUsd: 3 });

  assert.equal(result.passed, true);
  assert.equal(result.actualUsd, 0.51);
  assert.equal(result.effectiveMaxUsd, 3);
});

test("passes a nested share-receipt shape with actual provenance", () => {
  const result = evaluateReceipt({
    schemaVersion: "martin.share-receipt.v1",
    loop: {
      spend: { actualUsd: 1.4, provenance: "actual" },
      budget: { maxUsd: 3 },
    },
    verification: { status: "passed" },
    receiptIntegrity: { verdict: "verified" },
  }, { maxUsd: 3 });

  assert.equal(result.passed, true);
  assert.equal(result.verifierStatus, "passed");
  assert.equal(result.integrityStatus, "verified");
});

test("uses the stricter receipt budget when it is below the action limit", () => {
  const result = evaluateReceipt({
    loop: {
      totalActualUsd: 2,
      budget: { maxUsd: 1.5 },
    },
    verification: { passed: true },
    receiptIntegrity: "verified",
  }, { maxUsd: 3 });

  assert.equal(result.passed, false);
  assert.equal(result.effectiveMaxUsd, 1.5);
  assert.match(result.errors.join("\n"), /exceeded/);
});

test("fails an overspend even when verification passed", () => {
  const result = evaluateReceipt({
    loop: { totalActualUsd: 3.01, budget: { maxUsd: 5 } },
    verification: { status: "passed" },
    receiptIntegrity: "verified",
  }, { maxUsd: 3 });

  assert.equal(result.passed, false);
  assert.match(result.errors.join("\n"), /\$3\.01/);
});

test("fails a verifier failure and tampered receipt", () => {
  const result = evaluateReceipt({
    loop: { totalActualUsd: 1 },
    verification: { status: "failed" },
    receiptIntegrity: { verdict: "tamper_detected" },
  }, { maxUsd: 3 });

  assert.equal(result.passed, false);
  assert.match(result.errors.join("\n"), /verifier status is failed/);
  assert.match(result.errors.join("\n"), /tamper_detected/);
});

test("fails estimated or unavailable cost by default", () => {
  const estimated = evaluateReceipt({
    loop: { cost: { actualUsd: 1, provenance: "estimated" } },
    verification: { status: "passed" },
    receiptIntegrity: "verified",
  }, { maxUsd: 3 });
  assert.equal(estimated.passed, false);
  assert.match(estimated.errors.join("\n"), /not actual/);

  const unavailable = evaluateReceipt({
    verification: { status: "passed" },
    receiptIntegrity: "verified",
  }, { maxUsd: 3 });
  assert.equal(unavailable.passed, false);
  assert.match(unavailable.errors.join("\n"), /actual spend is missing/);
});

test("can explicitly allow unknown cost while retaining verifier and integrity gates", () => {
  const result = evaluateReceipt({
    loop: { cost: { actualUsd: 1, provenance: "estimated" } },
    verification: { status: "passed" },
    receiptIntegrity: "verified",
  }, { maxUsd: 3, allowUnknownCost: true });

  assert.equal(result.passed, true);
  assert.equal(result.warnings.length, 1);
});
