import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

const hashAccounting = vi.hoisted(() => ({ bytes: 0 }));

function hashInputByteLength(data: string | NodeJS.ArrayBufferView): number {
  return typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
}

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    createHash: (...args: Parameters<typeof actual.createHash>) => {
      const hash = actual.createHash(...args);
      const update = hash.update.bind(hash);
      type HashUpdateEncoding = Parameters<typeof hash.update>[1];
      hash.update = ((data: string | NodeJS.ArrayBufferView, inputEncoding?: HashUpdateEncoding) => {
        hashAccounting.bytes += hashInputByteLength(data);
        if (typeof data !== "string" || inputEncoding === undefined) {
          return update(data);
        }
        return update(data, inputEncoding);
      }) as typeof hash.update;
      return hash;
    }
  };
});

import { captureRollbackBoundary, listIgnoredFileChangesSinceBoundary } from "../src/rollback.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  hashAccounting.bytes = 0;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function git(repoRoot: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
}

it("bounds aggregate ignored hash I/O and detects later same-size same-mtime tampering", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "martin-hash-budget-"));
  temporaryDirectories.push(repoRoot);
  git(repoRoot, "init", "-q");
  git(repoRoot, "config", "user.email", "hash-budget@test.invalid");
  git(repoRoot, "config", "user.name", "Hash Budget Test");
  git(repoRoot, "config", "core.autocrlf", "false");
  await writeFile(join(repoRoot, ".gitignore"), "ignored/\n", "utf8");
  git(repoRoot, "add", ".gitignore");
  git(repoRoot, "commit", "-q", "-m", "fixture");
  const ignoredRoot = join(repoRoot, "ignored");
  await mkdir(ignoredRoot);
  const paths = ["a.bin", "b.bin", "c.bin"].map((name) => join(ignoredRoot, name));
  for (const path of paths) {
    await writeFile(path, "x", "utf8");
    await truncate(path, 6 * 1024 * 1024);
  }
  const fixedTime = new Date("2026-10-18T00:00:00.000Z");
  await Promise.all(paths.map((path) => utimes(path, fixedTime, fixedTime)));

  const boundary = await captureRollbackBoundary({ repoRoot, capturedAt: fixedTime.toISOString() });
  expect(hashAccounting.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(JSON.stringify(boundary)).not.toContain("sha256");

  await writeFile(paths[2]!, Buffer.alloc(6 * 1024 * 1024, 1));
  await utimes(paths[2]!, fixedTime, fixedTime);
  expect(listIgnoredFileChangesSinceBoundary({ repoRoot, boundary }).modified).toContain("ignored/c.bin");
  expect(hashAccounting.bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
});
