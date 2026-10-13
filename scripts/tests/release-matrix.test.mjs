import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createReleaseMatrixEnvironment,
  createReleaseMatrixPlan,
  resolveReleaseMatrixLane,
  runLocalReleaseMatrix,
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
    const buildIndex = commands.indexOf("pnpm build");
    const rootGuardIndex = commands.indexOf("pnpm release:root:guard");
    const testIndex = commands.indexOf("pnpm test");

    assert.ok(buildIndex >= 0, "release matrix should include the build step");
    assert.ok(rootGuardIndex >= 0, "release matrix should include the root package guard");
    assert.ok(testIndex >= 0, "release matrix should include the broader test lane");
    assert.ok(
      buildIndex < rootGuardIndex,
      "root package guard should run after build output exists",
    );
    assert.ok(
      rootGuardIndex < testIndex,
      "root package guard should run before the broader test lane",
    );
  }
});

test("createReleaseMatrixPlan runs a packaged root artifact E2E before declaring the lane green", () => {
  const plan = createReleaseMatrixPlan({ rootDir: "C:/repo" });

  for (const lane of plan.lanes) {
    const commands = lane.steps.map((step) => step.command.join(" "));

    assert.ok(
      commands.includes("node ./scripts/published-artifact-e2e.mjs --package-spec=pack"),
      `${lane.id} lane should exercise the packed root artifact E2E`,
    );
    assert.equal(
      commands.at(-1),
      "node ./scripts/published-artifact-e2e.mjs --package-spec=pack",
      `${lane.id} lane should finish on the packaged root artifact E2E`,
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

test("runLocalReleaseMatrix persists a repository timeout result and does not attempt later stages", async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "martin-release-matrix-summary-test-"));
  const plan = {
    rootDir: process.cwd(),
    lanes: [{
      id: "test",
      runner: "local-test",
      platform: process.platform,
      steps: [
        { label: "stage one", command: ["one"] },
        { label: "stage two", command: ["two"] },
        { label: "stage three", command: ["three"] },
      ],
    }],
  };
  const calls = [];
  const runner = async (step, options) => {
    calls.push(step.label);
    const timedOut = step.label === "stage two";
    return {
      label: step.label,
      command: [...step.command],
      status: timedOut ? "failed" : "passed",
      failureKind: timedOut ? "repository_stage_timeout" : null,
      startedAt: "2026-10-09T12:00:00.000Z",
      completedAt: "2026-10-09T12:00:00.020Z",
      elapsedMs: 20,
      exitCode: timedOut ? null : 0,
      signal: null,
      timedOut,
      timeoutMs: options.timeoutMs,
      spawnError: null,
      termination: { requested: timedOut, attempted: timedOut, observed: timedOut, escalated: false, helperExitCode: 0, helperTimedOut: false },
      logPath: path.join(options.logDir, `${options.index}.log`),
    };
  };

  await assert.rejects(
    runLocalReleaseMatrix({ outputRoot, plan, runner, timeoutMs: 654 }),
    /stage two.*repository stage timeout/iu,
  );

  assert.deepEqual(calls, ["stage one", "stage two"]);
  const summary = JSON.parse(await readFile(path.join(outputRoot, "logs", "summary.json"), "utf8"));
  assert.equal(summary.status, "failed");
  assert.equal(summary.failureKind, "repository_stage_timeout");
  assert.equal(summary.externalHarnessTimedOut, false);
  assert.equal(summary.results.length, 2);
  assert.equal(summary.results[1].timedOut, true);
  assert.equal(summary.results[1].termination.observed, true);
});
