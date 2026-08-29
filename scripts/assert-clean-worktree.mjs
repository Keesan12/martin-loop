#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function getDirtyPaths(repoRoot = process.cwd()) {
  const result = spawnSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    const detail = result.stderr.trim() || `git exited ${result.status}`;
    throw new Error(`Unable to inspect worktree: ${detail}`);
  }

  const records = result.stdout.split("\0");
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;

    const status = record.slice(0, 2);
    paths.push(record.slice(3));
    if (status.includes("R") || status.includes("C")) index += 1;
  }

  return paths.sort((left, right) => left.localeCompare(right));
}

export function assertCleanWorktree(repoRoot = process.cwd()) {
  const dirtyPaths = getDirtyPaths(repoRoot);
  if (dirtyPaths.length > 0) {
    throw new Error(
      `Worktree dirty (${dirtyPaths.length} paths):\n${dirtyPaths.join("\n")}`,
    );
  }
}

function runCli() {
  const repoRoot = path.resolve(process.argv[2] ?? process.cwd());
  try {
    assertCleanWorktree(repoRoot);
    process.stdout.write("Worktree clean\n");
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

const isDirectInvocation =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectInvocation) runCli();
