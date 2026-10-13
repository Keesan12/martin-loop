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

test("repository runner uses only the three fixed public onboarding surfaces", async () => {
  assert.deepEqual(PUBLIC_ONBOARDING_SURFACES, [
    "README.md",
    "packages/cli/README.md",
    "docs/reference/cli.md",
  ]);

  const result = await evaluatePublicOnboardingSurfaces(ROOT_DIR);
  assert.equal(result.checkedFiles.length, 3);
  assert.deepEqual(result.checkedFiles, PUBLIC_ONBOARDING_SURFACES);
  assert.deepEqual(result, {
    ok: true,
    checkedFiles: PUBLIC_ONBOARDING_SURFACES,
    violations: [],
  });
});
