import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import rootPackageJson from "../../package.json" with { type: "json" };
import packageJson from "../../packages/mcp/package.json" with { type: "json" };
import serverJson from "../../packages/mcp/server.json" with { type: "json" };

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const EXPECTED_TOOLS = [
  "martin_run",
  "martin_inspect",
  "martin_status",
  "martin_doctor",
  "martin_plan",
  "martin_preflight",
  "martin_logs",
  "martin_pause",
  "martin_cancel",
  "martin_continue",
  "martin_list_runs",
  "martin_triage_runs",
  "martin_get_run",
  "martin_get_attempt",
  "martin_get_verification_results",
  "martin_run_dossier",
  "martin_dossier",
  "martin_eval",
  "martin_pr_summary",
  "martin_create_pr",
  "martin_review_pr",
];

const EXPECTED_RESOURCES = [
  "martin://server/health",
  "martin://runs/recent",
  "martin://runs/triage",
  "martin://runs/latest",
  "martin://runs/latest/summary",
  "martin://runs/latest/proof-card",
  "martin://runs/latest/budget-status",
  "martin://runs/latest/verifier-evidence",
  "martin://runs/latest/rollback-evidence",
  "martin://policies/current",
  "martin://repo/risk-map",
  "martin://verifiers/results",
  "martin://agent/next-step",
  "martin://guides/mcp-usage",
  "martin://guides/agent-start",
  "martin://guides/command-map",
  "martin://guides/ide-onboarding",
  "martin://guides/operating-rules",
  "martin://guides/publish-readiness",
];

const EXPECTED_RESOURCE_TEMPLATES = [
  "martin://runs/{loopId}",
  "martin://runs/{loopId}/dossier",
  "martin://runs/{loopId}/attempts/{attemptIndex}",
  "martin://runs/{loopId}/verification",
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
  "safe_bug_fix",
  "write_tests_first",
  "small_refactor",
  "security_review",
  "pr_review",
  "release_check",
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
  /\bpaid-remote\b/i,
  /principal-aware remote config/i,
  /ML_Main_Repo_Internal/,
  /ML_Core_OSS_Internal/,
  /C:\\Users\\/,
  /OneDrive/,
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
});

test("root release note exists for the current root package version", async () => {
  await access(path.join(ROOT_DIR, "docs", "release", `OSS-${rootPackageJson.version}-RELEASE-NOTES.md`));
});

test("historical root release notes keep canonical OSS filenames for the 0.2.x line", async () => {
  for (const version of ["0.2.6", "0.2.7", "0.2.8", rootPackageJson.version]) {
    await access(path.join(ROOT_DIR, "docs", "release", `OSS-${version}-RELEASE-NOTES.md`));
  }
});

test("MCP public docs exist in the cleaned docs tree", async () => {
  for (const relativePath of [
    "docs/getting-started/mcp.md",
    "docs/reference/mcp-tools.md",
    "docs/reference/mcp-compatibility.md",
    `docs/release/MCP-${packageJson.version}-RELEASE-NOTES.md`,
    "packages/mcp/README.md",
    "packages/cli/README.md",
  ]) {
    await access(path.join(ROOT_DIR, relativePath));
  }
});

test("MCP docs stay aligned with the actual tool, resource, and prompt surface", async () => {
  const [
    serverSource,
    packageReadme,
    mcpSetup,
    toolReference,
    compatibilityDoc,
    resourcesSource,
    promptsSource,
  ] = await Promise.all([
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
    "npx -y @martinloop/mcp",
    "codex mcp add martin-loop -- npx -y @martinloop/mcp",
    "claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp",
    "claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp",
    "npx martin-loop mcp print-config --host codex --transport stdio --profile minimal",
    "npx martin-loop mcp print-config --host claude --transport stdio --profile diagnostic",
    "npx martin-loop mcp print-config --host gemini --transport stdio --profile full-local",
    "npx martin-loop mcp print-config --host generic --transport stdio --profile github-review",
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

  for (const templateUri of EXPECTED_RESOURCE_TEMPLATES) {
    assert.match(packageReadme, new RegExp(escapeRegex(templateUri)));
    assert.match(toolReference, new RegExp(escapeRegex(templateUri)));
  }

  for (const promptName of EXPECTED_PROMPTS) {
    assert.match(promptsSource, new RegExp(escapeRegex(promptName)));
    assert.match(packageReadme, new RegExp(escapeRegex(promptName)));
    assert.match(toolReference, new RegExp(escapeRegex(promptName)));
  }

  assert.match(packageReadme, /martin_run` is the primary coding execution entrypoint/i);
  assert.match(compatibilityDoc, /io\.github\.Keesan12\/martin-loop/);
  assert.match(compatibilityDoc, /The root `martin-loop` package provides the public CLI, SDK, demo workspace, and top-level release notes\./);
  assert.match(compatibilityDoc, /The standalone `@martinloop\/mcp` package stays on its own version line\./);
});

test("MCP public docs avoid deleted release-workspace language", async () => {
  const docs = await Promise.all([
    readRepoFile(path.join("packages", "mcp", "README.md")),
    readRepoFile(path.join("packages", "cli", "README.md")),
    readRepoFile(path.join("docs", "getting-started", "mcp.md")),
    readRepoFile(path.join("docs", "reference", "mcp-tools.md")),
    readRepoFile(path.join("docs", "reference", "mcp-compatibility.md")),
    readRepoFile(path.join("docs", "release", `MCP-${packageJson.version}-RELEASE-NOTES.md`)),
    readRepoFile(path.join("docs", "release", `OSS-${rootPackageJson.version}-RELEASE-NOTES.md`)),
  ]);

  for (const contents of docs) {
    for (const pattern of FORBIDDEN_DOC_PATTERNS) {
      assert.doesNotMatch(contents, pattern);
    }
  }
});

test("CLI package readme links stay inside the cleaned docs tree", async () => {
  const cliReadme = await readRepoFile(path.join("packages", "cli", "README.md"));

  assert.doesNotMatch(cliReadme, /docs\/oss/i);
  for (const linkTarget of [
    "../../docs/getting-started/quickstart.md",
    "../../docs/reference/cli.md",
    "../../docs/reference/config.md",
    "../../docs/getting-started/mcp.md",
  ]) {
    assert.match(cliReadme, new RegExp(escapeRegex(linkTarget)));
  }
});

test("root release note captures onboarding and governance changes", async () => {
  const releaseNotes = await readRepoFile(path.join("docs", "release", `OSS-${rootPackageJson.version}-RELEASE-NOTES.md`));

  assert.match(releaseNotes, /martin-loop start/);
  assert.match(releaseNotes, /martin-loop tour/);
  assert.match(releaseNotes, /doctor/i);
  assert.match(releaseNotes, /session-start/i);
  assert.match(releaseNotes, /preflight/i);
  assert.match(releaseNotes, /--unsafe-allow-unguarded-run/);
  assert.match(releaseNotes, /vendored internal CLI bin surface/i);
  assert.match(releaseNotes, /root-release-guard/i);
});

test("MCP release note matches the current package line and the governed flow", async () => {
  const releaseNotes = await readRepoFile(path.join("docs", "release", `MCP-${packageJson.version}-RELEASE-NOTES.md`));

  assert.match(releaseNotes, new RegExp(`@martinloop/mcp ${packageJson.version.replaceAll(".", "\\.")}`));
  assert.match(releaseNotes, /martin_run/i);
  assert.match(releaseNotes, /martin_doctor/i);
  assert.match(releaseNotes, /martin_plan/i);
  assert.match(releaseNotes, /martin_preflight/i);
  assert.match(releaseNotes, /local-first/i);
  assert.match(releaseNotes, /stdio-first/i);
});
