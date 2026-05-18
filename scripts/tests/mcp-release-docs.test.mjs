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
  "martin_status"
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

test("MCP docs stay aligned with the 0.1.4 five-tool cockpit", async () => {
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

  for (const contents of [readme, aiGuide, quickstart]) {
    assert.match(contents, new RegExp(escapeRegex(codexSnippet)));
    assert.match(contents, new RegExp(escapeRegex(claudeUnixSnippet)));
    assert.match(contents, new RegExp(escapeRegex(claudeWindowsSnippet)));
  }

  for (const futureOnlyClaim of [
    "martin_list_runs",
    "martin_triage_runs",
    "martin_get_run",
    "martin_get_attempt",
    "martin_get_verification_results",
    "martin_run_dossier"
  ]) {
    assert.doesNotMatch(readme, new RegExp(escapeRegex(futureOnlyClaim), "i"));
    assert.doesNotMatch(aiGuide, new RegExp(escapeRegex(futureOnlyClaim), "i"));
    assert.doesNotMatch(quickstart, new RegExp(escapeRegex(futureOnlyClaim), "i"));
  }

  assert.match(releaseNotes, new RegExp(`@martinloop/mcp v${packageJson.version.replaceAll(".", "\\.")}`));
  assert.match(releaseNotes, /What `0\.1\.4` does not claim/);
  assert.match(releaseNotes, /smoke:published:pack/);
  assert.match(releaseNotes, /verify:release/);
  assert.match(publishingDoc, /smoke:published:pack/);
  assert.match(publishingDoc, /verify:release/);
  assert.match(publishingDoc, /workflow_dispatch/i);
  assert.match(publishingDoc, /release notes/i);
});
