// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

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
});
