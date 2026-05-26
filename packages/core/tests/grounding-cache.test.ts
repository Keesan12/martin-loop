import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

describe("loadOrBuildRepoGroundingIndex cache hardening", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("returns the built grounding index even when cache persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-grounding-cache-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "core.ts"), "export function run(): void {}", "utf8");

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        async writeFile(path: Parameters<typeof actual.writeFile>[0], data: Parameters<typeof actual.writeFile>[1], options?: Parameters<typeof actual.writeFile>[2]) {
          if (String(path).includes(`${join(".martin", "grounding")}${pathSeparator()}`)) {
            const error = new Error("EPERM: blocked cache write");
            Object.assign(error, { code: "EPERM" });
            throw error;
          }

          return actual.writeFile(path, data, options);
        }
      };
    });
    const { loadOrBuildRepoGroundingIndex } = await import("../src/grounding.js");
    const index = await loadOrBuildRepoGroundingIndex(root);

    expect(index.schemaVersion).toBe("martin.grounding.v1");
    expect(index.repoRoot).toBe(root);
    expect(index.fileCount).toBeGreaterThanOrEqual(1);
    expect(index.files.some((file) => file.path === "src/core.ts")).toBe(true);

    vi.doUnmock("node:fs/promises");
  });

  it("rebuilds the grounding cache when an indexed file changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-grounding-fingerprint-"));
    await mkdir(join(root, "src"), { recursive: true });
    const sourceFile = join(root, "src", "core.ts");
    await writeFile(sourceFile, "export const value = 1;", "utf8");

    const { loadOrBuildRepoGroundingIndex } = await import("../src/grounding.js");
    const initial = await loadOrBuildRepoGroundingIndex(root);

    await writeFile(sourceFile, "export const value = 2;\nexport const next = 3;", "utf8");
    const nextTime = new Date(Date.now() + 2_000);
    await utimes(sourceFile, nextTime, nextTime);

    const rebuilt = await loadOrBuildRepoGroundingIndex(root);

    expect(rebuilt.sourceFingerprint).not.toBe(initial.sourceFingerprint);
    expect(rebuilt.files).not.toEqual(initial.files);
  });
});

function pathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}
