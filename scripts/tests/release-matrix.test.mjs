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

test("createReleaseMatrixPlan checks root package boundaries before the full test lane", () => {
  const plan = createReleaseMatrixPlan({ rootDir: "C:/repo" });

  for (const lane of plan.lanes) {
    const commands = lane.steps.map((step) => step.command.join(" "));
    assert.ok(
      commands.indexOf("pnpm build") < commands.indexOf("pnpm release:root:guard"),
      "root package guard should run after build output exists",
    );
    assert.ok(
      commands.indexOf("pnpm release:root:guard") < commands.indexOf("pnpm test"),
      "root package guard should run before the broader test lane",
    );
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

test("createReleaseMatrixEnvironment preserves explicit non-empty values", () => {
  const env = createReleaseMatrixEnvironment({
    PATH: process.env.PATH ?? "",
    CI: "already-set",
    npm_config_confirm_modules_purge: "preserve-me",
  });

  assert.equal(env.CI, "already-set");
  assert.equal(env.npm_config_confirm_modules_purge, "preserve-me");
});

test("createReleaseMatrixEnvironment honors mixed-case install env keys", () => {
  const env = createReleaseMatrixEnvironment({
    PATH: process.env.PATH ?? "",
    NPM_CONFIG_CONFIRM_MODULES_PURGE: "mixed-case-value",
  });

  assert.equal(env.npm_config_confirm_modules_purge, "mixed-case-value");
});
