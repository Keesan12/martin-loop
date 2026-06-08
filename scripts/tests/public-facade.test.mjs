import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicFacadeSmokePlan,
  runPublicFacadeSmoke,
} from "../public-facade-smoke.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("createPublicFacadeSmokePlan targets the frozen public package surface", () => {
  const plan = createPublicFacadeSmokePlan({ rootDir: ROOT_DIR });

  assert.equal(plan.packageName, "martin-loop");
  assert.equal(plan.installCommand, "npm install martin-loop");
  assert.equal(plan.npxCommand, "npx martin-loop --help");
  assert.match(plan.sdkSmoke.description, /MartinLoop root import/i);
  assert.match(plan.cliSmoke.description, /npx martin-loop/i);
  assert.match(plan.startSmoke.description, /first-run governed workflow/i);
  assert.match(plan.demoSmoke.description, /demo copies the packaged sandbox/i);
  assert.match(plan.governedRunSmoke.description, /auto-bootstraps governed prerequisites/i);
  assert.match(plan.unsafeBypassSmoke.description, /unsafe-allow-unguarded-run/i);
});

test("runPublicFacadeSmoke proves the root SDK import, CLI help, start flow, demo sandbox, governed run, and unsafe gate bypass behavior from a clean temp project", async () => {
  const result = await runPublicFacadeSmoke({ rootDir: ROOT_DIR });

  assert.equal(result.packageName, "martin-loop");
  assert.match(result.packedFiles.join("\n"), /dist\/index\.js/);
  assert.match(result.packedFiles.join("\n"), /dist\/bin\/martin-loop\.js/);
  assert.equal(result.sdkSmoke.ok, true);
  assert.equal(result.sdkSmoke.exportName, "MartinLoop");
  assert.equal(result.cliSmoke.ok, true);
  assert.equal(result.cliSmoke.command, "npx martin-loop --help");
  assert.equal(result.startSmoke.ok, true);
  assert.equal(result.startSmoke.command, "npx martin-loop start");
  assert.equal(result.demoSmoke.ok, true);
  assert.equal(result.demoSmoke.command, "npx martin-loop demo --dir ./martin-loop-demo");
  assert.equal(result.governedRunSmoke.ok, true);
  assert.equal(result.governedRunSmoke.adapterId, "agent-cli:codex");
  assert.equal(result.unsafeBypassSmoke.ok, true);
  assert.match(result.unsafeBypassSmoke.command, /unsafe-allow-unguarded-run/);
  assert.notEqual(result.unsafeBypassSmoke.exitCode, 8);
});
