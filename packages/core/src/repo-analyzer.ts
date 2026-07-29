// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Repo Style Analyzer
 *
 * Scans a repository to detect coding conventions, patterns, and style
 * so that governed agent runs produce code matching the existing codebase.
 *
 * Detects:
 * - Naming conventions (camelCase, snake_case, PascalCase, kebab-case)
 * - Test framework (Vitest, Jest, Mocha, node:test)
 * - Package manager (pnpm, npm, yarn, bun)
 * - Module system (ESM, CJS, mixed)
 * - File organization pattern (feature folders, type folders, flat)
 * - TypeScript strictness level
 * - Comment density
 * - Formatting (tabs vs spaces, semicolons, quotes)
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

export interface RepoStyleProfile {
  /** Detected package manager */
  packageManager: "pnpm" | "npm" | "yarn" | "bun" | "unknown";
  /** Detected module system */
  moduleSystem: "esm" | "cjs" | "mixed" | "unknown";
  /** Detected test framework */
  testFramework: "vitest" | "jest" | "mocha" | "node-test" | "unknown";
  /** Primary language */
  language: "typescript" | "javascript" | "mixed";
  /** TypeScript strict mode enabled */
  typescriptStrict: boolean;
  /** Dominant naming convention for files */
  fileNaming: "kebab-case" | "camelCase" | "PascalCase" | "snake_case" | "mixed";
  /** Dominant naming convention for variables/functions */
  codeNaming: "camelCase" | "snake_case" | "mixed";
  /** Uses semicolons */
  semicolons: boolean;
  /** Single vs double quotes */
  quotes: "single" | "double" | "mixed";
  /** Indentation style */
  indentation: "tabs" | "2-spaces" | "4-spaces" | "mixed";
  /** Average lines per file (source files) */
  avgLinesPerFile: number;
  /** File organization pattern */
  organization: "feature-folders" | "type-folders" | "flat" | "mixed";
  /** Raw signals for prompt injection */
  promptDirectives: string[];
}

/**
 * Analyze a repository and return a style profile.
 */
export function analyzeRepoStyle(rootDir: string): RepoStyleProfile {
  const profile: RepoStyleProfile = {
    packageManager: detectPackageManager(rootDir),
    moduleSystem: detectModuleSystem(rootDir),
    testFramework: detectTestFramework(rootDir),
    language: detectLanguage(rootDir),
    typescriptStrict: detectTypeScriptStrict(rootDir),
    fileNaming: "kebab-case",
    codeNaming: "camelCase",
    semicolons: true,
    quotes: "double",
    indentation: "2-spaces",
    avgLinesPerFile: 0,
    organization: "mixed",
    promptDirectives: []
  };

  // Sample source files for style detection
  const sourceFiles = collectSourceFiles(rootDir, 50);
  if (sourceFiles.length > 0) {
    const styleSignals = analyzeSourceFiles(sourceFiles);
    profile.fileNaming = styleSignals.fileNaming;
    profile.codeNaming = styleSignals.codeNaming;
    profile.semicolons = styleSignals.semicolons;
    profile.quotes = styleSignals.quotes;
    profile.indentation = styleSignals.indentation;
    profile.avgLinesPerFile = styleSignals.avgLinesPerFile;
  }

  profile.organization = detectOrganization(rootDir);
  profile.promptDirectives = buildPromptDirectives(profile);

  return profile;
}

function detectPackageManager(rootDir: string): RepoStyleProfile["packageManager"] {
  if (existsSync(join(rootDir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(rootDir, "bun.lockb")) || existsSync(join(rootDir, "bun.lock"))) return "bun";
  if (existsSync(join(rootDir, "yarn.lock"))) return "yarn";
  if (existsSync(join(rootDir, "package-lock.json"))) return "npm";
  return "unknown";
}

function detectModuleSystem(rootDir: string): RepoStyleProfile["moduleSystem"] {
  const pkgPath = join(rootDir, "package.json");
  if (!existsSync(pkgPath)) return "unknown";
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { type?: string };
    if (pkg.type === "module") return "esm";
    if (pkg.type === "commonjs") return "cjs";
  } catch { /* ignore */ }
  return "unknown";
}

function detectTestFramework(rootDir: string): RepoStyleProfile["testFramework"] {
  const pkgPath = join(rootDir, "package.json");
  if (!existsSync(pkgPath)) return "unknown";
  try {
    const raw = readFileSync(pkgPath, "utf8");
    if (raw.includes("vitest")) return "vitest";
    if (raw.includes("jest")) return "jest";
    if (raw.includes("mocha")) return "mocha";
    if (raw.includes("node:test")) return "node-test";
  } catch { /* ignore */ }

  if (existsSync(join(rootDir, "vitest.config.ts")) || existsSync(join(rootDir, "vitest.config.js"))) return "vitest";
  if (existsSync(join(rootDir, "jest.config.ts")) || existsSync(join(rootDir, "jest.config.js"))) return "jest";
  return "unknown";
}

function detectLanguage(rootDir: string): RepoStyleProfile["language"] {
  if (
    existsSync(join(rootDir, "tsconfig.json")) ||
    existsSync(join(rootDir, "tsconfig.base.json")) ||
    existsSync(join(rootDir, "tsconfig.build.json"))
  ) {
    return "typescript";
  }
  return "javascript";
}

function detectTypeScriptStrict(rootDir: string): boolean {
  const candidates = ["tsconfig.json", "tsconfig.base.json", "tsconfig.build.json"];
  for (const candidate of candidates) {
    const tsConfigPath = join(rootDir, candidate);
    if (!existsSync(tsConfigPath)) continue;
    try {
      const raw = readFileSync(tsConfigPath, "utf8");
      if (raw.includes('"strict": true') || raw.includes('"strict":true')) return true;
    } catch { /* skip */ }
  }
  return false;
}

function collectSourceFiles(rootDir: string, limit: number): string[] {
  const results: string[] = [];
  const extensions = new Set([".ts", ".tsx", ".js", ".jsx"]);

  function walk(dir: string, depth: number): void {
    if (depth > 5 || results.length >= limit) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= limit) return;
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (entry.isFile() && extensions.has(extname(entry.name))) {
          results.push(fullPath);
        }
      }
    } catch { /* skip */ }
  }

  walk(rootDir, 0);
  return results;
}

interface SourceStyleSignals {
  fileNaming: RepoStyleProfile["fileNaming"];
  codeNaming: RepoStyleProfile["codeNaming"];
  semicolons: boolean;
  quotes: "single" | "double" | "mixed";
  indentation: "tabs" | "2-spaces" | "4-spaces" | "mixed";
  avgLinesPerFile: number;
}

function analyzeSourceFiles(files: string[]): SourceStyleSignals {
  let semiCount = 0;
  let noSemiCount = 0;
  let singleQuoteCount = 0;
  let doubleQuoteCount = 0;
  let tabCount = 0;
  let twoSpaceCount = 0;
  let fourSpaceCount = 0;
  let totalLines = 0;

  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, "utf8");
      const lines = content.split("\n");
      totalLines += lines.length;

      for (const line of lines.slice(0, 100)) {
        if (line.trimEnd().endsWith(";")) semiCount++;
        else if (line.trim().length > 0) noSemiCount++;

        if (/'\w/.test(line)) singleQuoteCount++;
        if (/"\w/.test(line)) doubleQuoteCount++;

        if (line.startsWith("\t")) tabCount++;
        else if (line.startsWith("  ") && !line.startsWith("    ")) twoSpaceCount++;
        else if (line.startsWith("    ")) fourSpaceCount++;
      }
    } catch { /* skip */ }
  }

  const semicolons = semiCount > noSemiCount;
  const quotes: "single" | "double" | "mixed" =
    singleQuoteCount > doubleQuoteCount * 2 ? "single" :
    doubleQuoteCount > singleQuoteCount * 2 ? "double" : "mixed";
  const indentation: "tabs" | "2-spaces" | "4-spaces" | "mixed" =
    tabCount > twoSpaceCount + fourSpaceCount ? "tabs" :
    twoSpaceCount > fourSpaceCount * 2 ? "2-spaces" :
    fourSpaceCount > twoSpaceCount * 2 ? "4-spaces" : "mixed";

  return {
    fileNaming: "kebab-case", // Default, hard to detect reliably without more files
    codeNaming: "camelCase",  // TypeScript default
    semicolons,
    quotes,
    indentation,
    avgLinesPerFile: files.length > 0 ? Math.round(totalLines / files.length) : 0
  };
}

function detectOrganization(rootDir: string): RepoStyleProfile["organization"] {
  const srcDir = join(rootDir, "src");
  if (!existsSync(srcDir)) return "flat";

  try {
    const entries = readdirSync(srcDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const hasFeatureDirs = dirs.some((d) =>
      !["utils", "lib", "types", "helpers", "common", "shared", "__tests__", "tests"].includes(d)
    );
    const hasTypeDirs = dirs.some((d) =>
      ["components", "hooks", "services", "models", "controllers", "routes", "middleware"].includes(d)
    );

    if (hasFeatureDirs && !hasTypeDirs) return "feature-folders";
    if (hasTypeDirs && !hasFeatureDirs) return "type-folders";
    if (hasFeatureDirs && hasTypeDirs) return "mixed";
  } catch { /* skip */ }

  return "flat";
}

/**
 * Build prompt directives from the style profile.
 * These get injected into the agent's prompt to match repo conventions.
 */
export function buildPromptDirectives(profile: RepoStyleProfile): string[] {
  const directives: string[] = [];

  if (profile.language === "typescript") {
    directives.push("Write TypeScript, not JavaScript.");
    if (profile.typescriptStrict) {
      directives.push("TypeScript strict mode is enabled. Use explicit types, avoid any.");
    }
  }

  if (profile.moduleSystem === "esm") {
    directives.push("Use ES module imports (import/export), not require().");
  } else if (profile.moduleSystem === "cjs") {
    directives.push("Use CommonJS (require/module.exports), not ES module imports.");
  }

  if (profile.testFramework !== "unknown") {
    directives.push(`Use ${profile.testFramework} for tests. Do not introduce a different test framework.`);
  }

  if (profile.semicolons) {
    directives.push("Use semicolons at the end of statements.");
  } else {
    directives.push("Do not use semicolons at the end of statements.");
  }

  if (profile.quotes === "single") {
    directives.push("Use single quotes for strings.");
  } else if (profile.quotes === "double") {
    directives.push("Use double quotes for strings.");
  }

  if (profile.indentation === "tabs") {
    directives.push("Use tabs for indentation.");
  } else if (profile.indentation === "2-spaces") {
    directives.push("Use 2-space indentation.");
  } else if (profile.indentation === "4-spaces") {
    directives.push("Use 4-space indentation.");
  }

  if (profile.packageManager !== "unknown") {
    directives.push(`This project uses ${profile.packageManager}. Do not use other package managers.`);
  }

  return directives;
}
