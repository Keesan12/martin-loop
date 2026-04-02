import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildRepoGroundingIndex, queryRepoGroundingIndex } from "../src/index.js";

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
