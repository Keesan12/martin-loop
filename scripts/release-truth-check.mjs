#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  contentDigest,
  reconcileDivergences,
  validateDivergenceManifest,
} from "./lib/release-truth-divergence.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestFlag = process.argv.find((arg) => arg.startsWith("--allow-divergence-manifest="));
const manifestPath = manifestFlag
  ? resolve(repoRoot, manifestFlag.slice("--allow-divergence-manifest=".length))
  : undefined;
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
  if (publicFile.ok && contentDigest(publicFile.text) !== contentDigest(local.text)) {
    divergences.push({
      lane: "public",
      relativePath,
      localSha: contentDigest(local.text),
      remoteSha: contentDigest(publicFile.text)
    });
  }

  const mirrorFile = safeReadMirror(relativePath);
  if (mirrorFile.ok && contentDigest(mirrorFile.text) !== contentDigest(local.text)) {
    divergences.push({
      lane: "embedded_mirror",
      relativePath,
      localSha: contentDigest(local.text),
      remoteSha: contentDigest(mirrorFile.text)
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
for (const host of ["cursor", "vscode", "copilot", "continue"]) {
  assertInvariant(
    `host coverage includes ${host}`,
    new RegExp(`(?:^|\\s|\\|)"${host}"(?:\\s|\\||;)`, "u"),
    "packages/cli/src/mcp-config.ts"
  );
}
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

const approvals = readDivergenceApprovals(manifestPath);
const convergedLanes = gitRefMatchesHead("public/main") ? ["public"] : [];
const reconciliation = reconcileDivergences({ divergences, approvals, convergedLanes });

if (reconciliation.staleApprovals.length > 0) {
  console.error("release-truth-check: divergence manifest contains stale or mismatched approvals.");
  printRows(reconciliation.staleApprovals);
  process.exit(1);
}

if (reconciliation.unapproved.length === 0) {
  if (reconciliation.approved.length > 0) {
    console.warn("release-truth-check: exact reviewed divergences accepted.");
    printRows(reconciliation.approved);
  } else {
    console.log("release-truth-check: ok (critical MCP/CLI surfaces are in parity).");
  }
  process.exit(0);
}

console.error("release-truth-check: divergence detected across critical MCP/CLI files.");
printRows(reconciliation.unapproved);
console.error("Provide an exact hash-bound divergence manifest only after reviewing each listed path.");
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

function gitRefMatchesHead(ref) {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD^{commit}"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const candidate = execFileSync("git", ["rev-parse", `${ref}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return head.length > 0 && head === candidate;
  } catch {
    return false;
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

function readDivergenceApprovals(filePath) {
  if (!filePath) {
    return [];
  }
  try {
    return validateDivergenceManifest(JSON.parse(readFileSync(filePath, "utf8")));
  } catch (error) {
    fail(`Invalid divergence manifest ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function printRows(rows) {
  for (const row of rows) {
    console.error(
      `  - ${row.lane}:${row.relativePath} local=${row.localSha.slice(0, 12)} remote=${row.remoteSha.slice(0, 12)}`
    );
  }
}

function fail(message) {
  console.error(`release-truth-check: ${message}`);
  process.exit(1);
}
