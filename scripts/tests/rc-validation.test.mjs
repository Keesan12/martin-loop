import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import {
  createRcValidationEnvironment,
  createRcValidationPlan,
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
