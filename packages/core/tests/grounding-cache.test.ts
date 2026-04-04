import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
});

function pathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}
