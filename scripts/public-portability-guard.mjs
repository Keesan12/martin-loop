#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_REPOSITORY_SLUG = "keesan12/martin-loop";
const INTERNAL_REPOSITORY_PATTERN = /\b[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*_Internal\b/iu;

const TEXT_FILE_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".yml",
  ".yaml",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".sh",
  ".ps1",
  ".cmd",
  ".xml",
]);

const PORTABILITY_RULES = [
  { label: "windows user profile path", pattern: /[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)/i },
  { label: "macOS user profile path", pattern: /\/Users\/[A-Za-z0-9._-]+\//i },
  { label: "OneDrive machine path", pattern: /\bOneDrive\b/i },
  { label: "Codex attachment path", pattern: /\.codex[\\/]+attachments/i },
  { label: "internal repository name", pattern: INTERNAL_REPOSITORY_PATTERN },
  { label: "internal machine workspace path", pattern: /\b[A-Za-z0-9-]+_MAIN_FULL_REPO\b/i },
  {
    label: "representative API credential",
    pattern: /(?:sk-proj-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{36})/i,
  },
];

const PATH_ALLOWLIST = [
  /^scripts\/public-copy-scan\.mjs$/,
  /^scripts\/public-git-surface-guard\.mjs$/,
  /^scripts\/public-portability-guard\.mjs$/,
  // INTERNAL ONLY — promotion tooling; intentionally checks internal repo name as a validation constraint
  /^scripts\/verify-public-promotion\.mjs$/,
  // INTERNAL ONLY — exact-SHA paid qualification launcher; never promoted
  /^scripts\/run-swarm-live-qualification\.ts$/,
  /^scripts\/tests\//,
  /(^|\/)tests\//,
  /\.test\.[cm]?[jt]sx?$/i,
  /^benchmarks\/fixtures\//,
  // INTERNAL ONLY — these root files are never promoted to the public repo
  /^CTO_AUDIT\.md$/,
  /^NEXT_STEP\.md$/,
  /^CLAUDE\.md$/,
  // INTERNAL ONLY — Claude Code operating config, never promoted
  /^\.claude\//,
  // Non-public docs subdirectory — excluded from public projection
  /^docs\/internal\//,
];

export function normalizeRelativePath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function shouldScanPath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!isTextPath(normalized)) {
    return false;
  }

  return !PATH_ALLOWLIST.some((rule) => rule.test(normalized));
}

function isTextPath(relativePath) {
  if (!relativePath) return false;
  const extension = path.extname(relativePath).toLowerCase();
  return TEXT_FILE_EXTENSIONS.has(extension) || relativePath.endsWith("Dockerfile");
}

function githubRepositorySlug(remoteUrl) {
  const normalized = remoteUrl.trim().replaceAll("\\", "/");
  const scpLike = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/iu.exec(normalized);
  if (scpLike) return scpLike[1].toLowerCase();
  try {
    const parsed = new URL(normalized);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    return parsed.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/iu, "").toLowerCase();
  } catch {
    return null;
  }
}

function isPublicDistributionRepository(rootDir) {
  try {
    const remoteUrl = execFileSync("git", ["-C", rootDir, "config", "--get", "remote.origin.url"], { encoding: "utf8" });
    return githubRepositorySlug(remoteUrl) === PUBLIC_REPOSITORY_SLUG;
  } catch {
    return false;
  }
}

export function findPortabilityViolations(contents, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const normalizedContents = normalizeContents(contents, normalized);

  return PORTABILITY_RULES
    .filter((rule) => rule.pattern.test(normalizedContents))
    .map((rule) => ({
      path: normalized,
      rule: rule.label,
    }));
}

function normalizeContents(contents, relativePath) {
  if (relativePath.endsWith(".json")) {
    try {
      const parsed = JSON.parse(contents);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return contents;
    }
  }

  if (/\.(md|markdown|ya?ml)$/iu.test(relativePath)) {
    return contents.replace(/```[\s\S]*?```/gu, "\n");
  }

  return contents;
}

export function collectTrackedFiles(rootDir = ROOT_DIR) {
  const stdout = execFileSync("git", ["-C", rootDir, "ls-files", "-z"], { encoding: "utf8" });
  return stdout
    .split("\0")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => normalizeRelativePath(value))
    .sort();
}

export async function runPublicPortabilityGuard(options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const trackedFiles = options.files ?? collectTrackedFiles(rootDir);
  const scannedFiles = trackedFiles.filter((file) => shouldScanPath(file));
  const identityFiles = isPublicDistributionRepository(rootDir)
    ? trackedFiles.filter((file) => isTextPath(normalizeRelativePath(file)))
    : [];
  const scannedFileSet = new Set(scannedFiles);
  const identityFileSet = new Set(identityFiles);
  const filesToRead = [...new Set([...scannedFiles, ...identityFiles])].sort();
  const violations = [];

  for (const relativePath of filesToRead) {
    const fullPath = path.join(rootDir, relativePath);
    const contents = await readFile(fullPath, "utf8");
    if (scannedFileSet.has(relativePath)) {
      violations.push(...findPortabilityViolations(contents, relativePath));
    }
    if (identityFileSet.has(relativePath) && INTERNAL_REPOSITORY_PATTERN.test(contents)) {
      violations.push({ path: relativePath, rule: "private development repository identity" });
    }
  }

  if (violations.length > 0) {
    const details = violations.map((entry) => `- ${entry.path}: ${entry.rule}`).join("\n");
    throw new Error(`Public portability guard failed:\n${details}`);
  }

  return {
    checkedFiles: scannedFiles.length,
    trackedFiles: trackedFiles.length,
    rootDir,
  };
}

async function main() {
  const result = await runPublicPortabilityGuard();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === path.resolve(modulePath)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
