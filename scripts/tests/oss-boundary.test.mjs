import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createOssBoundaryReport,
  renderOssBoundaryReportMarkdown,
} from "../oss-boundary.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("createOssBoundaryReport defines the intended OSS core packages without workspace dependency leaks", async () => {
  const report = await createOssBoundaryReport({ rootDir: ROOT_DIR });

  assert.deepEqual(
    report.ossCorePackages.map((pkg) => pkg.name),
    ["@martin/contracts", "@martin/core", "@martin/adapters", "@martin/cli", "@martin/mcp"],
  );

  assert.equal(report.summary.dependencyLeakCount, 0);
  assert.equal(report.summary.ossCoreCount, 5);
  assert.equal(report.summary.nonOssWorkspaceCount, 2);
  assert.equal(report.summary.localOnlySurfaceCount, 1);
});

test("createOssBoundaryReport keeps hosted and RC-only workspaces out of the OSS core set", async () => {
  const report = await createOssBoundaryReport({ rootDir: ROOT_DIR });

  const nonOssNames = report.nonOssWorkspacePackages.map((pkg) => pkg.name);
  const localOnlyPaths = report.localOnlySurfaces.map((surface) => surface.path);

  assert.deepEqual(nonOssNames, ["@martin/control-plane", "@martin/benchmarks"]);
  assert.deepEqual(localOnlyPaths, ["apps/local-dashboard"]);
});

test("createOssBoundaryReport captures the memo-frozen public package surface honestly", async () => {
  const report = await createOssBoundaryReport({ rootDir: ROOT_DIR });

  assert.equal(report.publicSurface.packageName, "martin-loop");
  assert.equal(report.publicSurface.canonicalPackageManager, "npm");
  assert.equal(report.publicSurface.installCommand, "npm install martin-loop");
  assert.equal(report.publicSurface.npxCommand, "npx martin-loop");
  assert.equal(report.publicSurface.sdkImportPath, "martin-loop");
  assert.equal(report.publicSurface.supportsNpxCommand, true);
  assert.equal(report.publicSurface.supportsSdkImport, true);
});

test("renderOssBoundaryReportMarkdown produces a reviewer-friendly RC boundary summary", async () => {
  const report = await createOssBoundaryReport({ rootDir: ROOT_DIR });
  const markdown = renderOssBoundaryReportMarkdown(report);

  assert.equal(report.verdict, "go");
  assert.match(markdown, /# Martin Loop Phase 13 OSS Core Boundary/i);
  assert.match(markdown, /@martin\/cli/);
  assert.match(markdown, /@martin\/benchmarks/);
  assert.match(markdown, /npm install martin-loop/);
  assert.match(markdown, /npx martin-loop/);
  assert.match(markdown, /No workspace dependency leaks detected/i);
});
