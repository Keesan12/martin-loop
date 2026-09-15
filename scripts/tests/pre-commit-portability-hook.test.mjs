import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { installGitPortabilityHook } from "../hooks/install-git-portability-hook.mjs";

const execFileAsync = promisify(execFile);

function resolveShell() {
  if (process.platform === "win32") {
    const gitExecPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
    const gitShell = path.resolve(gitExecPath, "..", "..", "..", "bin", "sh.exe");
    if (existsSync(gitShell)) {
      return gitShell;
    }
  }
  const locator = process.platform === "win32" ? "where.exe" : "which";
  for (const name of process.platform === "win32" ? ["bash.exe", "sh.exe"] : ["sh", "bash"]) {
    try {
      return execFileSync(locator, [name], { encoding: "utf8" }).split(/\r?\n/u)[0].trim();
    } catch {
      // Try the next supported shell.
    }
  }
  throw new Error("A POSIX shell is required to exercise the git hook.");
}

async function createRepository() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "martin-precommit-hook-"));
  await execFileAsync("git", ["init"], { cwd: rootDir });
  await execFileAsync("git", ["config", "user.email", "hook-test@example.invalid"], { cwd: rootDir });
  await execFileAsync("git", ["config", "user.name", "Hook Test"], { cwd: rootDir });
  const scannerDir = path.join(rootDir, "scripts", "hooks");
  await mkdir(scannerDir, { recursive: true });
  await copyFile(
    new URL("../hooks/pre-commit-portability-scan.mjs", import.meta.url),
    path.join(scannerDir, "pre-commit-portability-scan.mjs"),
  );
  return rootDir;
}

async function runHook(rootDir, env = process.env) {
  const hookPath = await installGitPortabilityHook({ rootDir });
  try {
    const result = await execFileAsync(resolveShell(), [hookPath], { cwd: rootDir, env });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function createPathWithoutGrep() {
  const binDir = await mkdtemp(path.join(os.tmpdir(), "martin-no-grep-path-"));
  const gitPath = execFileSync(process.platform === "win32" ? "where.exe" : "which", ["git"], { encoding: "utf8" })
    .split(/\r?\n/u)[0]
    .trim();
  if (process.platform === "win32") {
    return {
      binDir,
      value: [path.dirname(process.execPath), path.dirname(gitPath), path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")].join(path.delimiter),
    };
  }
  await symlink(process.execPath, path.join(binDir, "node"));
  await symlink(gitPath, path.join(binDir, "git"));
  return { binDir, value: binDir };
}

test("pre-commit hook runs successfully when grep is absent", async () => {
  const rootDir = await createRepository();
  const noGrepPath = await createPathWithoutGrep();
  try {
    await writeFile(path.join(rootDir, "README.md"), "# Portable without grep\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: rootDir });
    const result = await runHook(rootDir, { ...process.env, PATH: noGrepPath.value, Path: noGrepPath.value });
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Portability check passed/u);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(noGrepPath.binDir, { recursive: true, force: true });
  }
});

test("pre-commit hook fails closed when its managed scanner cannot launch", async () => {
  const rootDir = await createRepository();
  const emptyPath = await mkdtemp(path.join(os.tmpdir(), "martin-empty-hook-path-"));
  try {
    const result = await runHook(rootDir, { ...process.env, PATH: emptyPath, Path: emptyPath });
    assert.notEqual(result.exitCode, 0);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Portability check passed/u);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(emptyPath, { recursive: true, force: true });
  }
});

test("pre-commit hook passes only after all required scans run", async () => {
  const rootDir = await createRepository();
  try {
    await writeFile(path.join(rootDir, "README.md"), "# Portable\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: rootDir });
    const result = await runHook(rootDir);
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Portability check passed/u);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("pre-commit hook blocks staged internal paths and content", async () => {
  const rootDir = await createRepository();
  try {
    // Build the path from segments to avoid triggering the portability scanner on this source file.
    const internalDir = path.join(rootDir, "docs", "internal");
    const internalNote = path.join(internalDir, "note.md");
    const internalGitPath = ["docs", "internal", "note.md"].join("/");
    await mkdir(internalDir, { recursive: true });
    await writeFile(internalNote, "private\n", "utf8");
    await writeFile(path.join(rootDir, "README.md"), "See C:\\Users\\dev\\internal-project for setup\n", "utf8");
    await execFileAsync("git", ["add", internalGitPath, "README.md"], { cwd: rootDir });
    const result = await runHook(rootDir);
    assert.notEqual(result.exitCode, 0);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Portability check passed/u);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("installer writes the tracked hook authority idempotently", async () => {
  const rootDir = await createRepository();
  try {
    const firstPath = await installGitPortabilityHook({ rootDir });
    const first = await readFile(firstPath, "utf8");
    const secondPath = await installGitPortabilityHook({ rootDir });
    const second = await readFile(secondPath, "utf8");
    assert.equal(secondPath, firstPath);
    assert.equal(second, first);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
