import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  collectPublicArtifacts,
  collectPublicCopyFiles,
  findForbiddenPublicArtifacts,
  findPublicCopyViolations,
  runPublicCopyScan,
} from "../public-copy-scan.mjs";
import { scanPromotedSourceChanges } from "../public-source-copy-scan.mjs";

async function createPromotionFixture() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "martin-promoted-copy-"));
  const git = (...args) => execFileSync("git", args, { cwd: rootDir, encoding: "utf8" }).trim();
  const put = async (relativePath, contents) => {
    const fullPath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents);
  };

  git("init", "-q");
  git("config", "user.email", "scanner@example.test");
  git("config", "user.name", "Promotion Scanner");
  git("config", "core.autocrlf", "false");
  await put("README.md", "# MartinLoop\n");
  await put("docs/guide.md", "# Guide\n");
  await put("packages/core/tests/grounding.test.ts", 'test("control", () => {});\n');
  await put("packages/core/tests/café.test.ts", 'test("unicode control", () => {});\n');
  await put("packages/core/src/private-only.ts", "export const internal = true;\n");
  await put("scripts/promoted.mjs", "export const promoted = true;\n");
  git("add", ".");
  git("commit", "-qm", "public base");
  const publicBaseSha = git("rev-parse", "HEAD");
  const publicSurfaceEntries = [
    "README.md",
    "docs/guide.md",
    "packages/core/tests/grounding.test.ts",
    "packages/core/tests/café.test.ts",
    "scripts/promoted.mjs",
  ]
    .map((entryPath) => ({ path: entryPath, mode: "100644", sha256: "a".repeat(64) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  await put(
    ".martin/promotion-manifest.json",
    `${JSON.stringify({ publicBaseSha, publicSurfaceEntries }, null, 2)}\n`,
  );

  return {
    rootDir,
    put,
    commit: (message) => {
      git("add", "-A");
      git("commit", "-qm", message);
    },
    publicSurfaceEntries,
    cleanup: () => rm(rootDir, { recursive: true, force: true }),
  };
}

test("findPublicCopyViolations detects forbidden public-process language", () => {
  const violations = findPublicCopyViolations(
    "This draft still mentions release candidate cleanup notes.",
    "README.md",
  );

  assert.equal(violations.length, 1);
  assert.match(String(violations[0]?.pattern), /release candidate/i);
});

test("findPublicCopyViolations detects internal repo names and local path leakage", () => {
  const syntheticInternalRepository = ["Example", "Service", "Internal"].join("_");
  const internalRepoLeak = findPublicCopyViolations(
    `Source: example-internal/${syntheticInternalRepository}`,
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

test("findPublicCopyViolations detects representative credentials on public copy surfaces", () => {
  const violations = findPublicCopyViolations(
    "OPENAI_API_KEY=sk-proj-1234567890abcdefghijklmnop",
    "README.md",
  );

  assert.deepEqual(
    violations.map((violation) => violation.relativePath),
    ["README.md"],
  );
  assert.match(String(violations[0]?.pattern), /sk-proj/iu);
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

test("findPublicCopyViolations ignores workflow run commands but still scans public workflow labels", () => {
  const workflowViolations = findPublicCopyViolations(
    [
      "name: platform-release-validation",
      "jobs:",
      "  validate:",
      "    steps:",
      "      - name: Run release validation",
      "        run: |",
      "          pnpm release:truth-check",
      "          pnpm release:matrix:local",
    ].join("\n"),
    ".github/workflows/platform-release-validation.yml",
  );
  const labelViolations = findPublicCopyViolations(
    "name: private beta release validation\n",
    ".github/workflows/platform-release-validation.yml",
  );

  assert.equal(workflowViolations.length, 0);
  assert.equal(labelViolations.length, 1);
  assert.match(String(labelViolations[0]?.pattern), /private beta/i);
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

test("required promotion scan rejects the blind-audit CommonJS title with a file and line", async () => {
  const fixture = await createPromotionFixture();
  const privatePhrase = ["blind", "audit"].join(" ");
  try {
    await fixture.put(
      "packages/core/tests/grounding.test.ts",
      `test("accepts the CommonJS patch from the ${privatePhrase}", () => {});\n`,
    );
    fixture.commit("add prohibited promoted copy");

    await assert.rejects(
      runPublicCopyScan({ rootDir: fixture.rootDir, files: ["README.md"], sourceScanRequired: true }),
      /packages\/core\/tests\/grounding\.test\.ts:1.*private audit language/iu,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("promotion scan accepts the corrected CommonJS title and martin audit command", async () => {
  const fixture = await createPromotionFixture();
  try {
    await fixture.put(
      "packages/core/tests/grounding.test.ts",
      'test("accepts a CommonJS patch (require is a Node global)", () => {});\n',
    );
    await fixture.put("scripts/promoted.mjs", 'export const command = "martin audit";\n');
    fixture.commit("add acceptable promoted copy");

    const result = await runPublicCopyScan({
      rootDir: fixture.rootDir,
      files: ["README.md"],
      sourceScanRequired: true,
    });
    assert.ok(result.checkedSourceAdditions >= 2);
  } finally {
    await fixture.cleanup();
  }
});

test("promotion scan ignores private-only changes outside manifest publicSurfaceEntries", async () => {
  const fixture = await createPromotionFixture();
  const privatePhrase = ["blind", "audit"].join(" ");
  try {
    await fixture.put(
      "packages/core/src/private-only.ts",
      `// ${privatePhrase}\nexport const internal = true;\n`,
    );

    const result = await runPublicCopyScan({
      rootDir: fixture.rootDir,
      files: ["README.md"],
      sourceScanRequired: true,
    });
    assert.equal(result.checkedSourceFiles, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("promotion scan reads every line of a newly promoted source file", async () => {
  const fixture = await createPromotionFixture();
  const privatePhrase = ["blind", "audit"].join(" ");
  try {
    const newPath = "packages/core/tests/new-public.test.ts";
    await fixture.put(newPath, `// ${privatePhrase}\nexport const value = true;\n`);
    const manifestPath = path.join(fixture.rootDir, ".martin", "promotion-manifest.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        publicBaseSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.rootDir, encoding: "utf8" }).trim(),
        publicSurfaceEntries: [
          ...fixture.publicSurfaceEntries,
          { path: newPath, mode: "100644", sha256: "b".repeat(64) },
        ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      }, null, 2)}\n`,
    );
    fixture.commit("add new promoted source");

    await assert.rejects(
      runPublicCopyScan({ rootDir: fixture.rootDir, files: ["README.md"], sourceScanRequired: true }),
      /packages\/core\/tests\/new-public\.test\.ts:1.*private audit language/iu,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("required promotion scan fails closed when its manifest is missing", async () => {
  const fixture = await createPromotionFixture();
  try {
    await rm(path.join(fixture.rootDir, ".martin", "promotion-manifest.json"));
    await assert.rejects(
      runPublicCopyScan({ rootDir: fixture.rootDir, files: ["README.md"], sourceScanRequired: true }),
      /promotion manifest.*required/iu,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("required promotion scan fails closed when Git cannot execute", async () => {
  const fixture = await createPromotionFixture();
  try {
    assert.throws(
      () => scanPromotedSourceChanges(fixture.rootDir, {
        required: true,
        gitRunner: () => { throw new Error("git unavailable"); },
      }),
      /git unavailable/iu,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("promotion scan inspects additions in a Git-quoted Unicode path", async () => {
  const fixture = await createPromotionFixture();
  const privatePhrase = ["blind", "audit"].join(" ");
  try {
    await fixture.put(
      "packages/core/tests/café.test.ts",
      `test("unicode control", () => {});\n// ${privatePhrase}\n`,
    );
    fixture.commit("change Unicode promoted source");

    await assert.rejects(
      runPublicCopyScan({ rootDir: fixture.rootDir, files: ["README.md"], sourceScanRequired: true }),
      /packages\/core\/tests\/café\.test\.ts:2.*private audit language/iu,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("promotion scan forces text inspection when attributes mark source binary", async () => {
  const fixture = await createPromotionFixture();
  const privatePhrase = ["blind", "audit"].join(" ");
  try {
    await fixture.put(".gitattributes", "packages/core/tests/grounding.test.ts binary\n");
    await fixture.put(
      "packages/core/tests/grounding.test.ts",
      `test("control", () => {});\n// ${privatePhrase}\n`,
    );
    fixture.commit("change binary-marked promoted source");

    await assert.rejects(
      runPublicCopyScan({ rootDir: fixture.rootDir, files: ["README.md"], sourceScanRequired: true }),
      /packages\/core\/tests\/grounding\.test\.ts:2.*private audit language/iu,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("promotion scan rejects an operator machine path without self-triggering portability", async () => {
  const fixture = await createPromotionFixture();
  const machinePath = `C:\\Users\\operator\\${["One", "Drive"].join("")}\\private.txt`;
  try {
    await fixture.put(
      "packages/core/tests/grounding.test.ts",
      `export const leakedPath = ${JSON.stringify(machinePath)};\n`,
    );
    fixture.commit("add operator path disclosure");

    await assert.rejects(
      runPublicCopyScan({ rootDir: fixture.rootDir, files: ["README.md"], sourceScanRequired: true }),
      /packages\/core\/tests\/grounding\.test\.ts:1.*operator OneDrive path/iu,
    );
  } finally {
    await fixture.cleanup();
  }
});
