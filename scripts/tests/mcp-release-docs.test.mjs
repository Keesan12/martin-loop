import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "../../packages/mcp/package.json" with { type: "json" };
import serverJson from "../../packages/mcp/server.json" with { type: "json" };

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const EXPECTED_TOOLS = [
  "martin_doctor",
  "martin_preflight",
  "martin_run",
  "martin_inspect",
  "martin_status",
  "martin_list_runs",
  "martin_get_run",
  "martin_get_attempt",
  "martin_get_verification_results",
  "martin_run_dossier"
];

const EXPECTED_RESOURCES_AND_PROMPTS = [
  "martin://runs/summary",
  "martin://runs/latest",
  "martin://runs/{loopId}",
  "martin://runs/{loopId}/attempts/{attemptIndex}",
  "martin://runs/{loopId}/verification",
  "martin_review_run",
  "martin_triage_failures"
];

const FORBIDDEN_PUBLIC_RELEASE_NOTE_PATTERNS = [
  /0\.2\.5/i,
  /\bremoved\b/i,
  /\bskipped\b/i,
  /\bbranch\b/i,
  /\bprivate\b/i,
  /\bpro\b/i,
  /\bgrowth\b/i,
  /\benterprise\b/i,
  /\binternal\b/i,
  /hosted control-plane/i,
  /\bautonomy\b/i,
  /\brouter\b/i,
  /workflow contract/i,
  /contents:\s*write/i,
  /do not publish locally/i,
  /\brelease path\b/i
];

async function readRepoFile(relativePath) {
  return readFile(path.join(ROOT_DIR, relativePath), "utf8");
}

function escapeRegex(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("current MCP release note exists for the package version", async () => {
  assert.equal(packageJson.version, serverJson.version);

  const releaseNotesPath = path.join(
    ROOT_DIR,
    "docs",
    "release",
    `MCP-${packageJson.version}-RELEASE-NOTES.md`
  );

  await access(releaseNotesPath);
});

test("MCP docs stay aligned with the 0.2.0 read-only cockpit", async () => {
  const [serverSource, readme, aiGuide, quickstart, releaseNotes, publishingDoc] = await Promise.all([
    readRepoFile(path.join("packages", "mcp", "src", "server.ts")),
    readRepoFile(path.join("packages", "mcp", "README.md")),
    readRepoFile(path.join("docs", "oss", "MCP-FOR-AI-AGENTS.md")),
    readRepoFile(path.join("docs", "oss", "QUICKSTART.md")),
    readRepoFile(path.join("docs", "release", `MCP-${packageJson.version}-RELEASE-NOTES.md`)),
    readRepoFile(path.join("docs", "release", "MCP-PUBLISHING.md"))
  ]);

  const codexSnippet = "codex mcp add martin-loop -- npx -y @martinloop/mcp";
  const claudeUnixSnippet =
    "claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp";
  const claudeWindowsSnippet =
    "claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp";

  for (const toolName of EXPECTED_TOOLS) {
    assert.match(serverSource, new RegExp(`name:\\s*"${escapeRegex(toolName)}"`));
    assert.match(readme, new RegExp(escapeRegex(toolName)));
    assert.match(aiGuide, new RegExp(escapeRegex(toolName)));
    assert.match(releaseNotes, new RegExp(escapeRegex(toolName)));
  }

  for (const discoveryName of EXPECTED_RESOURCES_AND_PROMPTS) {
    assert.match(readme, new RegExp(escapeRegex(discoveryName)));
    assert.match(aiGuide, new RegExp(escapeRegex(discoveryName)));
    assert.match(releaseNotes, new RegExp(escapeRegex(discoveryName)));
  }

  for (const contents of [readme, aiGuide, quickstart]) {
    assert.match(contents, new RegExp(escapeRegex(codexSnippet)));
    assert.match(contents, new RegExp(escapeRegex(claudeUnixSnippet)));
    assert.match(contents, new RegExp(escapeRegex(claudeWindowsSnippet)));
  }

  for (const futureOnlyClaim of ["martin_triage_runs", "0.2.5 stable cockpit"]) {
    assert.doesNotMatch(readme, new RegExp(escapeRegex(futureOnlyClaim), "i"));
    assert.doesNotMatch(aiGuide, new RegExp(escapeRegex(futureOnlyClaim), "i"));
    assert.doesNotMatch(quickstart, new RegExp(escapeRegex(futureOnlyClaim), "i"));
  }

  assert.match(releaseNotes, new RegExp(`@martinloop/mcp v${packageJson.version.replaceAll(".", "\\.")}`));
  assert.match(releaseNotes, /What Changed From `0\.1\.4`/);
  assert.match(releaseNotes, /published package was verified from npm/i);
  assert.match(publishingDoc, /smoke:published:pack/);
  assert.match(publishingDoc, /verify:release/);
  assert.match(publishingDoc, /workflow_dispatch/i);
  assert.match(publishingDoc, /release notes/i);
});

test("public MCP release notes do not expose private roadmap or workflow plumbing", async () => {
  const releaseNotes = await readRepoFile(
    path.join("docs", "release", `MCP-${packageJson.version}-RELEASE-NOTES.md`)
  );

  for (const pattern of FORBIDDEN_PUBLIC_RELEASE_NOTE_PATTERNS) {
    assert.doesNotMatch(releaseNotes, pattern);
  }
});
