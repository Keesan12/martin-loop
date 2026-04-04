import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import {
  createRcValidationEnvironment,
  createRcValidationPlan,
  resolveRcCommandExecution,
} from "../rc-validation.mjs";

test("createRcValidationPlan omits install by default and includes the RC matrix", () => {
  const plan = createRcValidationPlan();
  const commands = plan.map((step) => step.command.join(" "));

  assert.equal(commands[0], "pnpm --filter @martin/contracts build");
  assert.ok(commands.includes("pnpm --filter @martin/core test"));
  assert.ok(commands.includes("pnpm --filter @martin/benchmarks eval:phase12"));
  assert.ok(commands.includes("pnpm --filter @martin/benchmarks eval:providers"));
  assert.ok(commands.includes("pnpm release:surface:validate"));
  assert.ok(commands.includes("pnpm pilot:prep:validate"));
  assert.ok(commands.includes("pnpm oss:validate"));
  assert.ok(commands.includes("pnpm public:smoke"));
  assert.equal(commands.at(-2), "pnpm build");
  assert.equal(commands.at(-1), "pnpm public:smoke");
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
      PATH: process.env.PATH ?? "",
      HOME: "C:\\Users\\Torram",
      USERPROFILE: "C:\\Users\\Torram",
    },
    cleanHomeRoot,
  );

  assert.equal(env.HOME, cleanHomeRoot);
  assert.equal(env.USERPROFILE, cleanHomeRoot);
  assert.equal(env.MARTIN_RUNS_DIR, path.join(cleanHomeRoot, ".martin", "runs"));
  assert.notEqual(env.HOME, "C:\\Users\\Torram");
});

test("resolveRcCommandExecution avoids shell mode on Windows by invoking cmd.exe explicitly", () => {
  const execution = resolveRcCommandExecution(
    ["pnpm", "--filter", "@martin/core", "test"],
    "win32",
    "C:\\Windows\\System32\\cmd.exe",
  );

  assert.equal(execution.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(execution.args, ["/d", "/s", "/c", "pnpm --filter @martin/core test"]);
  assert.equal(execution.shell, false);
});
