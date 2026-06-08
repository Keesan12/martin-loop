import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("release-facing workflows avoid deprecated Node 20 action wrappers", async () => {
  const workflowFiles = [
    ".github/workflows/release.yml",
    ".github/workflows/publish-mcp.yml",
    ".github/workflows/martinloop-budget-gate.yml",
  ];

  for (const relativePath of workflowFiles) {
    const workflow = await readFile(path.join(ROOT_DIR, relativePath), "utf8");

    assert.doesNotMatch(workflow, /actions\/checkout@v4/);
    assert.doesNotMatch(workflow, /actions\/setup-node@v4/);
    assert.doesNotMatch(workflow, /pnpm\/action-setup@v4/);
    assert.doesNotMatch(workflow, /softprops\/action-gh-release@v2/);
  }
});
