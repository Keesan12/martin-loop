import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "../../packages/mcp/package.json" with { type: "json" };
import serverJson from "../../packages/mcp/server.json" with { type: "json" };

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
  "martin_run_dossier"
];

const EXPECTED_RESOURCES = [
  "martin://server/health",
  "martin://runs/recent",
  "martin://runs/triage",
  "martin://guides/mcp-usage",
  "martin://guides/publish-readiness"
];

const EXPECTED_PROMPTS = [
  "martin_governed_coding_kickoff",
  "martin_debug_failed_run",
  "martin_publish_readiness_review",
  "martin_triage_run_store"
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

function assertOrderedSubstrings(contents, expectedOrder) {
  let previousIndex = -1;

  for (const value of expectedOrder) {
    const index = contents.indexOf(value);
    assert.notEqual(index, -1, `Expected to find "${value}" in document`);
    assert.ok(index > previousIndex, `Expected "${value}" to appear after the prior cockpit step`);
    previousIndex = index;
  }
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

test("current MCP release packet exists for the package version and records proof gates", async () => {
  const releasePacketPath = path.join(
    ROOT_DIR,
    "docs",
    "release",
    `MCP-${packageJson.version}-RELEASE-PACKET.md`
  );

  await access(releasePacketPath);

  const releasePacket = await readFile(releasePacketPath, "utf8");

  for (const requiredPhrase of [
    "Commands Run",
    "Versions Tested",
    "Host Matrix Receipts",
    "Mirror Parity Receipts",
    "Known Non-Goals",
    "Publish Gates Still Pending Explicit Approval",
    "Ready-To-Push Rule"
  ]) {
    assert.match(releasePacket, new RegExp(escapeRegex(requiredPhrase)));
  }

  for (const requiredCommand of [
    "pnpm --filter @martinloop/mcp lint",
    "pnpm --filter @martinloop/mcp test",
    "pnpm --filter @martinloop/mcp build",
    "pnpm --filter @martinloop/mcp smoke:pack",
    "pnpm --filter @martinloop/mcp smoke:published:pack",
    "pnpm --filter @martinloop/mcp verify:release"
  ]) {
    assert.match(releasePacket, new RegExp(escapeRegex(requiredCommand)));
  }

  assert.match(releasePacket, new RegExp(escapeRegex(`@martinloop/mcp@${packageJson.version}`)));
  assert.match(releasePacket, /0\.1\.4/);
  assert.match(releasePacket, /0\.2\.0/);
  assert.match(releasePacket, /0\.2\.5/);
});

test("MCP docs stay aligned with the actual cockpit surface", async () => {
  const [serverSource, readme, aiGuide, quickstart, ossReadme, rootReadme, resourcesSource, promptsSource] = await Promise.all([
    readRepoFile(path.join("packages", "mcp", "src", "server.ts")),
    readRepoFile(path.join("packages", "mcp", "README.md")),
    readRepoFile(path.join("docs", "oss", "MCP-FOR-AI-AGENTS.md")),
    readRepoFile(path.join("docs", "oss", "QUICKSTART.md")),
    readRepoFile(path.join("docs", "oss", "README.md")),
    readRepoFile("README.md"),
    readRepoFile(path.join("packages", "mcp", "src", "resources.ts")),
    readRepoFile(path.join("packages", "mcp", "src", "prompts.ts"))
  ]);

  const codexSnippet = "codex mcp add martin-loop -- npx -y @martinloop/mcp";
  const claudeUnixSnippet =
    "claude mcp add --transport stdio --scope user martin-loop -- npx -y @martinloop/mcp";
  const claudeWindowsSnippet =
    "claude mcp add --transport stdio --scope user martin-loop -- cmd /c npx -y @martinloop/mcp";
  const toolNames = extractMartinToolNames(serverSource);

  assert.deepEqual(toolNames, EXPECTED_TOOLS);
  assert.match(serverSource, /capabilities:\s*\{\s*tools:\s*\{\s*\},\s*resources:\s*\{\s*\},\s*prompts:\s*\{\s*\}\s*\}/);
  assert.match(serverSource, /ListResourcesRequestSchema/);
  assert.match(serverSource, /ListResourceTemplatesRequestSchema/);
  assert.match(serverSource, /ReadResourceRequestSchema/);
  assert.match(serverSource, /ListPromptsRequestSchema/);
  assert.match(serverSource, /GetPromptRequestSchema/);

  for (const contents of [readme, aiGuide, quickstart]) {
    assert.match(contents, new RegExp(escapeRegex(codexSnippet)));
    assert.match(contents, new RegExp(escapeRegex(claudeUnixSnippet)));
    assert.match(contents, new RegExp(escapeRegex(claudeWindowsSnippet)));

    for (const toolName of EXPECTED_TOOLS) {
      assert.match(contents, new RegExp(escapeRegex(toolName)));
    }

    for (const resourceUri of EXPECTED_RESOURCES) {
      assert.match(contents, new RegExp(escapeRegex(resourceUri)));
    }

    for (const promptName of EXPECTED_PROMPTS) {
      assert.match(contents, new RegExp(escapeRegex(promptName)));
    }
  }

  for (const resourceUri of EXPECTED_RESOURCES) {
    assert.match(resourcesSource, new RegExp(escapeRegex(resourceUri)));
  }

  for (const promptName of EXPECTED_PROMPTS) {
    assert.match(promptsSource, new RegExp(escapeRegex(promptName)));
  }

  assertOrderedSubstrings(readme, [
    "martin_doctor",
    "martin_preflight",
    "martin_run",
    "martin_run_dossier"
  ]);
  assertOrderedSubstrings(aiGuide, [
    "martin_doctor",
    "martin_preflight",
    "martin_run",
    "martin_run_dossier"
  ]);
  assertOrderedSubstrings(quickstart, [
    "martin_doctor",
    "martin_preflight",
    "martin_run",
    "martin_run_dossier"
  ]);
  assert.match(readme, new RegExp(escapeRegex(`docs/release/MCP-${packageJson.version}-RELEASE-NOTES.md`)));
  assert.match(readme, /io\.github\.Keesan12\/martin-loop/);
  assert.match(ossReadme, /mcp:published:smoke:pack/);
  assert.match(ossReadme, /post-publish npm gate/i);
  assert.match(rootReadme, /smoke:published:pack/);
  assert.match(rootReadme, /verify:release/);
  assert.match(rootReadme, /io\.github\.Keesan12\/martin-loop/);
});

test("MCP release docs preserve publish gates and current cockpit claims", async () => {
  const [publishingDoc, releaseNotes, compatibilityDoc, checklistDoc, versionLedger, releasePacket, deliveryMap] = await Promise.all([
    readRepoFile(path.join("docs", "release", "MCP-PUBLISHING.md")),
    readRepoFile(path.join("docs", "release", `MCP-${packageJson.version}-RELEASE-NOTES.md`)),
    readRepoFile(path.join("docs", "release", "MCP-COMPATIBILITY.md")),
    readRepoFile(path.join("docs", "release", "MCP-RELEASE-CHECKLIST.md")),
    readRepoFile(path.join("docs", "release", "VERSION-LEDGER.md")),
    readRepoFile(path.join("docs", "release", `MCP-${packageJson.version}-RELEASE-PACKET.md`)),
    readRepoFile(path.join("docs", "release", "MCP-DELIVERY-SLICE-MAP.md"))
  ]);

  assert.match(publishingDoc, /smoke:published:pack/);
  assert.match(publishingDoc, /smoke:published/);
  assert.match(publishingDoc, /separate gates/i);
  assert.match(publishingDoc, /tools, resources, resource templates, and prompts/i);
  assert.match(publishingDoc, /run-triage surface/i);
  assert.match(publishingDoc, /martin_run_dossier/);
  assert.match(publishingDoc, /martin_triage_runs/);
  assert.match(publishingDoc, /io\.github\.Keesan12\/martin-loop/);

  assert.match(releaseNotes, new RegExp(`@martinloop/mcp v${packageJson.version.replaceAll(".", "\\.")}`));
  assert.match(releaseNotes, /martin_list_runs/);
  assert.match(releaseNotes, /martin_triage_runs/);
  assert.match(releaseNotes, /martin_run_dossier/);
  assert.match(releaseNotes, /resources/i);
  assert.match(releaseNotes, /prompts/i);
  assert.match(releaseNotes, /run triage/i);

  assert.match(compatibilityDoc, /martin_run remains the only execution entrypoint/i);
  assert.match(compatibilityDoc, /resources, resource templates, and prompts are additive/i);
  assert.match(checklistDoc, /MCP-X\.Y\.Z-RELEASE-PACKET\.md/);
  assert.match(checklistDoc, /Candidate Branch Proof/i);
  assert.match(checklistDoc, /packages\/mcp/);
  assert.match(checklistDoc, /oss-core/i);
  assert.match(versionLedger, /@martinloop\/mcp/);
  assert.match(versionLedger, /0\.1\.3/);
  assert.match(versionLedger, /0\.2\.5/);
  assert.match(releasePacket, /candidate branch CI is green on Windows, Linux, and macOS/i);
  assert.match(deliveryMap, /0\.1\.4/);
  assert.match(deliveryMap, /0\.2\.0/);
  assert.match(deliveryMap, /0\.2\.5/);
  assert.match(deliveryMap, /enterprise\/apps\/control-plane/);
  assert.match(deliveryMap, /martin_run` remains the only write-capable entrypoint/i);

  for (const contents of [publishingDoc, compatibilityDoc, releaseNotes]) {
    assert.doesNotMatch(contents, /0\.3\.0/);
  }
});
