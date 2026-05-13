import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "../../packages/mcp/package.json" with { type: "json" };
import serverJson from "../../packages/mcp/server.json" with { type: "json" };

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("MCP package metadata stays aligned with server metadata", () => {
  const npmPackage = serverJson.packages.find((entry) => entry?.registryType === "npm");

  assert.ok(npmPackage, "server.json must define an npm package entry");
  assert.equal(packageJson.version, serverJson.version);
  assert.equal(packageJson.version, npmPackage.version);
  assert.equal(packageJson.name, npmPackage.identifier);
  assert.equal(packageJson.mcpName, serverJson.name);
});

test("publish-mcp workflow keeps bounded npm view and smoke retries with backoff", async () => {
  const workflowPath = path.join(ROOT_DIR, ".github", "workflows", "publish-mcp.yml");
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /MCP_PACKAGE_SPEC:/);
  assert.match(workflow, /for attempt in 1 2 3 4 5; do/);
  assert.match(workflow, /npm view "\$\{MCP_PACKAGE_SPEC\}" version/);
  assert.match(workflow, /sleep \$\(\(attempt \* 15\)\)/);
  assert.match(workflow, /for attempt in 1 2 3; do/);
  assert.match(workflow, /pnpm --filter @martinloop\/mcp smoke:published/);
  assert.match(workflow, /sleep \$\(\(attempt \* 20\)\)/);
  assert.match(workflow, /after bounded retries/);
});
