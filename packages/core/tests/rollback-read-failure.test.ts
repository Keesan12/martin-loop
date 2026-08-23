import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]).endsWith("tracked.txt")) {
        throw Object.assign(new Error("permission denied by test boundary"), { code: "EACCES" });
      }
      return actual.readFile(...args);
    }
  };
});

import { captureRollbackBoundary } from "../src/rollback.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

it("fails closed when a dirty-file snapshot cannot be read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "martin-rollback-unreadable-"));
  temporaryDirectories.push(directory);
  expect(spawnSync("git", ["init"], { cwd: directory }).status).toBe(0);
  expect(spawnSync("git", ["config", "user.email", "rollback@test.invalid"], { cwd: directory }).status).toBe(0);
  expect(spawnSync("git", ["config", "user.name", "Rollback Test"], { cwd: directory }).status).toBe(0);
  const trackedPath = join(directory, "tracked.txt");
  await writeFile(trackedPath, "committed\n", "utf8");
  expect(spawnSync("git", ["add", "tracked.txt"], { cwd: directory }).status).toBe(0);
  expect(spawnSync("git", ["commit", "-m", "fixture"], { cwd: directory }).status).toBe(0);
  await writeFile(trackedPath, "operator edit\n", "utf8");

  await expect(
    captureRollbackBoundary({ repoRoot: directory, capturedAt: "2026-08-22T00:00:00.000Z" })
  ).rejects.toThrow(/Rollback snapshot unavailable.*EACCES|permission denied/u);
  const preserved = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", trackedPath],
    { encoding: "utf8" }
  );
  expect(preserved.status).toBe(0);
  expect(preserved.stdout).toBe("operator edit\n");
});
