import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { resolveSwarmDeadlineMs } from "../../packages/contracts/dist/index.js";
import { validateQualificationStructure } from "../lib/live-swarm-authority.mjs";

const sourceSha = "a".repeat(40);
const exactRun = (name, agents, maxConcurrency, budgetUsd) => ({
  name, agents, maxConcurrency, budgetUsd,
  maxWallClockMs: resolveSwarmDeadlineMs({ agents, maxConcurrency }),
  simulationFallbackCalls: 0,
  argv: ["demo", "--swarm", "--live", "--engine", "codex", "--agents", String(agents), "--max-concurrency", String(maxConcurrency), "--budget-usd", String(budgetUsd)],
});

test("structural parsing is pure and does not imply live qualification", () => {
  const receipt = {
    schemaVersion: "martin.live-swarm.qualification.v1", status: "BLOCKED", generatedAt: new Date().toISOString(),
    source: { sha: sourceSha }, binary: { path: resolve("candidate", "martin.js"), sha256: "b".repeat(64), version: "0.8.10" },
    capability: { authStatus: "BLOCKED", preflightStatus: "UNKNOWN" }, approval: { approved: false, maxCombinedUsd: 15 },
    runs: [exactRun("canary", 3, 3, 3), exactRun("full", 15, 5, 12)],
    zeroFallbackPolicy: "live failures exit nonzero; simulation is never invoked",
  };
  assert.deepEqual(validateQualificationStructure(receipt, sourceSha), []);
  assert.notEqual(receipt.status, "PASS");
});

test("structural parsing rejects duplicate/conflicting argv", () => {
  const receipt = {
    schemaVersion: "martin.live-swarm.qualification.v1", status: "BLOCKED", generatedAt: new Date().toISOString(),
    source: { sha: sourceSha }, binary: { path: resolve("candidate", "martin.js"), sha256: "b".repeat(64), version: "0.8.10" },
    capability: { authStatus: "BLOCKED", preflightStatus: "UNKNOWN" }, approval: { approved: false, maxCombinedUsd: 15 },
    runs: [exactRun("canary", 3, 3, 3), exactRun("full", 15, 5, 12)],
    zeroFallbackPolicy: "live failures exit nonzero; simulation is never invoked",
  };
  receipt.runs[0].argv.push("--agents", "30");
  assert.match(validateQualificationStructure(receipt, sourceSha).join("\n"), /argv.*duplicates|argv.*conflicts/iu);
});
