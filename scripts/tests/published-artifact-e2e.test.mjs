import test from "node:test";
import assert from "node:assert/strict";

import { resolvePublishedArtifactCommandExecution } from "../published-artifact-e2e.mjs";

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
