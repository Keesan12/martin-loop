import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildRepoGroundingIndex,
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
});
