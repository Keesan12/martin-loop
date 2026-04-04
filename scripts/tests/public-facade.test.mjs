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
});

test("runPublicFacadeSmoke proves the root SDK import and CLI help work from a clean temp project", async () => {
  const result = await runPublicFacadeSmoke({ rootDir: ROOT_DIR });

  assert.equal(result.packageName, "martin-loop");
  assert.equal(result.sdkSmoke.ok, true);
  assert.equal(result.sdkSmoke.exportName, "MartinLoop");
  assert.equal(result.cliSmoke.ok, true);
  assert.equal(result.cliSmoke.command, "npx martin-loop --help");
});
