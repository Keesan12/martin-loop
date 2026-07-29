// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Repo Style Analyzer — real tests.
 *
 * Runs analyzeRepoStyle against the actual ML_Core_OSS_Internal repo
 * to verify detection of real conventions.
 */

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { analyzeRepoStyle, buildPromptDirectives } from "../src/repo-analyzer.js";

const REPO_ROOT = resolve(__dirname, "../../..");

describe("analyzeRepoStyle on this repo", () => {
  it("detects pnpm as the package manager", () => {
    const profile = analyzeRepoStyle(REPO_ROOT);
    expect(profile.packageManager).toBe("pnpm");
  });

  it("detects ESM module system", () => {
    const profile = analyzeRepoStyle(REPO_ROOT);
    expect(profile.moduleSystem).toBe("esm");
  });

  it("detects TypeScript as primary language", () => {
    const profile = analyzeRepoStyle(REPO_ROOT);
    expect(profile.language).toBe("typescript");
  });

  it("detects vitest as test framework", () => {
    const profile = analyzeRepoStyle(REPO_ROOT);
    expect(profile.testFramework).toBe("vitest");
  });

  it("returns a non-zero average lines per file", () => {
    const profile = analyzeRepoStyle(REPO_ROOT);
    expect(profile.avgLinesPerFile).toBeGreaterThan(0);
  });

  it("detects semicolons usage", () => {
    const profile = analyzeRepoStyle(REPO_ROOT);
    expect(typeof profile.semicolons).toBe("boolean");
  });

  it("detects quote style", () => {
    const profile = analyzeRepoStyle(REPO_ROOT);
    expect(["single", "double", "mixed"]).toContain(profile.quotes);
  });

  it("detects indentation style", () => {
    const profile = analyzeRepoStyle(REPO_ROOT);
    expect(["tabs", "2-spaces", "4-spaces", "mixed"]).toContain(profile.indentation);
  });
});

describe("buildPromptDirectives", () => {
  it("generates TypeScript directive for TS repos", () => {
    const profile = analyzeRepoStyle(REPO_ROOT);
    const directives = buildPromptDirectives(profile);
    expect(directives).toContain("Write TypeScript, not JavaScript.");
  });

  it("generates ESM directive for ESM repos", () => {
    const profile = analyzeRepoStyle(REPO_ROOT);
    const directives = buildPromptDirectives(profile);
    expect(directives.some((d) => d.includes("ES module"))).toBe(true);
  });

  it("generates vitest directive", () => {
    const profile = analyzeRepoStyle(REPO_ROOT);
    const directives = buildPromptDirectives(profile);
    expect(directives.some((d) => d.includes("vitest"))).toBe(true);
  });

  it("generates pnpm directive", () => {
    const profile = analyzeRepoStyle(REPO_ROOT);
    const directives = buildPromptDirectives(profile);
    expect(directives.some((d) => d.includes("pnpm"))).toBe(true);
  });

  it("returns a non-empty array of directives", () => {
    const profile = analyzeRepoStyle(REPO_ROOT);
    const directives = buildPromptDirectives(profile);
    expect(directives.length).toBeGreaterThan(3);
  });
});
