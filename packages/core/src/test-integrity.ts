// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Test Integrity Validator
 *
 * Detects circular test validation — the problem where AI agents generate
 * tests that only pass because they test the agent's own output, not real
 * behavior. A test that passes on both the pre-change and post-change
 * codebase proves nothing about the change.
 *
 * Strategy:
 * 1. Snapshot which test files existed before the agent ran
 * 2. After the run, identify NEW test files the agent created
 * 3. For each new test: check if it imports/references pre-existing code
 *    (real test) or only references agent-generated code (circular test)
 * 4. Flag tests that don't exercise any pre-existing function
 *
 * This module provides the analysis primitives. The verification pipeline
 * calls these during the post-run verification step.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";

export interface TestIntegrityReport {
  totalNewTests: number;
  realTests: number;
  suspiciousTests: number;
  findings: TestIntegrityFinding[];
  verdict: "pass" | "warn" | "fail";
  summary: string;
}

export interface TestIntegrityFinding {
  filePath: string;
  issue: "no_pre_existing_imports" | "self_referential" | "trivial_assertion" | "empty_test";
  severity: "high" | "medium" | "low";
  detail: string;
}

interface FileSnapshot {
  path: string;
  existedBefore: boolean;
}

const TEST_FILE_PATTERNS = [
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /\/__tests__\//,
  /\/tests?\//
];

const TRIVIAL_ASSERTION_PATTERNS = [
  /expect\(true\)\.toBe\(true\)/,
  /expect\(1\)\.toBe\(1\)/,
  /expect\(\)\.toBeUndefined\(\)/,
  /assert\.ok\(true\)/,
  /expect\(.*\)\.toBeDefined\(\)/,
  /expect\(typeof\s+\w+\)\.toBe\(['"]\w+['"]\)/
];

const IMPORT_PATTERN = /(?:import\s+.*from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;

/**
 * Detect test files in a directory tree.
 */
export function findTestFiles(rootDir: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && isTestFile(entry.name, fullPath)) {
          results.push(relative(rootDir, fullPath));
        }
      }
    } catch {
      // Permission denied or inaccessible — skip silently
    }
  }

  walk(rootDir);
  return results;
}

/**
 * Check if a filename matches test file patterns.
 */
export function isTestFile(filename: string, fullPath?: string): boolean {
  const checkPath = fullPath ?? filename;
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(checkPath));
}

/**
 * Snapshot existing test files before an agent run.
 */
export function snapshotTestFiles(rootDir: string): Set<string> {
  return new Set(findTestFiles(rootDir));
}

/**
 * Identify new test files created during an agent run.
 */
export function identifyNewTests(rootDir: string, preRunSnapshot: Set<string>): string[] {
  const currentTests = findTestFiles(rootDir);
  return currentTests.filter((testPath) => !preRunSnapshot.has(testPath));
}

/**
 * Extract import paths from a TypeScript/JavaScript file.
 */
export function extractImports(content: string): string[] {
  const imports: string[] = [];
  let match: RegExpExecArray | null;
  const pattern = new RegExp(IMPORT_PATTERN.source, "g");
  while ((match = pattern.exec(content)) !== null) {
    const importPath = match[1] ?? match[2];
    if (importPath) imports.push(importPath);
  }
  return imports;
}

/**
 * Check if a test file contains only trivial assertions.
 */
export function hasTrivialAssertionsOnly(content: string): boolean {
  const assertionLines = content.split("\n").filter((line) =>
    /expect\(|assert\.|should\./i.test(line)
  );
  if (assertionLines.length === 0) return true;
  return assertionLines.every((line) =>
    TRIVIAL_ASSERTION_PATTERNS.some((pattern) => pattern.test(line))
  );
}

/**
 * Check if a test file imports any pre-existing source files.
 */
export function importsPreExistingCode(
  testContent: string,
  preRunSourceFiles: Set<string>
): boolean {
  const imports = extractImports(testContent);
  return imports.some((importPath) => {
    // Relative imports that reference pre-existing files
    if (importPath.startsWith(".") || importPath.startsWith("/")) {
      // Normalize: strip extension, check if any pre-existing source matches
      const normalized = importPath.replace(/\.[tj]sx?$/, "");
      return [...preRunSourceFiles].some((srcFile) => {
        const normalizedSrc = srcFile.replace(/\.[tj]sx?$/, "");
        return normalizedSrc.endsWith(normalized) || normalized.endsWith(normalizedSrc);
      });
    }
    // Package imports always count as real (they reference pre-existing deps)
    return true;
  });
}

/**
 * Validate the integrity of tests created during a governed run.
 */
export function validateTestIntegrity(
  rootDir: string,
  preRunTestSnapshot: Set<string>,
  preRunSourceFiles: Set<string>
): TestIntegrityReport {
  const newTests = identifyNewTests(rootDir, preRunTestSnapshot);
  const findings: TestIntegrityFinding[] = [];

  for (const testPath of newTests) {
    const fullPath = join(rootDir, testPath);
    let content: string;
    try {
      content = readFileSync(fullPath, "utf8");
    } catch {
      findings.push({
        filePath: testPath,
        issue: "empty_test",
        severity: "high",
        detail: "Test file could not be read."
      });
      continue;
    }

    if (content.trim().length === 0) {
      findings.push({
        filePath: testPath,
        issue: "empty_test",
        severity: "high",
        detail: "Test file is empty."
      });
      continue;
    }

    if (hasTrivialAssertionsOnly(content)) {
      findings.push({
        filePath: testPath,
        issue: "trivial_assertion",
        severity: "high",
        detail: "Test contains only trivial assertions (expect(true).toBe(true) or equivalent)."
      });
      continue;
    }

    if (!importsPreExistingCode(content, preRunSourceFiles)) {
      findings.push({
        filePath: testPath,
        issue: "no_pre_existing_imports",
        severity: "medium",
        detail: "Test does not import any pre-existing source code. May be testing only agent-generated output."
      });
    }
  }

  const suspiciousTests = findings.filter((f) => f.severity === "high").length;
  const realTests = newTests.length - suspiciousTests;

  const verdict: TestIntegrityReport["verdict"] =
    suspiciousTests > 0 && suspiciousTests >= newTests.length * 0.5
      ? "fail"
      : suspiciousTests > 0
        ? "warn"
        : "pass";

  const summary =
    newTests.length === 0
      ? "No new test files detected."
      : verdict === "pass"
        ? `${newTests.length} new test(s) validated — all reference pre-existing code.`
        : verdict === "warn"
          ? `${suspiciousTests} of ${newTests.length} new test(s) flagged for review.`
          : `Test integrity check failed: ${suspiciousTests} of ${newTests.length} new test(s) appear circular or trivial.`;

  return {
    totalNewTests: newTests.length,
    realTests,
    suspiciousTests,
    findings,
    verdict,
    summary
  };
}
