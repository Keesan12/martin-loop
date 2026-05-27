import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  collectPublicCopyFiles,
  findPublicCopyViolations,
  runPublicCopyScan,
} from "../public-copy-scan.mjs";

test("findPublicCopyViolations detects forbidden public-process language", () => {
  const violations = findPublicCopyViolations(
    "This draft still mentions release candidate cleanup notes.",
    "README.md",
  );

  assert.equal(violations.length, 1);
  assert.match(String(violations[0]?.pattern), /release candidate/i);
});

test("collectPublicCopyFiles includes root docs and public metadata surfaces", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "martin-public-copy-"));
  await mkdir(path.join(rootDir, "docs"), { recursive: true });
  await mkdir(path.join(rootDir, ".github"), { recursive: true });
  await mkdir(path.join(rootDir, "packages", "cli"), { recursive: true });

  await writeFile(path.join(rootDir, "README.md"), "# Test\n");
  await writeFile(path.join(rootDir, "AGENTS.md"), "# Test\n");
  await writeFile(path.join(rootDir, "CHANGELOG.md"), "# Test\n");
  await writeFile(path.join(rootDir, "CONTRIBUTING.md"), "# Test\n");
  await writeFile(path.join(rootDir, "SECURITY.md"), "# Test\n");
  await writeFile(path.join(rootDir, "package.json"), "{}\n");
  await writeFile(path.join(rootDir, "docs", "guide.md"), "# Guide\n");
  await writeFile(path.join(rootDir, ".github", "PULL_REQUEST_TEMPLATE.md"), "# PR\n");
  await writeFile(path.join(rootDir, "packages", "cli", "README.md"), "# CLI\n");

  const files = await collectPublicCopyFiles(rootDir);

  assert.ok(files.includes("README.md"));
  assert.ok(files.includes("package.json"));
  assert.ok(files.includes("docs/guide.md"));
  assert.ok(files.includes(".github/PULL_REQUEST_TEMPLATE.md"));
  assert.ok(files.includes("packages/cli/README.md"));
});

test("runPublicCopyScan passes when surfaces are clean", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "martin-public-copy-clean-"));
  await mkdir(path.join(rootDir, "docs"), { recursive: true });
  await mkdir(path.join(rootDir, ".github"), { recursive: true });
  await mkdir(path.join(rootDir, "packages", "mcp"), { recursive: true });

  await writeFile(path.join(rootDir, "README.md"), "# MartinLoop\n");
  await writeFile(path.join(rootDir, "AGENTS.md"), "# AGENTS\n");
  await writeFile(path.join(rootDir, "CHANGELOG.md"), "# Changelog\n");
  await writeFile(path.join(rootDir, "CONTRIBUTING.md"), "# Contributing\n");
  await writeFile(path.join(rootDir, "SECURITY.md"), "# Security\n");
  await writeFile(path.join(rootDir, "package.json"), "{\n  \"name\": \"martin-loop\"\n}\n");
  await writeFile(path.join(rootDir, "docs", "quickstart.md"), "# Quickstart\n");
  await writeFile(path.join(rootDir, ".github", "issue.md"), "# Issue\n");
  await writeFile(path.join(rootDir, "packages", "mcp", "README.md"), "# MCP\n");

  const result = await runPublicCopyScan({ rootDir });
  assert.ok(result.checkedFiles >= 9);
});
