import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("MCP registry workflow registers the exact immutable release tag with OIDC", async () => {
  const workflowPath = path.join(ROOT_DIR, ".github", "workflows", "register-current-mcp.yml");
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /workflow_dispatch:\s*[\s\S]*inputs:\s*[\s\S]*tag:/);
  assert.match(workflow, /Expected an mcp-vX\.Y\.Z tag/);
  assert.match(workflow, /ref:\s*\$\{\{ steps\.release-ref\.outputs\.ref \}\}/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /TAG_VERSION="\$\{RELEASE_TAG#mcp-v\}"/);
  assert.match(workflow, /does not match the checked-out MCP package version/);
  assert.match(workflow, /permissions:\s*[\s\S]*contents:\s*read/);
  assert.match(workflow, /permissions:\s*[\s\S]*id-token:\s*write/);
  assert.match(workflow, /npm view "\$\{\{ steps\.mcp-metadata\.outputs\.package_name \}\}@\$\{\{ steps\.mcp-metadata\.outputs\.version \}\}" version/);
  assert.match(workflow, /mcp-publisher login github-oidc/);
  assert.match(workflow, /mcp-publisher publish/);
  assert.match(workflow, /Verify official MCP Registry listing/);
  assert.match(workflow, /registry\.modelcontextprotocol\.io/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN/);
  assert.doesNotMatch(workflow, /NPM_TOKEN/);
  assert.doesNotMatch(workflow, /secrets\./);
});
