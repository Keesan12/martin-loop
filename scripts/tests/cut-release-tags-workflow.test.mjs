import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("release tag cutter is explicit, immutable, and aligns root/MCP coordinates", async () => {
  const workflow = await readFile(
    path.join(ROOT_DIR, ".github", "workflows", "cut-release-tags.yml"),
    "utf8"
  );

  assert.match(workflow, /branches:\s*[\s\S]*- main/);
  assert.match(workflow, /contains\(github\.event\.head_commit\.message, '\[cut-release\]'\)/);
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

  assert.doesNotMatch(workflow, /git tag -f/);
  assert.doesNotMatch(workflow, /git push[^\n]*--force/);
  assert.doesNotMatch(workflow, /secrets\./);
});
