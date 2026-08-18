import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createOssBoundaryReport,
  renderOssBoundaryReportMarkdown,
} from "../oss-boundary.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("createOssBoundaryReport keeps only the OSS-safe workspace surface", async () => {
  const report = await createOssBoundaryReport({ rootDir: ROOT_DIR });

  assert.deepEqual(
    report.ossCorePackages.map((pkg) => pkg.name),
    [
      "@martin/contracts",
      "@martin/core",
      "@martin/adapters",
      "@martin/presentation",
      "@martin/cli",
      "@martinloop/mcp",
    ],
  );

  assert.equal(report.summary.ossCoreCount, 6);
  assert.ok(report.topLevelEntries.includes(".agents"));
  assert.ok(report.topLevelEntries.includes("plugins"));
  assert.deepEqual(report.forbiddenTopLevelEntries, []);
  assert.deepEqual(report.unexpectedTopLevelEntries, []);
  assert.deepEqual(report.unexpectedPackageDirs, []);
  assert.equal(report.summary.dependencyLeakCount, 0);
});

test("renderOssBoundaryReportMarkdown produces a reviewer-friendly OSS boundary summary", async () => {
  const report = await createOssBoundaryReport({ rootDir: ROOT_DIR });
  const markdown = renderOssBoundaryReportMarkdown(report);

  assert.equal(report.verdict, "go");
  assert.match(markdown, /# Martin Loop OSS Boundary Report/i);
  assert.match(markdown, /@martin\/cli/);
  assert.match(markdown, /npx -y @martinloop\/mcp/);
  assert.match(markdown, /Forbidden top-level entries: none/i);
});
