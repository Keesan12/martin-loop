import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOWS_DIR = path.join(ROOT_DIR, ".github", "workflows");

test("all third-party actions are pinned by immutable commit SHA", async () => {
  const workflowNames = (await readdir(WORKFLOWS_DIR)).filter((name) => name.endsWith(".yml"));

  for (const workflowName of workflowNames) {
    const workflowPath = path.join(WORKFLOWS_DIR, workflowName);
    const workflow = await readFile(workflowPath, "utf8");
    const matches = [...workflow.matchAll(/^\s*-?\s*uses:\s+([^\s#]+)(?:\s+#.*)?$/gm)];

    for (const match of matches) {
      const action = match[1];
      if (action.startsWith("./")) continue;

      const separator = action.lastIndexOf("@");
      assert.notEqual(separator, -1, `${workflowName} has an invalid uses entry: ${action}`);
      const ref = action.slice(separator + 1);
      assert.match(
        ref,
        /^[a-f0-9]{40}$/,
        `${workflowName} must pin ${action.slice(0, separator)} with a full commit SHA, found ${ref}`,
      );
    }
  }
});

test("privileged publisher workflows bind trusted main to paired release tags", async () => {
  for (const workflowName of ["publish-mcp.yml", "release.yml"]) {
    const workflowPath = path.join(WORKFLOWS_DIR, workflowName);
    const workflow = await readFile(workflowPath, "utf8");

    assert.match(workflow, /ref:\s+main/);
    assert.doesNotMatch(workflow, /github\.event\.workflow_run\.head_sha/);
    assert.match(workflow, /MAIN_SHA="\$\(git rev-parse origin\/main\)"/);
    assert.match(workflow, /HEAD_SHA="\$\(git rev-parse HEAD\)"/);
    assert.match(workflow, /test "\$HEAD_SHA" = "\$TAG_SHA"/);
    assert.match(workflow, /test "\$TAG_SHA" = "\$MAIN_SHA"/);
  }
});
