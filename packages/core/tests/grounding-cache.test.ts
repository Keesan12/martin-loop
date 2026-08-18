import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RepoGroundingIndex } from "../src/grounding";

describe("loadOrBuildRepoGroundingIndex cache hardening", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("returns the built grounding index even when cache persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-grounding-cache-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "core.ts"), "export function run(): void {}", "utf8");

    const groundingDir = await mkdtemp(join(tmpdir(), "martin-grounding-cache-dir-"));
    const previousGroundingDir = process.env.MARTIN_GROUNDING_DIR;
    process.env.MARTIN_GROUNDING_DIR = groundingDir;

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        async writeFile(path: Parameters<typeof actual.writeFile>[0], data: Parameters<typeof actual.writeFile>[1], options?: Parameters<typeof actual.writeFile>[2]) {
          if (String(path).startsWith(groundingDir)) {
            const error = new Error("EPERM: blocked cache write");
            Object.assign(error, { code: "EPERM" });
            throw error;
          }

          return actual.writeFile(path, data, options);
        }
      };
    });

    let index: RepoGroundingIndex;
    try {
      const { loadOrBuildRepoGroundingIndex } = await import("../src/grounding");
      index = await loadOrBuildRepoGroundingIndex(root);
    } finally {
      vi.doUnmock("node:fs/promises");

      if (previousGroundingDir === undefined) {
        delete process.env.MARTIN_GROUNDING_DIR;
      } else {
        process.env.MARTIN_GROUNDING_DIR = previousGroundingDir;
      }
    }

    expect(index.schemaVersion).toBe("martin.grounding.v1");
    expect(index.repoRoot).toBe(root);
    expect(index.fileCount).toBeGreaterThanOrEqual(1);
    expect(index.files.some((file) => file.path === "src/core.ts")).toBe(true);
  });

  it("rebuilds a cached index when a new repository file appears", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-grounding-refresh-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "existing.ts"), "export const existing = true;", "utf8");
    const groundingDir = await mkdtemp(join(tmpdir(), "martin-grounding-refresh-cache-"));
    const previousGroundingDir = process.env.MARTIN_GROUNDING_DIR;
    process.env.MARTIN_GROUNDING_DIR = groundingDir;

    try {
      const { loadOrBuildRepoGroundingIndex, scanPatchForGroundingViolations } = await import(
        "../src/grounding"
      );
      const initial = await loadOrBuildRepoGroundingIndex(root);
      expect(initial.files.some((file) => file.path === "src/new-file.ts")).toBe(false);

      await writeFile(join(root, "src", "new-file.ts"), "export const added = true;", "utf8");
      const refreshed = await loadOrBuildRepoGroundingIndex(root);
      const scan = scanPatchForGroundingViolations(
        "--- a/src/new-file.ts\n+++ b/src/new-file.ts\n+export const added = true;",
        refreshed
      );

      expect(refreshed.files.some((file) => file.path === "src/new-file.ts")).toBe(true);
      expect(scan.violations.some((violation) => violation.kind === "file_not_found")).toBe(false);
    } finally {
      if (previousGroundingDir === undefined) {
        delete process.env.MARTIN_GROUNDING_DIR;
      } else {
        process.env.MARTIN_GROUNDING_DIR = previousGroundingDir;
      }
    }
  });
});
