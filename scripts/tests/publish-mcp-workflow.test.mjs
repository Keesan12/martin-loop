import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("publish-mcp workflow enforces mcp tag parity against package and server metadata", async () => {
  const workflowPath = path.join(ROOT_DIR, ".github", "workflows", "publish-mcp.yml");
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /Read MCP package metadata/);
  assert.match(workflow, /id: mcp-metadata/);
  assert.match(workflow, /server\.json is missing an npm package entry/);
  assert.match(workflow, /Verify MCP tag\/version parity/);
  assert.match(workflow, /TAG_VERSION="\$\{GITHUB_REF_NAME#mcp-v\}"/);
  assert.match(workflow, /Expected an mcp-vX\.Y\.Z tag/);
  assert.match(workflow, /steps\.mcp-metadata\.outputs\.package_version/);
  assert.match(workflow, /steps\.mcp-metadata\.outputs\.server_version/);
  assert.match(workflow, /does not match package\.json version/);
  assert.match(workflow, /does not match server\.json version/);
});
