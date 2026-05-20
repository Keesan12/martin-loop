import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("root release workflow validates npm auth before publishing", async () => {
  const workflowPath = path.join(ROOT_DIR, ".github", "workflows", "release.yml");
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /push:\s*[\s\S]*tags:\s*[\s\S]*"v\*\.\*\.\*"/);
  assert.match(workflow, /permissions:\s*[\s\S]*contents:\s*write/);
  assert.match(workflow, /permissions:\s*[\s\S]*id-token:\s*write/);
  assert.match(workflow, /id: npm-publish/);
  assert.match(workflow, /NPM_TOKEN_GITHUB_RELEASE/);
  assert.match(workflow, /NPM_TOKEN_AUTOMATION/);
  assert.match(workflow, /NPM_TOKEN:/);
  assert.match(workflow, /for token_name in NPM_TOKEN_GITHUB_RELEASE NPM_TOKEN_AUTOMATION NPM_TOKEN/);
  assert.match(workflow, /npm whoami --registry=https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /failed npm whoami; trying the next configured token/);
  assert.match(workflow, /authenticated but could not publish/);
  assert.match(workflow, /npm publish "\$\{\{ steps\.root-pack\.outputs\.tarball \}\}" --access public --provenance/);
  assert.match(workflow, /npm view "martin-loop@\$\{\{ steps\.package-version\.outputs\.version \}\}" version/);
  assert.match(workflow, /softprops\/action-gh-release@v2/);
});
