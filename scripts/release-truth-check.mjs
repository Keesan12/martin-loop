#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "../package.json" with { type: "json" };
import mcpPackageJson from "../packages/mcp/package.json" with { type: "json" };
import serverJson from "../packages/mcp/server.json" with { type: "json" };
import mcpbManifest from "../packages/mcp/mcpb/manifest.json" with { type: "json" };

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const markerFlag = process.argv.find((arg) => arg.startsWith("--allow-divergence-marker="));
const allowedMarker = markerFlag ? markerFlag.slice("--allow-divergence-marker=".length) : undefined;
const shouldWrite = process.argv.includes("--write");
const mirrorRoot = resolveMirrorRoot();
const releaseTruthPath = join(repoRoot, "distribution", "release-truth.json");
const releaseTruth = buildReleaseTruth();
const releaseTruthJson = `${JSON.stringify(releaseTruth, null, 2)}\n`;

const CRITICAL_FILES = [
  "packages/mcp/src/tools/tool-support.ts",
  "packages/mcp/src/server-validation.ts",
  "packages/mcp/src/server.ts",
  "packages/cli/src/mcp-config.ts",
  "packages/cli/src/index.ts"
];

const divergences = [];
for (const relativePath of CRITICAL_FILES) {
  const local = safeReadLocal(relativePath);
  if (!local.ok) {
    fail(`Missing critical file in local source: ${relativePath}`);
  }

  const publicFile = safeReadGitRef("public/main", relativePath);
  if (publicFile.ok && publicFile.text !== local.text) {
    divergences.push({
      lane: "public",
      relativePath,
      localSha: sha(local.text),
      remoteSha: sha(publicFile.text)
    });
  }

  const mirrorFile = safeReadMirror(relativePath);
  if (mirrorFile.ok && mirrorFile.text !== local.text) {
    divergences.push({
      lane: "embedded_mirror",
      relativePath,
      localSha: sha(local.text),
      remoteSha: sha(mirrorFile.text)
    });
  }
}

assertInvariant(
  "engine union",
  /MARTIN_ENGINE_VALUES\s*=\s*\["claude",\s*"codex",\s*"gemini",\s*"openai"\]/u,
  "packages/mcp/src/tools/tool-support.ts"
);
assertInvariant(
  "schema/validator engine source",
  /MARTIN_ENGINE_VALUES/u,
  "packages/mcp/src/server-validation.ts"
);
assertInvariant(
  "server schema engine source",
  /MARTIN_ENGINE_VALUES/u,
  "packages/mcp/src/server.ts"
);
assertInvariant(
  "canonical host matrix includes every supported MCP host",
  /MARTIN_MCP_HOSTS\s*=\s*\[\s*"codex",\s*"claude",\s*"gemini",\s*"cursor",\s*"vscode",\s*"copilot",\s*"continue",\s*"generic"\s*\]\s*as const/u,
  "packages/cli/src/mcp-config.ts"
);
assertInvariant(
  "experimental remote host policy helper",
  /hostRequiresExperimentalRemoteOptIn/u,
  "packages/cli/src/mcp-config.ts"
);
assertInvariant(
  "CLI remote host opt-in flag",
  /--experimental-remote-hosts/u,
  "packages/cli/src/index.ts"
);
assertVersionParity();
assertReleaseTruthFile();
assertReleaseTruthDocumentation();

if (divergences.length === 0) {
  console.log("release-truth-check: ok (critical MCP/CLI surfaces are in parity).");
  process.exit(0);
}

if (allowedMarker && latestCommitMessage().includes(allowedMarker)) {
  console.warn("release-truth-check: divergence accepted by explicit sync marker.");
  for (const row of divergences) {
    console.warn(
      `  - ${row.lane}:${row.relativePath} local=${row.localSha.slice(0, 12)} remote=${row.remoteSha.slice(0, 12)}`
    );
  }
  process.exit(0);
}

console.error("release-truth-check: divergence detected across critical MCP/CLI files.");
for (const row of divergences) {
  console.error(
    `  - ${row.lane}:${row.relativePath} local=${row.localSha.slice(0, 12)} remote=${row.remoteSha.slice(0, 12)}`
  );
}
if (allowedMarker) {
  console.error(`Add sync marker '${allowedMarker}' in the commit message to acknowledge intentional drift.`);
}
process.exit(1);

function assertInvariant(name, pattern, relativePath) {
  const result = safeReadLocal(relativePath);
  if (!result.ok) {
    fail(`Invariant '${name}' failed because ${relativePath} could not be read.`);
  }
  if (!pattern.test(result.text)) {
    fail(`Invariant '${name}' failed in ${relativePath}.`);
  }
}

function assertVersionParity() {
  if (mcpPackageJson.version !== serverJson.version) {
    fail(`packages/mcp/package.json (${mcpPackageJson.version}) does not match packages/mcp/server.json (${serverJson.version}).`);
  }

  const npmPackageVersion = serverJson.packages?.[0]?.version;
  if (mcpPackageJson.version !== npmPackageVersion) {
    fail(`packages/mcp/package.json (${mcpPackageJson.version}) does not match packages/mcp/server.json npm package version (${npmPackageVersion}).`);
  }

  if (mcpPackageJson.version !== mcpbManifest.version) {
    fail(`packages/mcp/package.json (${mcpPackageJson.version}) does not match packages/mcp/mcpb/manifest.json (${mcpbManifest.version}).`);
  }
}

function assertReleaseTruthFile() {
  if (shouldWrite) {
    mkdirSync(dirname(releaseTruthPath), { recursive: true });
    writeFileSync(releaseTruthPath, releaseTruthJson, "utf8");
    console.log("release-truth-check: wrote distribution/release-truth.json");
    return;
  }

  const current = safeReadLocal("distribution/release-truth.json");
  if (!current.ok) {
    fail("Missing generated release-truth artifact: distribution/release-truth.json. Run `node ./scripts/release-truth-check.mjs --write`.");
  }

  if (current.text !== releaseTruthJson) {
    fail("distribution/release-truth.json is stale. Run `node ./scripts/release-truth-check.mjs --write` and commit the updated artifact.");
  }
}

function assertReleaseTruthDocumentation() {
  const versionLedger = safeReadLocal("docs/release/VERSION-LEDGER.md");
  const readme = safeReadLocal("README.md");
  const cliReference = safeReadLocal("docs/reference/cli.md");
  const mcpGuide = safeReadLocal("docs/getting-started/mcp.md");
  const aiGuide = safeReadLocal("docs/oss/MCP-FOR-AI-AGENTS.md");

  assertMatch("version ledger root line", versionLedger, new RegExp(escapeRegex(`current in-repo root release line: \`${packageJson.version}\``)));
  assertMatch("version ledger MCP line", versionLedger, new RegExp(escapeRegex(`current in-repo standalone release line: \`${mcpPackageJson.version}\``)));
  assertMatch("version ledger live MCP baseline", versionLedger, new RegExp(escapeRegex(`live npm dist-tag \`latest\`: \`${mcpPackageJson.version}\``)));

  assertNotMatch("MCP getting-started stale current-version claim", mcpGuide, /current public MCP package line/u);
  assertNotMatch("root README stale MCP line", readme, /current standalone MCP source line is `\d+\.\d+\.\d+`/u);
  assertNotMatch("root README stale live baseline claim", readme, /live npm baseline is `\d+\.\d+\.\d+`/u);
  assertNotMatch("AI guide stale current-version claim", aiGuide, /current standalone MCP source line/u);
  assertNotMatch("AI guide stale live baseline claim", aiGuide, /live npm baseline/u);

  for (const target of [readme, cliReference]) {
    assertMatch("MCP host coverage", target, /<codex\|claude\|gemini\|cursor\|vscode\|copilot\|continue\|generic>/u);
  }

  for (const host of ["cursor", "copilot", "continue"]) {
    assertMatch(`MCP getting-started host ${host}`, mcpGuide, new RegExp(`\\b${host}\\b`, "iu"));
  }

  assertMatch("README release truth reference", readme, /distribution\/release-truth\.json/u);
  assertMatch("MCP getting-started release truth reference", mcpGuide, /distribution\/release-truth\.json/u);
  assertMatch("AI guide release truth reference", aiGuide, /distribution\/release-truth\.json/u);
}

function buildReleaseTruth() {
  return {
    schemaVersion: 1,
    cli: {
      package: packageJson.name,
      version: packageJson.version,
      install: "npx -y martin-loop@latest"
    },
    mcp: {
      package: mcpPackageJson.name,
      version: mcpPackageJson.version,
      registryName: mcpPackageJson.mcpName,
      install: "npx -y @martinloop/mcp"
    },
    mcpb: {
      built: true,
      released: true,
      releaseUrl: `https://github.com/Keesan12/martin-loop/releases/download/mcp-v${mcpPackageJson.version}/martinloop-${mcpPackageJson.version}.mcpb`,
      sha256: resolveMcpbSha256(mcpPackageJson.version)
    },
    repository: packageJson.repository?.url?.replace(/^git\+/, "").replace(/\.git$/u, "") ?? "https://github.com/Keesan12/martin-loop",
    website: String(packageJson.homepage ?? "https://martinloop.com/").replace(/\/$/u, "")
  };
}

function resolveMcpbSha256(version) {
  const publishedDigests = {
    "0.3.9": "3b656a7d6f11f6a301b7aee291ba6f5ed29ba9e7dfc2d5ae530d57d93a13d958"
  };

  return publishedDigests[version] ?? null;
}

function latestCommitMessage() {
  try {
    return execFileSync("git", ["log", "-1", "--pretty=%B"], {
      cwd: repoRoot,
      encoding: "utf8"
    }).trim();
  } catch {
    return "";
  }
}

function safeReadLocal(relativePath) {
  const filePath = join(repoRoot, relativePath);
  if (!existsSync(filePath)) {
    return { ok: false, text: "" };
  }
  return { ok: true, text: normalizeText(readFileSync(filePath, "utf8")) };
}

function safeReadMirror(relativePath) {
  if (!mirrorRoot) {
    return { ok: false, text: "" };
  }
  const filePath = join(mirrorRoot, relativePath);
  if (!existsSync(filePath)) {
    return { ok: false, text: "" };
  }
  return { ok: true, text: normalizeText(readFileSync(filePath, "utf8")) };
}

function safeReadGitRef(ref, relativePath) {
  try {
    const text = execFileSync("git", ["show", `${ref}:${relativePath}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return { ok: true, text: normalizeText(text) };
  } catch {
    return { ok: false, text: "" };
  }
}

function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}

function normalizeText(text) {
  return text.replace(/\r\n/g, "\n");
}

function escapeRegex(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertMatch(name, result, pattern) {
  if (!result.ok) {
    fail(`Missing file for '${name}'.`);
  }

  if (!pattern.test(result.text)) {
    fail(`Invariant '${name}' failed.`);
  }
}

function assertNotMatch(name, result, pattern) {
  if (!result.ok) {
    fail(`Missing file for '${name}'.`);
  }

  if (pattern.test(result.text)) {
    fail(`Invariant '${name}' failed.`);
  }
}

function resolveMirrorRoot() {
  if (process.env.MARTIN_OSS_MIRROR_PATH) {
    return resolve(process.env.MARTIN_OSS_MIRROR_PATH);
  }

  if (process.env.MARTIN_MAIN_REPO_PATH) {
    return resolve(process.env.MARTIN_MAIN_REPO_PATH, "oss-core");
  }

  return null;
}

function fail(message) {
  console.error(`release-truth-check: ${message}`);
  process.exit(1);
}
