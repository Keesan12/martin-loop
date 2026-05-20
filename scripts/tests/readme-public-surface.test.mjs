import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import rootPackageJson from "../../package.json" with { type: "json" };
import mcpPackageJson from "../../packages/mcp/package.json" with { type: "json" };

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const FORBIDDEN_README_PATTERNS = [
  /\b0\.1\.4\b/i,
  /\brelease candidate\b/i,
  /\bregistry publication\b/i,
  /\brepo:smoke\b/i,
  /\bpilot:prep:validate\b/i,
  /\bworkspace-only\b/i,
  /\bprivate workspace\b/i,
  /\bhosted control-plane\b/i,
  /\blocal dashboard\b/i,
  /\bapps\/control-plane\b/i,
  /\bapps\/local-dashboard\b/i,
  /\bbenchmarks\//i,
  /\bPlase\b/i,
  /\bmartin command alias\b/i,
  /^martin run\b/im,
  /^martin inspect\b/im,
  /^martin resume\b/im
];

async function readReadme() {
  return readFile(path.join(ROOT_DIR, "README.md"), "utf8");
}

test("root README matches the current public package versions and launch surfaces", async () => {
  const readme = await readReadme();

  assert.match(readme, new RegExp(`martin-loop@${rootPackageJson.version.replaceAll(".", "\\.")}`));
  assert.match(readme, /npm install -g martin-loop/);
  assert.match(readme, /npx martin-loop demo/);
  assert.match(readme, /MARTIN_LIVE=false npx martin-loop run/);
  assert.match(readme, /npx martin-loop run/);
  assert.match(readme, /npx martin-loop inspect/);
  assert.match(readme, /npx martin-loop resume/);
  assert.match(readme, new RegExp(`@martinloop/mcp@${mcpPackageJson.version.replaceAll(".", "\\.")}`));
  assert.match(readme, /ten stdio tools plus read-only resources/i);
  assert.match(readme, /`martin_run` remains the only tool that can execute work/i);
  assert.match(readme, /martin_list_runs/);
  assert.match(readme, /martin_run_dossier/);
});

test("root README stays clean client-facing public copy", async () => {
  const readme = await readReadme();

  for (const pattern of FORBIDDEN_README_PATTERNS) {
    assert.doesNotMatch(readme, pattern);
  }
});
