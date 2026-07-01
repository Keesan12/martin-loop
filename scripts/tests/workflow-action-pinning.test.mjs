import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOWS_DIR = path.join(ROOT_DIR, ".github", "workflows");

const PINNED_ACTIONS = new Map([
  ["pnpm/action-setup", /^[a-f0-9]{40}$/],
  ["softprops/action-gh-release", /^[a-f0-9]{40}$/],
]);

for (const [actionName, shaPattern] of PINNED_ACTIONS) {
  test(`${actionName} is pinned by commit SHA in public workflows`, async () => {
    const workflowNames = ["martinloop-budget-gate.yml", "publish-mcp.yml", "release.yml"];

    for (const workflowName of workflowNames) {
      const workflowPath = path.join(WORKFLOWS_DIR, workflowName);
      const workflow = await readFile(workflowPath, "utf8");
      const matches = [...workflow.matchAll(new RegExp(`${actionName.replaceAll("/", "\\/")}@([^\\s]+)`, "g"))];

      for (const match of matches) {
        const ref = match[1];
        assert.match(
          ref,
          shaPattern,
          `${workflowName} must pin ${actionName} with a full commit SHA, found ${ref}`,
        );
      }
    }
  });
}
