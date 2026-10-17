import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureRollbackBoundary,
  findEscapingLinks,
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

function git(directory: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

/** `outside/precious.txt` sits next to the governed repo at `outside/repo`. */
async function createRepositoryWithNeighbour(): Promise<{ outside: string; repo: string }> {
  const outside = await mkdtemp(join(tmpdir(), "martin-rollback-links-"));
  temporaryDirectories.push(outside);
  await writeFile(join(outside, "precious.txt"), "keep\n", "utf8");
  const repo = join(outside, "repo");
  await mkdir(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "links@test.invalid");
  git(repo, "config", "user.name", "Links Test");
  git(repo, "config", "core.autocrlf", "false");
  await writeFile(join(repo, "tracked.txt"), "committed\n", "utf8");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  return { outside, repo };
}

const capturedAt = "2026-10-15T00:00:00.000Z";
const restoredAt = "2026-10-15T00:00:01.000Z";

describe("rollback never follows attempt-created links", () => {
  it("removes an attempt-created junction without deleting anything it points to", async () => {
    const { outside, repo } = await createRepositoryWithNeighbour();
    const boundary = await captureRollbackBoundary({ repoRoot: repo, capturedAt });

    await symlink(outside, join(repo, "parent-link"), "junction");

    const outcome = await restoreRollbackBoundary({ repoRoot: repo, boundary, restoredAt, decision: "DISCARD" });

    await expect(readFile(join(outside, "precious.txt"), "utf8")).resolves.toBe("keep\n");
    await expect(readFile(join(repo, "tracked.txt"), "utf8")).resolves.toBe("committed\n");
    await expect(lstat(join(repo, "parent-link"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(outcome?.deletedFiles).toEqual(["parent-link"]);
    expect(outcome?.status).toBe("restored");
  });

  it("reports links that resolve outside the repository", async () => {
    const { outside, repo } = await createRepositoryWithNeighbour();
    await symlink(outside, join(repo, "parent-link"), "junction");
    await mkdir(join(repo, "src"));
    await symlink(join(repo, "src"), join(repo, "inner-link"), "junction");

    expect(
      findEscapingLinks(repo, ["parent-link/precious.txt", "parent-link/repo/tracked.txt", "inner-link/a.ts", "src/b.ts"])
    ).toEqual(["parent-link"]);
  });

  it("collapses a nested attempt-created junction to the junction itself", async () => {
    const { outside, repo } = await createRepositoryWithNeighbour();
    const boundary = await captureRollbackBoundary({ repoRoot: repo, capturedAt });
    await mkdir(join(repo, "nested"));
    await symlink(outside, join(repo, "nested", "escape"), "junction");

    const outcome = await restoreRollbackBoundary({ repoRoot: repo, boundary, restoredAt, decision: "DISCARD" });

    await expect(readFile(join(outside, "precious.txt"), "utf8")).resolves.toBe("keep\n");
    await expect(lstat(join(repo, "nested", "escape"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(outcome?.deletedFiles).toContain("nested/escape");
    expect(outcome?.status).toBe("restored");
  });

  it("treats a dangling junction as escaping without resolving its target", async () => {
    const { outside, repo } = await createRepositoryWithNeighbour();
    const vanishedTarget = join(outside, "vanished");
    await mkdir(vanishedTarget);
    await symlink(vanishedTarget, join(repo, "dangling"), "junction");
    await rm(vanishedTarget, { recursive: true, force: true });

    expect(findEscapingLinks(repo, ["dangling/unknown.txt"])).toEqual(["dangling"]);
    await expect(readFile(join(outside, "precious.txt"), "utf8")).resolves.toBe("keep\n");
  });

  it("does not classify a link back to the repository root as escaping", async () => {
    const { repo } = await createRepositoryWithNeighbour();
    await symlink(repo, join(repo, "self-link"), "junction");

    expect(findEscapingLinks(repo, ["self-link/tracked.txt"])).toEqual([]);
  });

  it("refuses to restore a snapshot through a leaf link swapped in after capture", async () => {
    const { outside, repo } = await createRepositoryWithNeighbour();
    await writeFile(join(repo, "dirty.txt"), "operator baseline\n", "utf8");
    const boundary = await captureRollbackBoundary({ repoRoot: repo, capturedAt });

    await rm(join(repo, "dirty.txt"));
    await symlink(outside, join(repo, "dirty.txt"), "junction");
    const outcome = await restoreRollbackBoundary({ repoRoot: repo, boundary, restoredAt, decision: "DISCARD" });

    expect(outcome?.status).toBe("failed");
    await expect(readFile(join(outside, "precious.txt"), "utf8")).resolves.toBe("keep\n");
    expect((await lstat(join(repo, "dirty.txt"))).isSymbolicLink()).toBe(true);
  });

  it("refuses Git restoration through an intermediate junction", async () => {
    const { outside, repo } = await createRepositoryWithNeighbour();
    await mkdir(join(repo, "tracked"));
    await writeFile(join(repo, "tracked", "precious.txt"), "repo baseline\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "tracked directory");
    const boundary = await captureRollbackBoundary({ repoRoot: repo, capturedAt });

    await rename(join(repo, "tracked"), join(repo, "tracked-original"));
    await symlink(outside, join(repo, "tracked"), "junction");
    const outcome = await restoreRollbackBoundary({ repoRoot: repo, boundary, restoredAt, decision: "DISCARD" });

    expect(outcome?.status).toBe("failed");
    await expect(readFile(join(outside, "precious.txt"), "utf8")).resolves.toBe("keep\n");
  });

  it("leaves a pre-existing link and its target untouched", async () => {
    const { outside, repo } = await createRepositoryWithNeighbour();
    await symlink(outside, join(repo, "operator-link"), "junction");
    const boundary = await captureRollbackBoundary({ repoRoot: repo, capturedAt });

    await writeFile(join(repo, "attempt.txt"), "remove me\n", "utf8");
    const outcome = await restoreRollbackBoundary({ repoRoot: repo, boundary, restoredAt, decision: "DISCARD" });

    expect((await lstat(join(repo, "operator-link"))).isSymbolicLink()).toBe(true);
    await expect(readFile(join(outside, "precious.txt"), "utf8")).resolves.toBe("keep\n");
    await expect(readFile(join(repo, "attempt.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(outcome?.status).toBe("restored");
  });
});
