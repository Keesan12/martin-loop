import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "../../packages/mcp/package.json" with { type: "json" };
import serverJson from "../../packages/mcp/server.json" with { type: "json" };
import rootPackageJson from "../../package.json" with { type: "json" };

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const EXPECTED_TOOLS = [
  "martin_run",
  "martin_inspect",
  "martin_status",
  "martin_doctor",
  "martin_preflight",
  "martin_list_runs",
  "martin_triage_runs",
  "martin_get_run",
  "martin_get_attempt",
  "martin_get_verification_results",
  "martin_run_dossier",
];

const EXPECTED_RESOURCES = [
  "martin://server/health",
  "martin://runs/recent",
  "martin://runs/triage",
  "martin://runs/latest/summary",
  "martin://runs/latest/proof-card",
  "martin://runs/latest/budget-status",
  "martin://runs/latest/verifier-evidence",
  "martin://runs/latest/rollback-evidence",
  "martin://agent/next-step",
  "martin://guides/mcp-usage",
  "martin://guides/publish-readiness",
];

const EXPECTED_PROMPTS = [
  "martin_start",
  "martin_preflight",
  "martin_triage",
  "martin_resume",
  "martin_prove",
  "martin_release_check",
  "martin_governed_coding_kickoff",
  "martin_debug_failed_run",
  "martin_publish_readiness_review",
  "martin_triage_run_store",
];

const FORBIDDEN_DOC_PATTERNS = [
  /\bstable cockpit line\b/i,
  /\brelease train\b/i,
  /\brelease packet\b/i,
  /\bdelivery slice\b/i,
  /\bprivate beta\b/i,
  /\bmain workspace\b/i,
  /\bdocs\/oss\b/i,
  /\bdocs\/distribution\b/i,
  /\bVERSION-LEDGER\b/i,
];

async function readRepoFile(relativePath) {
  return readFile(path.join(ROOT_DIR, relativePath), "utf8");
}

function escapeRegex(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractMartinToolNames(serverSource) {
  return [...new Set([...serverSource.matchAll(/name:\s*"(martin_[a-z_]+)"/g)].map((match) => match[1]))];
}

test("MCP package metadata stays aligned with server metadata", () => {
  const npmPackage = serverJson.packages.find((entry) => entry?.registryType === "npm");

  assert.ok(npmPackage, "server.json must define an npm package entry");
  assert.equal(packageJson.version, serverJson.version);
  assert.equal(packageJson.version, npmPackage.version);
  assert.equal(packageJson.name, npmPackage.identifier);
  assert.equal(packageJson.mcpName, serverJson.name);
  assert.equal(serverJson.name, "io.github.Keesan12/martin-loop");
  assert.equal(packageJson.description, serverJson.description);
  assert.ok(serverJson.description.length <= 100, "server.json description must stay within the registry length limit");
  assert.equal(npmPackage.transport?.type, "stdio");
  assert.equal(packageJson.bin?.mcp, "./dist/server.js");
  assert.equal(packageJson.bin?.["martin-loop-mcp"], "./dist/server.js");
  assert.ok(packageJson.files.includes("dist"));
  assert.ok(packageJson.files.includes("README.md"));
  assert.ok(packageJson.files.includes("server.json"));
});

test("MCP public docs exist in the cleaned docs tree", async () => {
  for (const relativePath of [
    "docs/getting-started/mcp.md",
    "docs/reference/mcp-tools.md",
    "docs/reference/mcp-compatibility.md",
    "packages/mcp/README.md",
  ]) {
    await access(path.join(ROOT_DIR, relativePath));
  }
});

test("MCP docs stay aligned with the actual tool, resource, and prompt surface", async () => {
  const [serverSource, packageReadme, mcpSetup, toolReference, compatibilityDoc, resourcesSource, promptsSource] =
    await Promise.all([
      readRepoFile(path.join("packages", "mcp", "src", "server.ts")),
      readRepoFile(path.join("packages", "mcp", "README.md")),
      readRepoFile(path.join("docs", "getting-started", "mcp.md")),
      readRepoFile(path.join("docs", "reference", "mcp-tools.md")),
      readRepoFile(path.join("docs", "reference", "mcp-compatibility.md")),
      readRepoFile(path.join("packages", "mcp", "src", "resources.ts")),
      readRepoFile(path.join("packages", "mcp", "src", "prompts.ts")),
    ]);

  const toolNames = extractMartinToolNames(serverSource);
  assert.deepEqual(toolNames, EXPECTED_TOOLS);

  for (const snippet of [
    "codex mcp add martin-loop -- npx -y @martinloop/mcp",
    "claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp",
    "claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp",
    "npx martin-loop mcp print-config --host codex --transport stdio --profile starter",
    "npx martin-loop mcp print-config --host claude --transport stdio --profile full",
  ]) {
    assert.match(`${packageReadme}\n${mcpSetup}`, new RegExp(escapeRegex(snippet)));
  }

  for (const toolName of EXPECTED_TOOLS) {
    assert.match(packageReadme, new RegExp(escapeRegex(toolName)));
    assert.match(toolReference, new RegExp(escapeRegex(toolName)));
  }

  for (const resourceUri of EXPECTED_RESOURCES) {
    assert.match(resourcesSource, new RegExp(escapeRegex(resourceUri)));
    assert.match(packageReadme, new RegExp(escapeRegex(resourceUri)));
    assert.match(toolReference, new RegExp(escapeRegex(resourceUri)));
  }

  for (const promptName of EXPECTED_PROMPTS) {
    assert.match(promptsSource, new RegExp(escapeRegex(promptName)));
    assert.match(packageReadme, new RegExp(escapeRegex(promptName)));
    assert.match(toolReference, new RegExp(escapeRegex(promptName)));
  }

  assert.match(packageReadme, /martin_run` is the only execution entrypoint/i);
  assert.match(toolReference, /All other tools are read-only/i);
  assert.match(compatibilityDoc, /io\.github\.Keesan12\/martin-loop/);
});

test("MCP public docs avoid deleted release-workspace language", async () => {
  const docs = await Promise.all([
    readRepoFile(path.join("packages", "mcp", "README.md")),
    readRepoFile(path.join("docs", "getting-started", "mcp.md")),
    readRepoFile(path.join("docs", "reference", "mcp-tools.md")),
    readRepoFile(path.join("docs", "reference", "mcp-compatibility.md")),
    readRepoFile(path.join("docs", "release", `v${rootPackageJson.version}.md`)),
  ]);

  for (const contents of docs) {
    for (const pattern of FORBIDDEN_DOC_PATTERNS) {
      assert.doesNotMatch(contents, pattern);
    }
  }
});
