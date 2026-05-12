import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("publish-mcp workflow enforces tag parity and bounded retries for post-publish verification", async () => {
  const workflowPath = path.join(ROOT_DIR, ".github", "workflows", "publish-mcp.yml");
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /Verify MCP tag\/version parity/);
  assert.match(workflow, /TAG_VERSION="\$\{GITHUB_REF_NAME#mcp-v\}"/);
  assert.match(workflow, /steps\.mcp-metadata\.outputs\.package_version/);
  assert.match(workflow, /steps\.mcp-metadata\.outputs\.server_version/);
  assert.match(workflow, /for attempt in 1 2 3 4 5; do/);
  assert.match(workflow, /npm view "\$\{MCP_PACKAGE_SPEC\}" version/);
  assert.match(workflow, /for attempt in 1 2 3; do/);
  assert.match(workflow, /pnpm --filter @martinloop\/mcp smoke:published/);
});
