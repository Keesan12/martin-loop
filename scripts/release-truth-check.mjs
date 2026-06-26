#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const markerFlag = process.argv.find((arg) => arg.startsWith("--allow-divergence-marker="));
const allowedMarker = markerFlag ? markerFlag.slice("--allow-divergence-marker=".length) : undefined;
const mirrorRoot = resolveMirrorRoot();

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
  "host coverage includes cursor/copilot/continue",
  /"cursor"\s*\|\s*"copilot"\s*\|\s*"continue"/u,
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
  return { ok: true, text: readFileSync(filePath, "utf8") };
}

function safeReadMirror(relativePath) {
  if (!mirrorRoot) {
    return { ok: false, text: "" };
  }
  const filePath = join(mirrorRoot, relativePath);
  if (!existsSync(filePath)) {
    return { ok: false, text: "" };
  }
  return { ok: true, text: readFileSync(filePath, "utf8") };
}

function safeReadGitRef(ref, relativePath) {
  try {
    const text = execFileSync("git", ["show", `${ref}:${relativePath}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return { ok: true, text };
  } catch {
    return { ok: false, text: "" };
  }
}

function sha(text) {
  return createHash("sha256").update(text).digest("hex");
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
