import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  collectPublicArtifacts,
  collectPublicCopyFiles,
  findForbiddenPublicArtifacts,
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

test("findPublicCopyViolations detects internal repo names and local path leakage", () => {
  const internalRepoLeak = findPublicCopyViolations(
    "Source: martin-Loop/ML_Main_Repo_Internal",
    "README.md",
  );
  const windowsPathLeak = findPublicCopyViolations(
    "Path: C:\\Users\\Example\\OneDrive\\Documents\\notes.md",
    "README.md",
  );
  const codexAttachmentLeak = findPublicCopyViolations(
    "Attachment: .codex/attachments/abc123/pasted-text.txt",
    "README.md",
  );

  assert.ok(internalRepoLeak.length > 0);
  assert.ok(windowsPathLeak.length > 0);
  assert.ok(codexAttachmentLeak.length > 0);
});

test("findPublicCopyViolations ignores fenced command blocks and package scripts", () => {
  const readmeViolations = findPublicCopyViolations(
    "```sh\npnpm release:matrix:local\n```",
    "README.md",
  );
  const manifestViolations = findPublicCopyViolations(
    JSON.stringify(
      {
        name: "martin-loop",
        scripts: {
          "release:matrix:local": "node ./scripts/release-matrix.mjs",
        },
      },
      null,
      2,
    ),
    "package.json",
  );

  assert.equal(readmeViolations.length, 0);
  assert.equal(manifestViolations.length, 0);
});

test("findPublicCopyViolations allows release packet wording inside release docs", () => {
  const violations = findPublicCopyViolations(
    "# Martin MCP 0.2.7 Release Packet\n",
    "docs/release/MCP-0.2.7-RELEASE-PACKET.md",
  );

  assert.equal(violations.length, 0);
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

test("findForbiddenPublicArtifacts rejects release handoff archives and html artifacts", async () => {
  const artifacts = [
    "docs/release/v0.2.7.md",
    "docs/release/martin-loop-external-audit-handoff-2026-04-24.zip",
    "docs/assets/phase3c-demo.html",
  ];

  const violations = findForbiddenPublicArtifacts(artifacts);

  assert.deepEqual(
    violations.map((violation) => [violation.relativePath, violation.rule]),
    [
      ["docs/release/martin-loop-external-audit-handoff-2026-04-24.zip", "release handoff archive"],
      ["docs/assets/phase3c-demo.html", "public html artifact"],
    ],
  );
});

test("collectPublicArtifacts includes docs files for artifact checks", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "martin-public-artifacts-"));
  await mkdir(path.join(rootDir, "docs", "release"), { recursive: true });
  await writeFile(path.join(rootDir, "docs", "release", "v0.2.7.md"), "# Release\n");
  await writeFile(path.join(rootDir, "docs", "release", "artifact.zip"), "zip\n");

  const files = await collectPublicArtifacts(rootDir);

  assert.ok(files.includes("docs/release/v0.2.7.md"));
  assert.ok(files.includes("docs/release/artifact.zip"));
});
