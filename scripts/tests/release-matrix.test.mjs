import test from "node:test";
import assert from "node:assert/strict";

import {
  createReleaseMatrixEnvironment,
  createReleaseMatrixPlan,
  resolveReleaseMatrixLane,
} from "../release-matrix.mjs";

test("createReleaseMatrixPlan keeps install first in every platform lane", () => {
  const plan = createReleaseMatrixPlan({ rootDir: "C:/repo" });

  assert.equal(plan.rootDir, "C:/repo");
  assert.equal(plan.lanes.length, 3);
  for (const lane of plan.lanes) {
    assert.equal(lane.steps[0]?.command.join(" "), "pnpm install --frozen-lockfile");
  }
});

test("resolveReleaseMatrixLane selects the correct local platform lane", () => {
  const plan = createReleaseMatrixPlan({ rootDir: "C:/repo" });

  assert.equal(resolveReleaseMatrixLane(plan, "win32").id, "windows");
  assert.equal(resolveReleaseMatrixLane(plan, "darwin").id, "macos");
  assert.equal(resolveReleaseMatrixLane(plan, "linux").id, "linux");
});

test("createReleaseMatrixEnvironment forces non-interactive install defaults", () => {
  const env = createReleaseMatrixEnvironment({
    PATH: process.env.PATH ?? "",
    CI: "",
    npm_config_confirm_modules_purge: "",
  });

  assert.equal(env.CI, "true");
  assert.equal(env.npm_config_confirm_modules_purge, "false");
});
