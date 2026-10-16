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

function git(directory: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "martin-rollback-commit-"));
  temporaryDirectories.push(directory);
  git(directory, "init", "-q");
  git(directory, "config", "user.email", "rollback@test.invalid");
  git(directory, "config", "user.name", "Rollback Test");
  git(directory, "config", "core.autocrlf", "false");
  await writeFile(join(directory, "tracked.txt"), "committed\n", "utf8");
  await writeFile(join(directory, ".gitignore"), "secrets/\nnode_modules/\n.env\n", "utf8");
  git(directory, "add", "-A");
  git(directory, "commit", "-q", "-m", "fixture");
  return directory;
}

const capturedAt = "2026-10-15T00:00:00.000Z";
const restoredAt = "2026-10-15T00:00:01.000Z";

describe("rollback boundary: attempt commits", () => {
  it("reports files an attempt changed and then committed", async () => {
    const directory = await createRepository();
    const boundary = await captureRollbackBoundary({ repoRoot: directory, capturedAt });

    await writeFile(join(directory, "tracked.txt"), "agent edit\n", "utf8");
    await writeFile(join(directory, "agent-new.txt"), "new\n", "utf8");
    git(directory, "add", "-A");
    git(directory, "commit", "-q", "-m", "agent commit");

    expect(listAttemptChangedFilesSinceBoundary({ repoRoot: directory, boundary })).toEqual([
      "agent-new.txt",
      "tracked.txt"
    ]);
  });

  it("rewinds attempt commits and restores the committed baseline on discard", async () => {
    const directory = await createRepository();
    const baselineHead = git(directory, "rev-parse", "HEAD");
    const boundary = await captureRollbackBoundary({ repoRoot: directory, capturedAt });

    await writeFile(join(directory, "tracked.txt"), "agent edit\n", "utf8");
    await writeFile(join(directory, "agent-new.txt"), "new\n", "utf8");
    git(directory, "add", "-A");
    git(directory, "commit", "-q", "-m", "agent commit");

    const outcome = await restoreRollbackBoundary({
      repoRoot: directory,
      boundary,
      restoredAt,
      decision: "DISCARD"
    });

    expect(outcome?.status).toBe("restored");
    expect(git(directory, "rev-parse", "HEAD")).toBe(baselineHead);
    expect(git(directory, "status", "--porcelain")).toBe("");
    await expect(readFile(join(directory, "tracked.txt"), "utf8")).resolves.toBe("committed\n");
    await expect(readFile(join(directory, "agent-new.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a staged new file on discard", async () => {
    const directory = await createRepository();
    const boundary = await captureRollbackBoundary({ repoRoot: directory, capturedAt });

    await writeFile(join(directory, "staged-new.txt"), "new\n", "utf8");
    git(directory, "add", "staged-new.txt");

    const outcome = await restoreRollbackBoundary({
      repoRoot: directory,
      boundary,
      restoredAt,
      decision: "DISCARD"
    });

    expect(outcome?.status).toBe("restored");
    expect(git(directory, "status", "--porcelain")).toBe("");
  });

  it("keeps an unchanged HEAD and leaves the workspace alone when nothing changed", async () => {
    const directory = await createRepository();
    const boundary = await captureRollbackBoundary({ repoRoot: directory, capturedAt });

    const outcome = await restoreRollbackBoundary({
      repoRoot: directory,
      boundary,
      restoredAt,
      decision: "DISCARD"
    });

    expect(outcome?.status).toBe("not_required");
  });
});

describe("rollback boundary: ignored files", () => {
  it("lists ignored files an attempt created or modified, but not pre-existing ones", async () => {
    const directory = await createRepository();
    await mkdir(join(directory, "secrets"), { recursive: true });
    await writeFile(join(directory, "secrets", "operator.txt"), "operator\n", "utf8");
    await writeFile(join(directory, ".env"), "A=1\n", "utf8");
    const boundary = await captureRollbackBoundary({ repoRoot: directory, capturedAt });

    await writeFile(join(directory, "secrets", "token.txt"), "stolen\n", "utf8");
    await writeFile(join(directory, ".env"), "A=1\nB=22\n", "utf8");

    expect(listIgnoredFileChangesSinceBoundary({ repoRoot: directory, boundary })).toEqual({
      created: ["secrets/token.txt"],
      modified: [".env"]
    });
  });

  it("reports a new dependency directory only as a collapsed entry", async () => {
    const directory = await createRepository();
    const boundary = await captureRollbackBoundary({ repoRoot: directory, capturedAt });

    await mkdir(join(directory, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(directory, "node_modules", "pkg", "server.key"), "fixture\n", "utf8");

    expect(listIgnoredFileChangesSinceBoundary({ repoRoot: directory, boundary })).toEqual({
      created: ["node_modules/"],
      modified: []
    });
  });

  it("returns no ignored changes for a legacy boundary without an ignored inventory", async () => {
    const directory = await createRepository();
    const boundary = await captureRollbackBoundary({ repoRoot: directory, capturedAt });
    const legacy = { ...boundary!, ignoredFiles: undefined };
    await writeFile(join(directory, ".env"), "X=1\n", "utf8");

    expect(listIgnoredFileChangesSinceBoundary({ repoRoot: directory, boundary: legacy })).toEqual({
      created: [],
      modified: []
    });
  });

  it("removes only the named attempt-created ignored paths on restore", async () => {
    const directory = await createRepository();
    await mkdir(join(directory, "secrets"), { recursive: true });
    await writeFile(join(directory, "secrets", "operator.txt"), "operator\n", "utf8");
    const boundary = await captureRollbackBoundary({ repoRoot: directory, capturedAt });

    await writeFile(join(directory, "secrets", "token.txt"), "stolen\n", "utf8");

    const outcome = await restoreRollbackBoundary({
      repoRoot: directory,
      boundary,
      restoredAt,
      decision: "ESCALATE",
      removePaths: ["secrets/token.txt"]
    });

    expect(outcome?.deletedFiles).toContain("secrets/token.txt");
    await expect(readFile(join(directory, "secrets", "token.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(directory, "secrets", "operator.txt"), "utf8")).resolves.toBe("operator\n");
  });

  it("captures a boundary when an ignored tree lists more than Git's default 1 MiB of output", async () => {
    const directory = await createRepository();
    const bulk = join(directory, "secrets", "bulk");
    await mkdir(bulk, { recursive: true });
    const pad = "x".repeat(120);
    const names = Array.from({ length: 9_000 }, (_, index) => `${pad}-${String(index).padStart(5, "0")}.txt`);
    for (let offset = 0; offset < names.length; offset += 300) {
      await Promise.all(names.slice(offset, offset + 300).map((name) => writeFile(join(bulk, name), "x", "utf8")));
    }

    const boundary = await captureRollbackBoundary({ repoRoot: directory, capturedAt });

    expect(boundary?.ignoredFiles?.length).toBeGreaterThan(0);
    expect(listIgnoredFileChangesSinceBoundary({ repoRoot: directory, boundary }).created).toEqual([]);
  }, 60_000);
});
