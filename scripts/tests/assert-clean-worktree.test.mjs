import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getDirtyPaths } from "../assert-clean-worktree.mjs";

const scriptPath = fileURLToPath(
  new URL("../assert-clean-worktree.mjs", import.meta.url),
);

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

function createGitRepo(t) {
  const repo = mkdtempSync(path.join(tmpdir(), "martin-clean-guard-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  assert.equal(run("git", ["init", "--quiet"], repo).status, 0);
  writeFileSync(path.join(repo, "tracked.txt"), "baseline\n");
  assert.equal(run("git", ["add", "tracked.txt"], repo).status, 0);
  assert.equal(
    run(
      "git",
      [
        "-c",
        "user.name=MartinLoop Tests",
        "-c",
        "user.email=tests@martinloop.local",
        "commit",
        "--quiet",
        "-m",
        "baseline",
      ],
      repo,
    ).status,
    0,
  );

  return repo;
}

test("clean repository passes both the exported guard and CLI", (t) => {
  const repo = createGitRepo(t);

  assert.deepEqual(getDirtyPaths(repo), []);
  const result = run(process.execPath, [scriptPath, repo], repo);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /worktree clean/i);
});

test("tracked and untracked dirtiness fail with concise paths", (t) => {
  const repo = createGitRepo(t);
  writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
  writeFileSync(path.join(repo, "untracked.txt"), "new\n");

  assert.deepEqual(getDirtyPaths(repo), ["tracked.txt", "untracked.txt"]);
  const result = run(process.execPath, [scriptPath, repo], repo);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /tracked\.txt/);
  assert.match(result.stderr, /untracked\.txt/);
  assert.doesNotMatch(result.stderr, /\?\?| M /);
});
