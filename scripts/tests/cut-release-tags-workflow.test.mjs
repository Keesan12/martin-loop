import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("release tag cutter is explicit, immutable, and dispatches trusted publishers", async () => {
  const workflow = await readFile(
    path.join(ROOT_DIR, ".github", "workflows", "cut-release-tags.yml"),
    "utf8"
  );

  assert.match(workflow, /branches:\s*[\s\S]*- main/);
  assert.match(workflow, /permissions:\s*[\s\S]*contents:\s*write[\s\S]*actions:\s*write/);
  assert.match(workflow, /contains\(github\.event\.head_commit\.message, '\[cut-release\]'\)/);
  assert.match(workflow, /contains\(github\.event\.head_commit\.message, '\[publish-existing-release\]'\)/);
  assert.match(workflow, /require\('\.\/package\.json'\)\.version/);
  assert.match(workflow, /require\('\.\/packages\/mcp\/package\.json'\)\.version/);
  assert.match(workflow, /require\('\.\/packages\/mcp\/server\.json'\)\.version/);
  assert.match(workflow, /require\('\.\/packages\/mcp\/mcpb\/manifest\.json'\)\.version/);
  assert.match(workflow, /OSS-\$\{ROOT_VERSION\}-RELEASE-NOTES\.md/);
  assert.match(workflow, /MCP-\$\{MCP_VERSION\}-RELEASE-NOTES\.md/);
  assert.match(workflow, /extract-changelog-entry\.mjs --version "\$ROOT_VERSION"/);
  assert.match(workflow, /Refusing to move it/);
  assert.match(workflow, /git tag -a "\$ROOT_TAG" "\$GITHUB_SHA"/);
  assert.match(workflow, /git tag -a "\$MCP_TAG" "\$GITHUB_SHA"/);
  assert.match(workflow, /git push origin "\$ROOT_TAG" "\$MCP_TAG"/);
  assert.match(workflow, /\^\{commit\}/);
  assert.match(workflow, /Root and MCP release tags do not resolve to the same commit/);
  assert.match(workflow, /git show "\$\{ROOT_TAG\}:package\.json"/);
  assert.match(workflow, /git show "\$\{MCP_TAG\}:packages\/mcp\/package\.json"/);
  assert.match(workflow, /gh workflow run release\.yml --ref main -f tag=/);
  assert.match(workflow, /gh workflow run publish-mcp\.yml --ref main -f tag=/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);

  assert.doesNotMatch(workflow, /git tag -f/);
  assert.doesNotMatch(workflow, /git push[^\n]*--force/);
  assert.doesNotMatch(workflow, /secrets\./);
});
