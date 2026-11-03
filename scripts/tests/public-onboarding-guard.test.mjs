import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PUBLIC_ONBOARDING_SURFACES,
  evaluateOnboardingDocument,
  evaluatePublicOnboardingSurfaces,
} from "../public-onboarding-guard.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("reports an unguarded governed command with its relative path and fence line", () => {
  const result = evaluateOnboardingDocument({
    relativePath: "README.md",
    contents: [
      "# Quick Start",
      "",
      "```sh",
      'martin run "repair the bug" --verify "npm test"',
      "```",
      "",
    ].join("\n"),
  });

  assert.deepEqual(result, {
    ok: false,
    violations: [
      {
        relativePath: "README.md",
        line: 3,
        reason: "governed run/preflight example must select a supported --engine or follow an adjacent enable --engine gate",
      },
    ],
  });
});

test("accepts a supported engine on the governed command", () => {
  const result = evaluateOnboardingDocument({
    relativePath: "packages/cli/README.md",
    contents: [
      "```bash",
      'martin preflight "repair the bug" --engine gemini --verify "pnpm test"',
      "```",
    ].join("\n"),
  });

  assert.deepEqual(result, { ok: true, violations: [] });
});

test("accepts an immediately preceding saved-engine gate", () => {
  const result = evaluateOnboardingDocument({
    relativePath: "docs/reference/cli.md",
    contents: [
      "Select and save the runtime for this project:",
      "",
      "```sh",
      "martin enable --engine codex",
      "```",
      "",
      "Then run the governed preflight:",
      "",
      "```sh",
      'martin preflight "repair the bug" --verify "pnpm test"',
      "```",
    ].join("\n"),
  });

  assert.deepEqual(result, { ok: true, violations: [] });
});

test("does not let a later enable command authorize an earlier governed run", () => {
  const result = evaluateOnboardingDocument({
    relativePath: "README.md",
    contents: [
      "```sh",
      'martin run "repair the bug" --verify "pnpm test"',
      "martin enable --engine codex",
      "```",
    ].join("\n"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.violations[0]?.line, 1);
});

test("excludes proof-only examples and text command synopses", () => {
  const result = evaluateOnboardingDocument({
    relativePath: "README.md",
    contents: [
      "```sh",
      'npx -y martin-loop@latest run "verify only" --proof --verify "npm test"',
      "```",
      "",
      "```text",
      "martin-loop run <objective> [options]",
      "martin-loop preflight <objective> [options]",
      "```",
    ].join("\n"),
  });

  assert.deepEqual(result, { ok: true, violations: [] });
});

test("rejects unknown runtime aliases in both command and saved gate forms", () => {
  const sameBlock = evaluateOnboardingDocument({
    relativePath: "README.md",
    contents: [
      "```sh",
      'martin run "repair the bug" --engine gpt --verify "npm test"',
      "```",
    ].join("\n"),
  });
  const savedGate = evaluateOnboardingDocument({
    relativePath: "README.md",
    contents: [
      "```sh",
      "martin enable --engine cursor",
      "```",
      "",
      "```sh",
      'martin run "repair the bug" --verify "npm test"',
      "```",
    ].join("\n"),
  });

  assert.equal(sameBlock.ok, false);
  assert.match(sameBlock.violations[0]?.reason ?? "", /unsupported engine "gpt"/);
  assert.equal(savedGate.ok, false);
  assert.match(savedGate.violations[0]?.reason ?? "", /unsupported engine "cursor"/);
});

test("repository runner covers every active public onboarding and MCP reference surface", async () => {
  assert.deepEqual(PUBLIC_ONBOARDING_SURFACES, [
    "README.md",
    "packages/cli/README.md",
    "docs/reference/cli.md",
    "docs/getting-started/mcp.md",
    "docs/getting-started/quickstart.md",
    "docs/oss/QUICKSTART.md",
    "docs/oss/MCP-FOR-AI-AGENTS.md",
    "docs/reference/mcp-compatibility.md",
    "docs/release/MCP-PUBLISHING.md",
  ]);

  const result = await evaluatePublicOnboardingSurfaces(ROOT_DIR);
  assert.equal(result.checkedFiles.length, 9);
  assert.deepEqual(result.checkedFiles, PUBLIC_ONBOARDING_SURFACES);
  assert.deepEqual(result, {
    ok: true,
    checkedFiles: PUBLIC_ONBOARDING_SURFACES,
    violations: [],
  });
});

test("rejects stale pinned package versions on active onboarding surfaces", () => {
  const result = evaluateOnboardingDocument({
    relativePath: "docs/getting-started/quickstart.md",
    contents: "Run `npx -y martin-loop@0.3.2 --version`.",
    currentRootVersion: "0.8.10",
    currentMcpVersion: "0.8.10",
  });

  assert.deepEqual(result, {
    ok: false,
    violations: [{
      relativePath: "docs/getting-started/quickstart.md",
      line: 1,
      reason: 'stale package version "martin-loop@0.3.2"; current package version is 0.8.10',
    }],
  });
});

test("accepts an explicitly labeled live standalone MCP baseline that matches the version ledger", () => {
  const result = evaluateOnboardingDocument({
    relativePath: "docs/oss/MCP-FOR-AI-AGENTS.md",
    contents: "`@martinloop/mcp@0.8.10` is the live public standalone MCP baseline for MartinLoop.",
    currentRootVersion: "0.9.0",
    currentMcpVersion: "0.9.0",
    liveMcpVersion: "0.8.10",
  });

  assert.deepEqual(result, { ok: true, violations: [] });
});

test("rejects an explicitly labeled live standalone MCP baseline that disagrees with the version ledger", () => {
  const result = evaluateOnboardingDocument({
    relativePath: "docs/oss/MCP-FOR-AI-AGENTS.md",
    contents: "`@martinloop/mcp@0.8.9` is the live public standalone MCP baseline for MartinLoop.",
    currentRootVersion: "0.9.0",
    currentMcpVersion: "0.9.0",
    liveMcpVersion: "0.8.10",
  });

  assert.deepEqual(result, {
    ok: false,
    violations: [{
      relativePath: "docs/oss/MCP-FOR-AI-AGENTS.md",
      line: 1,
      reason: "stale live MCP baseline 0.8.9; version ledger live baseline is 0.8.10",
    }],
  });
});

test("does not treat an executable MCP pin comment as a live-baseline declaration", () => {
  const result = evaluateOnboardingDocument({
    relativePath: "docs/oss/MCP-FOR-AI-AGENTS.md",
    contents: "npx -y @martinloop/mcp@0.8.10 # live public standalone MCP baseline",
    currentRootVersion: "0.9.0",
    currentMcpVersion: "0.9.0",
    liveMcpVersion: "0.8.10",
  });

  assert.deepEqual(result, {
    ok: false,
    violations: [{
      relativePath: "docs/oss/MCP-FOR-AI-AGENTS.md",
      line: 1,
      reason: 'stale package version "@martinloop/mcp@0.8.10"; current package version is 0.9.0',
    }],
  });
});

test("does not exempt a second stale pin on a valid live-baseline declaration line", () => {
  const result = evaluateOnboardingDocument({
    relativePath: "docs/oss/MCP-FOR-AI-AGENTS.md",
    contents: "`@martinloop/mcp@0.8.10` is the live public standalone MCP baseline; do not install `@martinloop/mcp@0.8.9`.",
    currentRootVersion: "0.9.0",
    currentMcpVersion: "0.9.0",
    liveMcpVersion: "0.8.10",
  });

  assert.deepEqual(result, {
    ok: false,
    violations: [{
      relativePath: "docs/oss/MCP-FOR-AI-AGENTS.md",
      line: 1,
      reason: 'stale package version "@martinloop/mcp@0.8.9"; current package version is 0.9.0',
    }],
  });
});
