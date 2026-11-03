import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePublishedArtifactCommandExecution } from "../published-artifact-e2e.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("published artifact E2E runs native Windows executables without a command shell", () => {
  const execution = resolvePublishedArtifactCommandExecution(
    ["git", "commit", "-m", "Add packaged artifact E2E fixture"],
    "win32",
    "C:\\Windows\\System32\\cmd.exe",
  );

  assert.equal(execution.command, "git");
  assert.deepEqual(execution.args, ["commit", "-m", "Add packaged artifact E2E fixture"]);
  assert.equal(execution.shell, false);
});

test("published artifact E2E keeps Windows command shims behind cmd.exe", () => {
  const execution = resolvePublishedArtifactCommandExecution(
    ["npm", "install", "--save-exact", "C:\\Temp With Spaces\\martin-loop-0.5.8.tgz"],
    "win32",
    "C:\\Windows\\System32\\cmd.exe",
  );

  assert.equal(execution.command, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(execution.shell, false);
  assert.deepEqual(execution.args, [
    "/d",
    "/c",
    "npm.cmd",
    "install",
    "--save-exact",
    "C:\\Temp With Spaces\\martin-loop-0.5.8.tgz",
  ]);
});

test("published artifact E2E leaves headroom after its single successful attempt", async () => {
  const script = await readFile(path.join(ROOT_DIR, "scripts", "published-artifact-e2e.mjs"), "utf8");

  assert.match(script, /maxIterations: 2/);
  assert.doesNotMatch(script, /maxIterations: 1/);
  assert.match(script, /runsRoot: request\.context\.runsRoot/);
  assert.match(script, /receiptScope: \{/);
  assert.match(script, /verificationPlan: \["node \$\{VERIFIER_FILE\}"\]/);
  assert.match(script, /actual === expected \? 0 : 1/);
  assert.match(script, /"runs", "verify"/);
  assert.match(script, /verification\?\.status !== "passed"/);
});
