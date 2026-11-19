// SPDX-License-Identifier: Apache-2.0
// Scan only source/test additions that belong to the manifest-bound public surface.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { validatePublicSurfaceEntries } from "./lib/public-release-surface.mjs";

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|jsonl?|ya?ml|sh|ps1|py|go|rs)$/iu;
export const SOURCE_DISCLOSURE_RULES = Object.freeze([
  { label: "private audit language", pattern: /\bblind\s+(?:design[ .-]?partner\s+)?audit\b/iu },
  { label: "private repository name", pattern: /\bML_(?:Core_OSS|Main_Repo)_Internal\b/iu },
  {
    label: `operator ${["One", "Drive"].join("")} path`,
    pattern: new RegExp(`\\b${["One", "Drive"].join("")}[\\\\/]`, "iu"),
  },
  { label: "internal attachment path", pattern: /\.codex[\\/]+attachments[\\/]/iu },
]);

function git(rootDir, args, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function comparePath(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function scanLine(relativePath, lineNumber, contents, violations) {
  for (const rule of SOURCE_DISCLOSURE_RULES) {
    if (rule.pattern.test(contents)) {
      violations.push({ relativePath, lineNumber, rule: rule.label });
    }
  }
}

export function scanSourceDiff(diff, expectedPath) {
  const violations = [];
  let lineNumber = 0;
  let insideHunk = false;

  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("@@ ")) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)/u.exec(line);
      if (!match) throw new Error(`Promotion source-copy scan received a malformed hunk for ${expectedPath}`);
      lineNumber = Number(match[1]);
      insideHunk = true;
      continue;
    }
    if (!insideHunk) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      scanLine(expectedPath, lineNumber, line.slice(1), violations);
      lineNumber += 1;
    } else if (line.startsWith(" ")) {
      lineNumber += 1;
    }
  }

  return violations;
}

function scanWholeFile(contents, relativePath) {
  const violations = [];
  for (const [index, line] of contents.split(/\r?\n/u).entries()) {
    scanLine(relativePath, index + 1, line, violations);
  }
  return { additions: contents.split(/\r?\n/u).length, violations };
}

function readManifest(rootDir, required) {
  const manifestPath = path.join(rootDir, ".martin", "promotion-manifest.json");
  if (!existsSync(manifestPath)) {
    if (required) throw new Error("Promotion manifest is required for the promoted source-copy scan");
    return null;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error("Promotion manifest is invalid JSON");
  }
  if (typeof manifest.publicBaseSha !== "string" || !/^[a-f0-9]{40}$/iu.test(manifest.publicBaseSha)) {
    throw new Error("Promotion manifest publicBaseSha must be a full Git commit SHA");
  }
  validatePublicSurfaceEntries(manifest.publicSurfaceEntries);
  return manifest;
}

export function scanPromotedSourceChanges(rootDir, options = {}) {
  const manifest = options.manifest ?? readManifest(rootDir, options.required === true);
  if (manifest === null) {
    return { checkedSourceFiles: 0, checkedSourceAdditions: 0, sourceScanApplied: false };
  }
  if (options.manifest !== undefined) {
    if (typeof manifest.publicBaseSha !== "string" || !/^[a-f0-9]{40}$/iu.test(manifest.publicBaseSha)) {
      throw new Error("Promotion manifest publicBaseSha must be a full Git commit SHA");
    }
    validatePublicSurfaceEntries(manifest.publicSurfaceEntries);
  }

  const runGit = options.gitRunner ?? git;
  const base = manifest.publicBaseSha.toLowerCase();
  runGit(rootDir, ["cat-file", "-e", `${base}^{commit}`]);
  runGit(rootDir, ["merge-base", "--is-ancestor", base, "HEAD"]);

  const basePaths = new Set(
    runGit(rootDir, ["ls-tree", "-r", "--name-only", "-z", base], null)
      .toString("utf8")
      .split("\0")
      .filter(Boolean),
  );
  const changedPaths = new Set(
    runGit(rootDir, ["diff", "--name-only", "-z", base, "HEAD", "--"], null)
      .toString("utf8")
      .split("\0")
      .filter(Boolean),
  );
  const publicPaths = manifest.publicSurfaceEntries
    .map((entry) => entry.path)
    .filter((entryPath) => SOURCE_EXTENSION.test(entryPath))
    .sort(comparePath);

  const violations = [];
  let checkedSourceFiles = 0;
  let checkedSourceAdditions = 0;
  for (const relativePath of publicPaths) {
    if (!basePaths.has(relativePath)) {
      const contents = runGit(rootDir, ["show", `HEAD:${relativePath}`]);
      const result = scanWholeFile(contents, relativePath);
      checkedSourceFiles += 1;
      checkedSourceAdditions += result.additions;
      violations.push(...result.violations);
      continue;
    }
    if (!changedPaths.has(relativePath)) continue;
    const diff = runGit(rootDir, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--text",
      "--unified=0",
      "--no-color",
      base,
      "HEAD",
      "--",
      relativePath,
    ]);
    const additions = diff.split(/\r?\n/u).filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    checkedSourceFiles += 1;
    checkedSourceAdditions += additions;
    violations.push(...scanSourceDiff(diff, relativePath));
  }

  if (violations.length > 0) {
    const details = violations
      .map((violation) => `- ${violation.relativePath}:${violation.lineNumber}: ${violation.rule}`)
      .join("\n");
    throw new Error(`Promoted source/test copy contains private-process disclosure:\n${details}`);
  }

  return { checkedSourceFiles, checkedSourceAdditions, sourceScanApplied: true };
}
