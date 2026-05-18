import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "../../packages/mcp/package.json" with { type: "json" };
import serverJson from "../../packages/mcp/server.json" with { type: "json" };

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const METADATA_SCRIPT = path.join(ROOT_DIR, "scripts", "read-mcp-package-metadata.mjs");

test("publish-mcp workflow enforces mcp tag parity against package and server metadata", async () => {
  const workflowPath = path.join(ROOT_DIR, ".github", "workflows", "publish-mcp.yml");
  const workflow = await readFile(workflowPath, "utf8");
  const metadataScript = await readFile(METADATA_SCRIPT, "utf8");

  assert.match(workflow, /Read MCP package metadata/);
  assert.match(workflow, /id: mcp-metadata/);
  assert.match(workflow, /read-mcp-package-metadata\.mjs/);
  assert.match(metadataScript, /server\.json is missing an npm package entry/);
  assert.match(workflow, /Verify MCP tag\/version parity/);
  assert.match(workflow, /TAG_VERSION="\$\{GITHUB_REF_NAME#mcp-v\}"/);
  assert.match(workflow, /Expected an mcp-vX\.Y\.Z tag/);
  assert.match(workflow, /steps\.mcp-metadata\.outputs\.package_version/);
  assert.match(workflow, /steps\.mcp-metadata\.outputs\.server_version/);
  assert.match(workflow, /does not match package\.json version/);
  assert.match(workflow, /does not match server\.json version/);
});

test("metadata reader emits GitHub output keys from packages/mcp", () => {
  const result = spawnSync(process.execPath, [METADATA_SCRIPT], {
    cwd: path.join(ROOT_DIR, "packages", "mcp"),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^package_version=${packageJson.version.replaceAll(".", "\\.")}$`, "m"));
  assert.match(result.stdout, new RegExp(`^server_version=${serverJson.version.replaceAll(".", "\\.")}$`, "m"));
  assert.match(result.stdout, new RegExp(`^package_name=${packageJson.name.replace("/", "\\/")}$`, "m"));
  assert.match(result.stdout, new RegExp(`^server_name=${serverJson.name.replace("/", "\\/")}$`, "m"));
  const npmPackage = serverJson.packages.find((entry) => entry?.registryType === "npm");
  assert.ok(npmPackage, "server.json must define an npm package entry");
  assert.match(result.stdout, new RegExp(`^identifier=${npmPackage.identifier.replace("/", "\\/")}$`, "m"));
});
