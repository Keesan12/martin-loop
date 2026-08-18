import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("root release workflow uses GitHub Actions trusted publishing without npm tokens", async () => {
  const workflowPath = path.join(ROOT_DIR, ".github", "workflows", "release.yml");
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /push:\s*[\s\S]*tags:\s*[\s\S]*"v\*\.\*\.\*"/);
  assert.match(workflow, /permissions:\s*[\s\S]*contents:\s*write/);
  assert.match(workflow, /permissions:\s*[\s\S]*id-token:\s*write/);
  assert.match(workflow, /node-version:\s*24/);
  assert.match(workflow, /npm install -g npm@latest/);
  assert.match(workflow, /npm publish "\$\{\{ steps\.root-pack\.outputs\.tarball \}\}" --access public --provenance/);
  assert.match(workflow, /npm view "martin-loop@\$\{\{ steps\.package-version\.outputs\.version \}\}" version/);
  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /pnpm\/action-setup@b0f76dfb45f55f8421693e4803ac7bb65143bd34/);
  assert.match(workflow, /actions\/setup-node@v6/);
  assert.match(workflow, /softprops\/action-gh-release@718ea10b132b3b2eba29c1007bb80653f286566b/);
  assert.match(workflow, /pnpm --filter @martinloop\/mcp mcpb:build/);
  assert.match(workflow, /pnpm --filter @martinloop\/mcp mcpb:validate/);
  assert.match(workflow, /pnpm --filter @martinloop\/mcp mcpb:smoke/);
  assert.match(workflow, /packages\/mcp\/dist-mcpb\/martinloop-\*\.mcpb/);
  assert.match(workflow, /packages\/mcp\/dist-mcpb\/martinloop-\*\.mcpb\.sha256/);

  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN/);
  assert.doesNotMatch(workflow, /NPM_TOKEN/);
  assert.doesNotMatch(workflow, /registry-url/);
  assert.doesNotMatch(workflow, /secrets\./);
});
