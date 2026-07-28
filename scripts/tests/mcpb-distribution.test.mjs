import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { shouldScanPath } from "../public-portability-guard.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function read(relativePath) {
  return readFile(path.join(ROOT_DIR, relativePath), "utf8");
}

test("MCPB workflow does not persist checkout credentials", async () => {
  const workflow = await read(".github/workflows/test-mcpb.yml");

  assert.match(workflow, /uses:\s*actions\/checkout@v6[\s\S]*?persist-credentials:\s*false/);
});

test("MCPB dependencies and commands are lockfile managed", async () => {
  const packageJson = JSON.parse(await read("packages/mcp/package.json"));
  const builder = await read("packages/mcp/mcpb/build-mcpb.mjs");
  const ignore = await read("packages/mcp/mcpb/.mcpbignore");

  assert.equal(packageJson.devDependencies["@anthropic-ai/mcpb"], "2.1.2");
  assert.equal(packageJson.scripts["mcpb:validate"], "mcpb validate ./dist-mcpb/martinloop");
  assert.match(builder, /const pnpmCli = process\.env\.npm_execpath/);
  assert.match(
    builder,
    /"--config\.inject-workspace-packages=true"[\s\S]*"--config\.node-linker=hoisted"[\s\S]*"@martinloop\/mcp"[\s\S]*"deploy"[\s\S]*"--prod"[\s\S]*serverRoot/,
  );
  assert.doesNotMatch(builder, /"--legacy"/);
  assert.doesNotMatch(builder, /createCommandLaunch/);
  assert.match(builder, /safe\.directory=\$\{repositoryRoot\}/);
  assert.doesNotMatch(builder, /Could not verify git clean state/);
  assert.doesNotMatch(builder, /\bnpm\b[\s\S]*\binstall\b/);
  assert.doesNotMatch(builder, /\bnpx\b/);
  assert.match(builder, /delete deployedPackage\.devDependencies/);
  assert.match(builder, /node_modules", "\.modules\.yaml"/);
  assert.match(builder, /node_modules", "\.pnpm"/);
  assert.match(ignore, /server\/node_modules\/\*\*\/test\/\*\*/);
  assert.match(ignore, /server\/node_modules\/\*\*\/tests\/\*\*/);
});

test("AGENTS.md remains inside the public portability scan", () => {
  assert.equal(shouldScanPath("AGENTS.md"), true);
});

test("MCPB README documents install, import, configuration, and verification", async () => {
  const readme = await read("packages/mcp/mcpb/README.md");

  assert.match(readme, /pnpm install --frozen-lockfile/);
  assert.match(readme, /import/i);
  assert.match(readme, /launch/i);
  assert.match(readme, /MARTIN_MCP_WORKSPACE_ROOT/);
  assert.match(readme, /MARTIN_RUNS_DIR/);
  assert.match(readme, /MARTIN_LIVE/);
  assert.match(readme, /verify/i);
});
