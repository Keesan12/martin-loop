import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPublicFacade } from "../build-public-facade.mjs";
import {
  createPublicFacadeSmokePlan,
  runPublicFacadeSmoke,
} from "../public-facade-smoke.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("buildPublicFacade keeps sibling workspace imports inside the vendored package topology", async () => {
  await buildPublicFacade({ rootDir: ROOT_DIR });

  const hostedExport = await readFile(
    path.join(ROOT_DIR, "dist", "vendor", "core", "swarm", "hosted-export.js"),
    "utf8",
  );
  const hostedProjection = await readFile(
    path.join(ROOT_DIR, "dist", "vendor", "core", "swarm", "hosted-projection.js"),
    "utf8",
  );

  assert.match(hostedExport, /\.\.\/\.\.\/contracts\/swarm-hosted\.js/u);
  assert.match(hostedProjection, /\.\.\/\.\.\/contracts\/swarm-hosted\.js/u);
  assert.doesNotMatch(hostedExport, /contracts\/dist\/swarm-hosted\.js/u);
  assert.doesNotMatch(hostedProjection, /contracts\/dist\/swarm-hosted\.js/u);
});

test("createPublicFacadeSmokePlan targets the frozen public package surface", () => {
  const plan = createPublicFacadeSmokePlan({ rootDir: ROOT_DIR });

  assert.equal(plan.packageName, "martin-loop");
  assert.equal(plan.installCommand, "npm install martin-loop");
  assert.equal(plan.npxCommand, "npx martin-loop --help");
  assert.match(plan.sdkSmoke.description, /MartinLoop root import/i);
  assert.match(plan.cliSmoke.description, /npx martin-loop/i);
  assert.match(plan.startSmoke.description, /first-run governed workflow/i);
  assert.match(plan.demoSmoke.description, /demo copies the packaged sandbox/i);
  assert.match(plan.governedRunSmoke.description, /governed receipt workflow/i);
  assert.match(plan.unsafeBypassSmoke.description, /unsafe-allow-unguarded-run/i);
});

test("runPublicFacadeSmoke proves the root SDK import, CLI help, start flow, demo sandbox, governed run, and unsafe gate fail-closed behavior from a clean temp project", async () => {
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
  assert.equal(result.unsafeBypassSmoke.exitCode, 8);
});
