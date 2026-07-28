#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  { label: "internal main repo name", pattern: /\bML_Main_Repo_Internal\b/i },
  { label: "internal OSS repo name", pattern: /\bML_Core_OSS_Internal\b/i },
  { label: "internal machine workspace path", pattern: /\bmartin-loop_MAIN_FULL_REPO\b/i },
];

const PATH_ALLOWLIST = [
  /^scripts\/public-copy-scan\.mjs$/,
  /^scripts\/public-git-surface-guard\.mjs$/,
  /^scripts\/public-portability-guard\.mjs$/,
  /^scripts\/tests\//,
  /(^|\/)tests\//,
  /\.test\.[cm]?[jt]sx?$/i,
  /^benchmarks\/fixtures\//,
];

export function normalizeRelativePath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function shouldScanPath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) {
    return false;
  }

  const extension = path.extname(normalized).toLowerCase();
  if (!TEXT_FILE_EXTENSIONS.has(extension) && !normalized.endsWith("Dockerfile")) {
    return false;
  }

  return !PATH_ALLOWLIST.some((rule) => rule.test(normalized));
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
  const candidateFiles = trackedFiles.filter((file) => shouldScanPath(file));
  const scannedFiles = [];
  const violations = [];

  for (const relativePath of candidateFiles) {
    const fullPath = path.join(rootDir, relativePath);
    try {
      await stat(fullPath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    const contents = await readFile(fullPath, "utf8");
    scannedFiles.push(relativePath);
    violations.push(...findPortabilityViolations(contents, relativePath));
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
