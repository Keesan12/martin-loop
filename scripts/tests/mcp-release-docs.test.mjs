import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "../../packages/mcp/package.json" with { type: "json" };
import serverJson from "../../packages/mcp/server.json" with { type: "json" };
import rootPackageJson from "../../package.json" with { type: "json" };

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readRepoFile(relativePath) {
  return readFile(path.join(ROOT_DIR, relativePath), "utf8");
}

function escapeRegex(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("current MCP metadata stays aligned for the release cut", async () => {
  assert.equal(packageJson.version, "0.3.2");
  assert.equal(packageJson.version, serverJson.version);

  const releaseNotesPath = path.join(ROOT_DIR, "docs", "release", `MCP-${packageJson.version}-RELEASE-NOTES.md`);

  await access(releaseNotesPath);
});

test("version ledger records live public truth and the next release train", async () => {
  const ledger = await readRepoFile(path.join("docs", "release", "VERSION-LEDGER.md"));

  assert.match(ledger, /root public baseline: `\d+\.\d+\.\d+`/);
  assert.match(ledger, /live public GitHub release: `v\d+\.\d+\.\d+`/);
  assert.match(
    ledger,
    new RegExp(escapeRegex("standalone MCP public baseline: `0.3.1`"))
  );
  assert.match(
    ledger,
    new RegExp(escapeRegex(`current in-repo standalone release line: \`${packageJson.version}\``))
  );
  assert.match(
    ledger,
    new RegExp(escapeRegex(`current in-repo root release line: \`${rootPackageJson.version}\``))
  );
  assert.match(ledger, /next planned root follow-on: `\d+\.\d+\.\d+`/);
  assert.match(ledger, /next planned standalone release: `\d+\.\d+\.\d+`/);
  assert.match(ledger, /`0\.3\.4` reserved for additional host-coverage follow-ups/);
});

test("MCP slice map defines the 0.3.x train without private-hosted bleed", async () => {
  const sliceMap = await readRepoFile(path.join("docs", "release", "MCP-DELIVERY-SLICE-MAP.md"));

  for (const requiredText of [
    "## `0.3.1` — Review And Handoff Controls",
    "## `0.3.2` — Engine Validation Hotfix",
    "## `0.3.3` — Opt-In Execution Controls",
    "hosted audit export",
    "tenant or billing features",
    "non-OSS transport"
  ]) {
    assert.match(sliceMap, new RegExp(escapeRegex(requiredText)));
  }
});

test("public MCP docs describe the current baseline and the next train in human-facing language", async () => {
  const [packageReadme, aiGuide, releaseNotes031, releaseNotes032, releaseNotes033] = await Promise.all([
    readRepoFile(path.join("packages", "mcp", "README.md")),
    readRepoFile(path.join("docs", "oss", "MCP-FOR-AI-AGENTS.md")),
    readRepoFile(path.join("docs", "release", "MCP-0.3.1-RELEASE-NOTES.md")),
    readRepoFile(path.join("docs", "release", "MCP-0.3.2-RELEASE-NOTES.md")),
    readRepoFile(path.join("docs", "release", "MCP-0.3.3-RELEASE-NOTES.md"))
  ]);

  for (const contents of [packageReadme, aiGuide]) {
    assert.match(contents, /0\.3\.1/);
    assert.match(contents, /0\.3\.2/);
    assert.match(contents, /local-first/i);
    assert.match(contents, /martin_doctor/);
    assert.match(contents, /martin_plan/);
    assert.match(contents, /martin_preflight/);
    assert.match(contents, /martin_run/);
  }
  assert.match(releaseNotes031, /review and handoff release/i);
  assert.match(releaseNotes032, /validation hotfix/i);
  assert.match(releaseNotes033, /opt-in execution-controls release/i);
});

test("release packet for 0.2.7 records the public verification gates", async () => {
  const releasePacket = await readRepoFile(path.join("docs", "release", "MCP-0.2.7-RELEASE-PACKET.md"));

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
});

test("release notes for 0.3.0 describe the adoption slice in customer-facing language", async () => {
  const releaseNotes = await readRepoFile(path.join("docs", "release", "MCP-0.3.0-RELEASE-NOTES.md"));

  assert.match(releaseNotes, /0\.3\.0/);
  assert.match(releaseNotes, /adoption/i);
  assert.match(releaseNotes, /Codex|Claude Code|Gemini|Cursor|VS Code/);
  assert.doesNotMatch(releaseNotes, /tenant|billing|mission-control|control-plane/i);
});

test("public MCP docs stay free of internal workspace leakage", async () => {
  const docsToScan = await Promise.all([
    readRepoFile(path.join("packages", "mcp", "README.md")),
    readRepoFile(path.join("docs", "oss", "MCP-FOR-AI-AGENTS.md")),
    readRepoFile(path.join("docs", "release", "MCP-0.2.7-RELEASE-NOTES.md")),
    readRepoFile(path.join("docs", "release", "MCP-0.3.0-RELEASE-NOTES.md")),
    readRepoFile(path.join("docs", "release", "MCP-0.3.1-RELEASE-NOTES.md")),
    readRepoFile(path.join("docs", "release", "MCP-0.3.2-RELEASE-NOTES.md")),
    readRepoFile(path.join("docs", "release", "MCP-0.3.3-RELEASE-NOTES.md"))
  ]);

  const forbiddenPatterns = [
    /ML_Main_Repo_Internal/,
    /ML_Core_OSS_Internal/,
    /martin-Loop\/ML_/,
    /martin-loop_MAIN_FULL_REPO/,
    /C:\\Users\\/,
    /OneDrive/,
    /docs\/internal/,
    /codex\//,
    /enterprise\/apps\/control-plane/
  ];

  for (const contents of docsToScan) {
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(contents, pattern);
    }
  }
});
