#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FORBIDDEN_PUBLIC_COPY_PATTERNS = [
  /\bremediation\b/i,
  /\bstable cockpit line\b/i,
  /\brelease-proof\b/i,
  /\bpublic feature contract\b/i,
  /\bversion anomal(?:y|ies)\b/i,
  /\bhistorical anomalies\b/i,
  /\bdelivery slice\b/i,
  /\brelease packet\b/i,
  /\bhandoff packet\b/i,
  /\bworkspace chatter\b/i,
  /\bprivate roadmap\b/i,
  /\blocal machine\b/i,
  /\bKeesan explicitly\b/i,
  /\bpending directory\b/i,
  /\bdirectory submission\b/i,
  /\bintegration outreach\b/i,
  /\bpublic OSS-safe\b/i,
  /\brelease focus\b/i,
  /\broot facade\b/i,
  /\bmain workspace\b/i,
  /\bprivate beta\b/i,
  /\brc:validate\b/i,
  /\bpilot:prep\b/i,
  /\brelease:matrix\b/i,
  /\bdual-track\b/i,
  /\brelease candidate\b/i,
  /\bfrozen public\b/i,
  /\bclean public repo\b/i,
  /\bpublic(?:-| )surface cleanup\b/i,
];

export const FORBIDDEN_PUBLIC_ARTIFACT_RULES = [
  {
    label: "release handoff archive",
    test: (relativePath) =>
      relativePath.startsWith("docs/release/") &&
      (relativePath.endsWith(".zip") || /\bhandoff\b/i.test(relativePath)),
  },
  {
    label: "public html artifact",
    test: (relativePath) => relativePath.endsWith(".html"),
  },
];

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_FILES = [
  "README.md",
  "AGENTS.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "package.json",
];
const DIRECTORY_RULES = [
  { relativePath: "docs", include: (name) => name.endsWith(".md") },
  { relativePath: ".github", include: (name) => name.endsWith(".md") || name.endsWith(".yml") || name.endsWith(".yaml") },
  { relativePath: "packages", include: (name, fullPath) => name === "README.md" && fullPath.includes(`${path.sep}packages${path.sep}`) },
];

export async function collectPublicCopyFiles(rootDir = ROOT_DIR) {
  const files = [...ROOT_FILES];

  for (const rule of DIRECTORY_RULES) {
    files.push(...(await collectFiles(path.join(rootDir, rule.relativePath), rule.include, rootDir)));
  }

  return [...new Set(files)].sort();
}

async function collectFiles(startDir, include, rootDir, results = []) {
  const entries = await readdir(startDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(startDir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(fullPath, include, rootDir, results);
      continue;
    }

    if (entry.isFile() && include(entry.name, fullPath)) {
      results.push(path.relative(rootDir, fullPath).replaceAll("\\", "/"));
    }
  }

  return results;
}

export function findPublicCopyViolations(contents, relativePath) {
  return FORBIDDEN_PUBLIC_COPY_PATTERNS
    .filter((pattern) => pattern.test(contents))
    .map((pattern) => ({ relativePath, pattern }));
}

export async function runPublicCopyScan(options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const files = options.files ?? await collectPublicCopyFiles(rootDir);
  const violations = [];

  for (const relativePath of files) {
    const contents = await readFile(path.join(rootDir, relativePath), "utf8");
    violations.push(...findPublicCopyViolations(contents, relativePath));
  }

  if (violations.length > 0) {
    const details = violations
      .map((violation) => `- ${violation.relativePath} matches ${violation.pattern}`)
      .join("\n");
    throw new Error(`Public copy scan found forbidden release/process language:\n${details}`);
  }

  const publicArtifacts = await collectPublicArtifacts(rootDir);
  const artifactViolations = findForbiddenPublicArtifacts(publicArtifacts);

  if (artifactViolations.length > 0) {
    const details = artifactViolations
      .map((violation) => `- ${violation.relativePath} violates ${violation.rule}`)
      .join("\n");
    throw new Error(`Public copy scan found forbidden public artifacts:\n${details}`);
  }

  return {
    checkedFiles: files.length,
    checkedArtifacts: publicArtifacts.length,
    rootDir,
  };
}

export async function collectPublicArtifacts(rootDir = ROOT_DIR) {
  return collectFiles(path.join(rootDir, "docs"), () => true, rootDir);
}

export function findForbiddenPublicArtifacts(relativePaths) {
  const violations = [];

  for (const relativePath of relativePaths) {
    for (const rule of FORBIDDEN_PUBLIC_ARTIFACT_RULES) {
      if (rule.test(relativePath)) {
        violations.push({
          relativePath,
          rule: rule.label,
        });
      }
    }
  }

  return violations;
}

async function main() {
  const result = await runPublicCopyScan();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === path.resolve(modulePath)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Public copy scan failed: ${message}\n`);
    process.exitCode = 1;
  });
}
