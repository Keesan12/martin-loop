import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildRepoGroundingIndex,
  loadOrBuildRepoGroundingIndex,
  queryRepoGroundingIndex,
  scanPatchForGroundingViolations
} from "../src/index.js";

describe("repo grounding index", () => {
  it("indexes repo files and returns relevant hits for the current objective", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-grounding-"));
    await mkdir(join(root, "packages", "core", "src"), { recursive: true });
    await mkdir(join(root, "apps", "dashboard"), { recursive: true });

    await writeFile(
      join(root, "packages", "core", "src", "budget-governor.ts"),
      `
        export function evaluateBudgetGovernor(): boolean { return true; }
        export const budgetPressure = true;
      `,
      "utf8"
    );
    await writeFile(
      join(root, "apps", "dashboard", "page.tsx"),
      `export const Dashboard = () => null;`,
      "utf8"
    );

    const index = await buildRepoGroundingIndex(root);
    const hits = queryRepoGroundingIndex(
      index,
      "fix budget governor pressure in core runtime",
      3
    );

    expect(index.fileCount).toBeGreaterThanOrEqual(2);
    expect(hits[0]?.path).toContain("budget-governor.ts");
    expect(hits[0]?.symbols).toContain("evaluateBudgetGovernor");
  });

  it("returns empty hits when the query has no matching terms", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-grounding-empty-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "foo.ts"), "export const foo = 1;", "utf8");

    const index = await buildRepoGroundingIndex(root);
    const hits = queryRepoGroundingIndex(index, "zzz totally unrelated xkjqpw", 3);

    expect(Array.isArray(hits)).toBe(true);
    expect(hits.length).toBe(0);
  });

  it("respects the limit parameter", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-grounding-limit-"));
    await mkdir(join(root, "src"), { recursive: true });

    for (let i = 0; i < 5; i++) {
      await writeFile(
        join(root, "src", `adapter-module-${i}.ts`),
        `export function adapterFunction${i}(): void {}`,
        "utf8"
      );
    }

    const index = await buildRepoGroundingIndex(root);
    const hits = queryRepoGroundingIndex(index, "adapter module function", 2);

    expect(hits.length).toBeLessThanOrEqual(2);
  });
});

describe("scanPatchForGroundingViolations", () => {
  it("detects a file_not_found violation when a diff references a nonexistent file", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-scan-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "real-file.ts"), "export const x = 1;", "utf8");

    const index = await buildRepoGroundingIndex(root);
    const diff = `--- a/src/ghost-file.ts
+++ b/src/ghost-file.ts
@@ -0,0 +1,3 @@
+export function ghostFunction() {
+  return 42;
+}`;

    const result = scanPatchForGroundingViolations(diff, index);

    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    const fileViolation = result.violations.find((violation) => violation.kind === "file_not_found");
    expect(fileViolation).toBeDefined();
    expect(fileViolation?.reference).toContain("ghost-file.ts");
  });

  it("returns no violations when all diff file references exist in the index", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-scan-clean-"));
    await mkdir(join(root, "packages", "core", "src"), { recursive: true });
    await writeFile(
      join(root, "packages", "core", "src", "policy.ts"),
      "export function classifyFailure() {}",
      "utf8"
    );

    const index = await buildRepoGroundingIndex(root);
    const diff = `--- a/packages/core/src/policy.ts
+++ b/packages/core/src/policy.ts
@@ -1 +1 @@
-export function classifyFailure() {}
+export function classifyFailure(): void {}`;

    const result = scanPatchForGroundingViolations(diff, index);

    const fileViolations = result.violations.filter((violation) => violation.kind === "file_not_found");
    expect(fileViolations).toHaveLength(0);
    expect(result.resolvedFiles).toContain("packages/core/src/policy.ts");
  });

  it("detects patch_outside_allowed_paths when diff touches forbidden files", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-scan-scope-"));
    await mkdir(join(root, "packages", "core", "src"), { recursive: true });
    await mkdir(join(root, "apps", "dashboard"), { recursive: true });
    await writeFile(join(root, "packages", "core", "src", "index.ts"), "export const x = 1;", "utf8");
    await writeFile(
      join(root, "apps", "dashboard", "page.tsx"),
      "export default function Page() {}",
      "utf8"
    );

    const index = await buildRepoGroundingIndex(root);
    const diff = `--- a/apps/dashboard/page.tsx
+++ b/apps/dashboard/page.tsx
@@ -1 +1 @@
-export default function Page() {}
+export default function Page() { return null; }`;

    const result = scanPatchForGroundingViolations(diff, index, {
      allowedPaths: ["packages/core/**"]
    });

    const scopeViolation = result.violations.find(
      (violation) => violation.kind === "patch_outside_allowed_paths"
    );
    expect(scopeViolation).toBeDefined();
    expect(scopeViolation?.reference).toContain("apps/dashboard/page.tsx");
  });

  it("challenge 1: detects import_not_found when diff adds a fake relative import", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-challenge1-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "real-module.ts"), "export const x = 1;", "utf8");

    const index = await buildRepoGroundingIndex(root);

    // Diff that adds an import to a non-existent local module
    const diff = `--- a/src/consumer.ts
+++ b/src/consumer.ts
@@ -0,0 +1,3 @@
+import { fakeHelper } from "./fake-module.js";
+
+export const result = fakeHelper();`;

    const result = scanPatchForGroundingViolations(diff, index);

    const importViolation = result.violations.find((v) => v.kind === "import_not_found");
    expect(importViolation).toBeDefined();
    expect(importViolation?.reference).toContain("fake-module");
  });

  it("challenge 2: detects symbol_not_found when diff references an unindexed internal helper", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-challenge2-"));
    await mkdir(join(root, "src"), { recursive: true });
    // Index only contains "realHelper" — not "phantomHelper"
    await writeFile(
      join(root, "src", "helpers.ts"),
      "export function realHelper() { return true; }",
      "utf8"
    );

    const index = await buildRepoGroundingIndex(root);

    // Diff adds usage of a symbol that doesn't exist in the index
    const diff = `--- a/src/consumer.ts
+++ b/src/consumer.ts
@@ -0,0 +1,3 @@
+export function processData(input: string): boolean {
+  return phantomHelper(input);
+}`;

    const result = scanPatchForGroundingViolations(diff, index);

    const symbolViolations = result.violations.filter((v) => v.kind === "symbol_not_found");
    expect(symbolViolations.length).toBeGreaterThanOrEqual(1);
    const phantomViolation = symbolViolations.find((v) => v.reference === "phantomHelper");
    expect(phantomViolation).toBeDefined();
  });

  it("challenge 3: detects out-of-scope patch when package.json is modified outside allowedPaths", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-challenge3-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "index.ts"), "export const x = 1;", "utf8");
    await writeFile(join(root, "package.json"), '{"name":"test"}', "utf8");

    const index = await buildRepoGroundingIndex(root);

    // Diff modifies package.json — outside the allowedPaths scope
    const diff = `--- a/package.json
+++ b/package.json
@@ -1 +1 @@
-{"name":"test"}
+{"name":"test","dependencies":{"lodash":"^4.0.0"}}`;

    const result = scanPatchForGroundingViolations(diff, index, {
      allowedPaths: ["src/**"]
    });

    const scopeViolation = result.violations.find((v) => v.kind === "patch_outside_allowed_paths");
    expect(scopeViolation).toBeDefined();
    expect(scopeViolation?.reference).toContain("package.json");
  });

  it("challenge 4: detects patch_outside_allowed_paths for a realistic scope violation", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-challenge4-"));
    await mkdir(join(root, "packages", "core", "src"), { recursive: true });
    await mkdir(join(root, "apps", "control-plane", "app"), { recursive: true });
    await writeFile(
      join(root, "packages", "core", "src", "policy.ts"),
      "export function classifyFailure() {}",
      "utf8"
    );
    await writeFile(
      join(root, "apps", "control-plane", "app", "page.tsx"),
      "export default function Page() {}",
      "utf8"
    );

    const index = await buildRepoGroundingIndex(root);

    // Task scope: only allowed to modify packages/core — but diff also touches control-plane
    const diff = `--- a/apps/control-plane/app/page.tsx
+++ b/apps/control-plane/app/page.tsx
@@ -1 +1 @@
-export default function Page() {}
+export default function Page() { return null; }`;

    const result = scanPatchForGroundingViolations(diff, index, {
      allowedPaths: ["packages/core/**"]
    });

    const scopeViolation = result.violations.find((v) => v.kind === "patch_outside_allowed_paths");
    expect(scopeViolation).toBeDefined();
    expect(scopeViolation?.reference).toContain("apps/control-plane");
  });

  it("challenge 5: flags content-only diff when patch adds only comments with no substantive code", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-challenge5-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "policy.ts"), "export function run() {}", "utf8");

    const index = await buildRepoGroundingIndex(root);

    // Diff adds only a comment — no real code change
    const diff = `--- a/src/policy.ts
+++ b/src/policy.ts
@@ -1 +1,3 @@
+// TODO: implement this properly
+// See issue #42
 export function run() {}`;

    const result = scanPatchForGroundingViolations(diff, index);

    expect(result.contentOnly).toBe(true);
  });
});

describe("loadOrBuildRepoGroundingIndex anatomy artifact", () => {
  it("writes a schema-valid anatomy artifact to ~/.martin/grounding/ on first call", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-anatomy-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "src", "core.ts"),
      "export function run(): void {}",
      "utf8"
    );

    const index = await loadOrBuildRepoGroundingIndex(root);

    // Verify index in memory is valid
    expect(index.schemaVersion).toBe("martin.grounding.v1");
    expect(index.repoRoot).toBe(root);
    expect(typeof index.createdAt).toBe("string");
    expect(index.fileCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(index.files)).toBe(true);

    // Verify artifact was written to disk
    const cacheDir = join(homedir(), ".martin", "grounding");
    const cacheFile = join(
      cacheDir,
      `${Buffer.from(root).toString("base64url")}.json`
    );
    expect(existsSync(cacheFile)).toBe(true);

    // Verify disk artifact is valid JSON with correct schema
    const rawContent = await readFile(cacheFile, "utf8");
    const parsed = JSON.parse(rawContent) as typeof index;
    expect(parsed.schemaVersion).toBe("martin.grounding.v1");
    expect(parsed.repoRoot).toBe(root);
    expect(Array.isArray(parsed.files)).toBe(true);
  });
});
