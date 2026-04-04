import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createReleaseSurfaceReport,
  renderReleaseSurfaceReportMarkdown,
} from "../release-surface-audit.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("createReleaseSurfaceReport captures the frozen public surface and the RC gate commands", async () => {
  const report = await createReleaseSurfaceReport({ rootDir: ROOT_DIR });

  assert.equal(report.publicSurface.packageName, "martin-loop");
  assert.equal(report.publicSurface.installCommand, "npm install martin-loop");
  assert.equal(report.publicSurface.npxCommand, "npx martin-loop");
  assert.equal(report.publicSurface.sdkImportStatement, 'import { MartinLoop } from "martin-loop"');
  assert.deepEqual(report.rcGateCommands, [
    "pnpm oss:validate",
    "pnpm public:smoke",
    "pnpm repo:smoke",
    "pnpm rc:validate",
    "pnpm pilot:prep:validate",
    "pnpm release:matrix:local",
  ]);
});

test("createReleaseSurfaceReport requires the key RC docs to align to the shipped surface", async () => {
  const report = await createReleaseSurfaceReport({ rootDir: ROOT_DIR });

  assert.equal(report.docCoverage.readme.hasPublicSurface, true);
  assert.equal(report.docCoverage.readme.hasRcGateCommands, true);
  assert.equal(report.docCoverage.ossReadme.hasPublicSurface, true);
  assert.equal(report.docCoverage.ossReadme.hasAccountingLabels, true);
  assert.equal(report.docCoverage.ossReadme.hasTrustProfiles, true);
  assert.equal(report.docCoverage.quickstart.hasPublicSurface, true);
  assert.equal(report.docCoverage.quickstart.hasRcGateCommands, true);
  assert.equal(report.docCoverage.examples.hasRegistryCaution, true);
  assert.deepEqual(report.deprecatedFiles, []);
});

test("renderReleaseSurfaceReportMarkdown produces a reviewer-friendly Slice 06 audit", async () => {
  const report = await createReleaseSurfaceReport({ rootDir: ROOT_DIR });
  const markdown = renderReleaseSurfaceReportMarkdown(report);

  assert.equal(report.verdict, "go");
  assert.match(markdown, /# Martin Loop Phase 13 Release Surface Audit/i);
  assert.match(markdown, /pnpm oss:validate/);
  assert.match(markdown, /pnpm repo:smoke/);
  assert.match(markdown, /pnpm pilot:prep:validate/);
  assert.match(markdown, /pnpm release:matrix:local/);
  assert.match(markdown, /README\.md/);
  assert.match(markdown, /docs\/oss\/QUICKSTART\.md/);
});
