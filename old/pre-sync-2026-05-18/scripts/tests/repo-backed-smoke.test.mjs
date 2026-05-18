import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createRepoBackedSmokePlan,
  runRepoBackedSmoke,
} from "../repo-backed-smoke.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("createRepoBackedSmokePlan captures the grounded and rollback smoke goals", () => {
  const plan = createRepoBackedSmokePlan({ rootDir: ROOT_DIR });

  assert.match(plan.groundedSmoke.description, /grounding artifact/i);
  assert.match(plan.rollbackSmoke.description, /rollback boundary/i);
  assert.equal(plan.expectedLifecycle.rollback, "human_escalation");
});

test("runRepoBackedSmoke proves artifact persistence and rollback restoration in a temp git repo", async () => {
  const result = await runRepoBackedSmoke({ rootDir: ROOT_DIR });

  assert.equal(result.groundedSmoke.ok, true);
  assert.equal(result.groundedSmoke.contractWritten, true);
  assert.equal(result.groundedSmoke.ledgerWritten, true);
  assert.equal(result.groundedSmoke.groundingArtifactWritten, true);

  assert.equal(result.rollbackSmoke.ok, true);
  assert.equal(result.rollbackSmoke.lifecycleState, "human_escalation");
  assert.equal(result.rollbackSmoke.rollbackBoundaryWritten, true);
  assert.equal(result.rollbackSmoke.rollbackOutcomeWritten, true);
  assert.equal(result.rollbackSmoke.leashArtifactWritten, true);
  assert.equal(result.rollbackSmoke.restoredOriginalContent, true);
});
