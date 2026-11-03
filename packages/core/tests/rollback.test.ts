import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureRollbackBoundary,
  listAttemptChangedFilesSinceBoundary,
  listIgnoredFileChangesSinceBoundary,
  restoreRollbackBoundary
} from "../src/rollback.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "martin-rollback-"));
  temporaryDirectories.push(directory);
  expect(spawnSync("git", ["init"], { cwd: directory }).status).toBe(0);
  expect(spawnSync("git", ["config", "user.email", "rollback@test.invalid"], { cwd: directory }).status).toBe(0);
  expect(spawnSync("git", ["config", "user.name", "Rollback Test"], { cwd: directory }).status).toBe(0);
  await writeFile(join(directory, "tracked.txt"), "committed\n", "utf8");
  expect(spawnSync("git", ["add", "tracked.txt"], { cwd: directory }).status).toBe(0);
  expect(spawnSync("git", ["commit", "-m", "fixture"], { cwd: directory }).status).toBe(0);
  return directory;
}

describe("rollback boundary safety", () => {
  it("fails closed when Git inventory cannot be read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-not-a-repo-"));
    temporaryDirectories.push(directory);

    await expect(
      captureRollbackBoundary({ repoRoot: directory, capturedAt: "2026-08-22T00:00:00.000Z" })
    ).rejects.toThrow(/Git rollback state unavailable/u);
    expect(() => listAttemptChangedFilesSinceBoundary({ repoRoot: directory })).toThrow(
      /Git rollback state unavailable/u
    );
  });

  it("refuses restore before mutation when current Git inventory is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-not-a-repo-"));
    temporaryDirectories.push(directory);
    const protectedPath = join(directory, "operator.txt");
    await writeFile(protectedPath, "keep me", "utf8");

    await expect(
      restoreRollbackBoundary({
        repoRoot: directory,
        restoredAt: "2026-08-22T00:00:01.000Z",
        decision: "DISCARD",
        boundary: {
          strategy: "git_head_plus_snapshot",
          capturedAt: "2026-08-22T00:00:00.000Z",
          trackedDirtyFiles: [],
          untrackedFiles: [],
          snapshots: []
        }
      })
    ).rejects.toThrow(/Git rollback state unavailable/u);
    await expect(readFile(protectedPath, "utf8")).resolves.toBe("keep me");
  });

  it("preserves operator changes and removes only attempt-created state", async () => {
    const directory = await createRepository();
    await writeFile(join(directory, "tracked.txt"), "operator edit\n", "utf8");
    await writeFile(join(directory, "operator-untracked.txt"), "operator file\n", "utf8");

    const boundary = await captureRollbackBoundary({
      repoRoot: directory,
      capturedAt: "2026-08-22T00:00:00.000Z"
    });
    expect(boundary?.trackedDirtyFiles).toEqual(["tracked.txt"]);
    expect(boundary?.untrackedFiles).toEqual(["operator-untracked.txt"]);

    await writeFile(join(directory, "tracked.txt"), "attempt edit\n", "utf8");
    await writeFile(join(directory, "attempt-created.txt"), "remove me\n", "utf8");

    expect(
      listAttemptChangedFilesSinceBoundary({ repoRoot: directory, boundary })
    ).toEqual(["attempt-created.txt"]);

    const outcome = await restoreRollbackBoundary({
      repoRoot: directory,
      boundary,
      restoredAt: "2026-08-22T00:00:01.000Z",
      decision: "DISCARD"
    });

    expect(outcome?.status).toBe("restored");
    await expect(readFile(join(directory, "tracked.txt"), "utf8")).resolves.toBe("operator edit\n");
    await expect(readFile(join(directory, "operator-untracked.txt"), "utf8")).resolves.toBe("operator file\n");
    await expect(readFile(join(directory, "attempt-created.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists exact Martin-owned exclusions while similarly named user paths remain observable", async () => {
    const directory = await createRepository();
    await writeFile(
      join(directory, ".gitignore"),
      ".martin-runs/\n.martin-receipt-integrity/\n",
      "utf8"
    );
    expect(spawnSync("git", ["add", ".gitignore"], { cwd: directory }).status).toBe(0);
    expect(spawnSync("git", ["commit", "-m", "ignore managed roots"], { cwd: directory }).status).toBe(0);

    const runsRoot = join(directory, ".martin-runs");
    const integrityRoot = join(directory, ".martin-receipt-integrity");
    await mkdir(join(runsRoot, ".execution-leases"), { recursive: true });
    await mkdir(integrityRoot, { recursive: true });
    const leasePath = join(runsRoot, ".execution-leases", "active.json");
    const keyPath = join(integrityRoot, "active.key");
    await writeFile(leasePath, "lease-0", "utf8");
    await writeFile(keyPath, "key-0", "utf8");

    const captured = await captureRollbackBoundary({
      repoRoot: directory,
      capturedAt: "2026-08-22T00:00:00.000Z",
      managedRoots: [runsRoot, integrityRoot]
    });
    const boundary = JSON.parse(JSON.stringify(captured)) as NonNullable<typeof captured>;
    expect(boundary.managedPathExclusions).toEqual([
      ".martin-receipt-integrity",
      ".martin-runs"
    ]);
    expect(boundary.ignoredFiles).toEqual([]);
    // Persisted/resumed boundaries must apply exclusions to every field, even
    // when older or externally loaded material contains a managed snapshot.
    boundary.snapshots.push({
      path: ".martin-receipt-integrity/new.key",
      existed: false,
      encoding: "base64"
    });

    await mkdir(join(directory, ".martin-runs-user"), { recursive: true });
    await writeFile(join(directory, ".martin-runs-user", "operator.txt"), "observable", "utf8");
    await writeFile(join(runsRoot, "run.json"), "managed", "utf8");
    await writeFile(join(integrityRoot, "new.key"), "managed", "utf8");

    expect(listAttemptChangedFilesSinceBoundary({
      repoRoot: directory,
      boundary,
      managedRoots: [runsRoot, integrityRoot]
    })).toEqual([
      ".martin-runs-user/operator.txt"
    ]);
    expect(listIgnoredFileChangesSinceBoundary({
      repoRoot: directory,
      boundary,
      managedRoots: [runsRoot, integrityRoot]
    })).toEqual({
      created: [],
      modified: []
    });

    let heartbeat = 0;
    const timer = setInterval(() => {
      heartbeat += 1;
      void writeFile(leasePath, `lease-${String(heartbeat)}`, "utf8").catch(() => undefined);
    }, 5);
    try {
      const outcome = await restoreRollbackBoundary({
        repoRoot: directory,
        boundary,
        managedRoots: [runsRoot, integrityRoot],
        restoredAt: "2026-08-22T00:00:01.000Z",
        decision: "DISCARD"
      });
      expect(outcome?.status).toBe("restored");
    } finally {
      clearInterval(timer);
    }

    await expect(readFile(leasePath, "utf8")).resolves.toMatch(/^lease-/u);
    await expect(readFile(keyPath, "utf8")).resolves.toBe("key-0");
    await expect(readFile(join(integrityRoot, "new.key"), "utf8")).resolves.toBe("managed");
    await expect(
      readFile(join(directory, ".martin-runs-user", "operator.txt"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects persisted exclusion authority in direct observation and restore APIs", async () => {
    const directory = await createRepository();
    const boundary = await captureRollbackBoundary({
      repoRoot: directory,
      capturedAt: "2026-08-22T00:00:00.000Z"
    });
    expect(boundary).toBeDefined();
    boundary!.managedPathExclusions = ["src"];
    boundary!.ignoredFiles = undefined;

    expect(() => listAttemptChangedFilesSinceBoundary({
      repoRoot: directory,
      boundary
    })).toThrow(/managed path exclusions do not match the configured MartinLoop roots/u);
    expect(() => listIgnoredFileChangesSinceBoundary({
      repoRoot: directory,
      boundary
    })).toThrow(/managed path exclusions do not match the configured MartinLoop roots/u);
    await expect(restoreRollbackBoundary({
      repoRoot: directory,
      boundary,
      restoredAt: "2026-08-22T00:00:01.000Z",
      decision: "DISCARD"
    })).rejects.toThrow(/managed path exclusions do not match the configured MartinLoop roots/u);
  });

  it("contains no POSIX-only sleep subprocess", async () => {
    const source = await readFile(new URL("../src/rollback.ts", import.meta.url), "utf8");
    expect(source).not.toContain('spawnSync("sleep"');
  });
});
