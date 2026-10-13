import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createRcValidationEnvironment,
  createRcValidationPlan,
  runRcValidation,
  resolveRcCommandExecution,
} from "../rc-validation.mjs";

test("createRcValidationPlan omits install by default and includes the OSS-safe validation lane", () => {
  const plan = createRcValidationPlan();
  const commands = plan.map((step) => step.command.join(" "));

  assert.equal(commands[0], "pnpm build");
  assert.ok(commands.includes("pnpm test"));
  assert.ok(commands.includes("pnpm oss:validate"));
  assert.ok(commands.includes("pnpm public:smoke"));
  assert.ok(commands.includes("pnpm --filter @martinloop/mcp smoke:pack"));
  assert.ok(commands.includes("node ./scripts/published-artifact-e2e.mjs --package-spec=pack"));
  assert.equal(commands.at(-1), "node ./scripts/published-artifact-e2e.mjs --package-spec=pack");
  assert.ok(!commands.includes("pnpm install --frozen-lockfile"));
});

test("createRcValidationPlan includes install when requested", () => {
  const plan = createRcValidationPlan({ includeInstall: true });
  assert.equal(plan[0].command.join(" "), "pnpm install --frozen-lockfile");
});

test("createRcValidationEnvironment points HOME-style state at an isolated directory", () => {
  const cleanHomeRoot = path.join(os.tmpdir(), "martin-rc-validation-test");
  const env = createRcValidationEnvironment(
    {
      CI: "",
      PATH: process.env.PATH ?? "",
      HOME: "C:\\Users\\ExampleUser",
      USERPROFILE: "C:\\Users\\ExampleUser",
    },
    cleanHomeRoot,
  );

  assert.equal(env.HOME, cleanHomeRoot);
  assert.equal(env.USERPROFILE, cleanHomeRoot);
  assert.equal(env.CI, "true");
  assert.equal(env.MARTIN_RUNS_DIR, path.join(cleanHomeRoot, ".martin", "runs"));
  assert.notEqual(env.HOME, "C:\\Users\\ExampleUser");
});

test("resolveRcCommandExecution keeps Windows command shims behind cmd.exe without joining argv", () => {
  const execution = resolveRcCommandExecution(
    ["pnpm", "--filter", "@martin/core", "test"],
    "win32",
    "C:\\Windows\\System32\\cmd.exe",
  );

  assert.equal(execution.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(execution.args, ["/d", "/c", "pnpm.cmd", "--filter", "@martin/core", "test"]);
  assert.equal(execution.shell, false);
});

test("resolveRcCommandExecution runs native Windows executables directly", () => {
  const execution = resolveRcCommandExecution(
    ["node", "./scripts/published-artifact-e2e.mjs", "--package-spec=pack"],
    "win32",
    "C:\\Windows\\System32\\cmd.exe",
  );

  assert.equal(execution.command, "node");
  assert.deepEqual(execution.args, ["./scripts/published-artifact-e2e.mjs", "--package-spec=pack"]);
  assert.equal(execution.shell, false);
});

test("runRcValidation persists ordered stage results and stops on the first failure", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "martin-rc-validation-summary-test-"));
  const plan = [
    { label: "stage one", command: ["one"] },
    { label: "stage two", command: ["two"] },
    { label: "stage three", command: ["three"] },
  ];
  const calls = [];
  const runner = async (step, options) => {
    calls.push(step.label);
    return {
      label: step.label,
      command: [...step.command],
      status: step.label === "stage two" ? "failed" : "passed",
      failureKind: step.label === "stage two" ? "nonzero_exit" : null,
      startedAt: "2026-10-09T12:00:00.000Z",
      completedAt: "2026-10-09T12:00:00.010Z",
      elapsedMs: 10,
      exitCode: step.label === "stage two" ? 7 : 0,
      signal: null,
      timedOut: false,
      timeoutMs: options.timeoutMs,
      spawnError: null,
      termination: { requested: false, attempted: false, observed: false, escalated: false, helperExitCode: null, helperTimedOut: false },
      logPath: path.join(options.logDir, `${options.index}.log`),
    };
  };

  await assert.rejects(
    runRcValidation({ cwd: process.cwd(), tempRoot, plan, runner, timeoutMs: 321 }),
    /stage two.*exit 7/iu,
  );

  assert.deepEqual(calls, ["stage one", "stage two"]);
  const summary = JSON.parse(await readFile(path.join(tempRoot, "logs", "summary.json"), "utf8"));
  assert.equal(summary.status, "failed");
  assert.equal(summary.failureKind, "nonzero_exit");
  assert.equal(summary.activeStage, null);
  assert.equal(summary.failedStage, "stage two");
  assert.equal(summary.results.length, 2);
  assert.equal(summary.results[1].exitCode, 7);
  assert.equal(summary.results[1].elapsedMs, 10);
  assert.equal(summary.platform, process.platform);
  assert.equal(summary.toolchain.node, process.version);
  assert.equal(typeof summary.toolchain.pnpm, "string");
});

test("runRcValidation records a fully passed summary after every planned stage succeeds", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "martin-rc-validation-pass-test-"));
  const plan = [
    { label: "stage one", command: ["one"] },
    { label: "stage two", command: ["two"] },
  ];
  const runner = async (step, options) => ({
    label: step.label,
    command: [...step.command],
    status: "passed",
    failureKind: null,
    startedAt: "2026-10-09T12:00:00.000Z",
    completedAt: "2026-10-09T12:00:00.001Z",
    elapsedMs: 1,
    exitCode: 0,
    signal: null,
    timedOut: false,
    timeoutMs: options.timeoutMs,
    spawnError: null,
    termination: { requested: false, attempted: false, observed: false, escalated: false, helperExitCode: null, helperTimedOut: false },
    logPath: path.join(options.logDir, `${options.index}.log`),
  });

  const result = await runRcValidation({ cwd: process.cwd(), tempRoot, plan, runner, timeoutMs: 321 });
  const summary = JSON.parse(await readFile(path.join(tempRoot, "logs", "summary.json"), "utf8"));

  assert.equal(result.status, "passed");
  assert.equal(summary.status, "passed");
  assert.equal(summary.results.length, 2);
  assert.deepEqual(summary.results.map((item) => item.label), ["stage one", "stage two"]);
  assert.match(summary.completedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.ok(Number.isFinite(summary.elapsedMs));
});
