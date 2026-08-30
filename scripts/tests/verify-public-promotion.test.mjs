// Tests for scripts/verify-public-promotion.mjs
// Run: node --test scripts/tests/verify-public-promotion.test.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const SCRIPT = resolve(import.meta.dirname, "..", "verify-public-promotion.mjs");

function makeGitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "public-staging/test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "test");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  return sha;
}

function runScript(dir, env = {}) {
  const result = spawnSync("node", [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function writeManifest(dir, manifest) {
  mkdirSync(join(dir, ".martin"), { recursive: true });
  writeFileSync(join(dir, ".martin", "promotion-manifest.json"), JSON.stringify(manifest));
}

function validManifest(sha) {
  return {
    schemaVersion: "martin.public-promotion.v1",
    privateRepository: "martin-Loop/ML_Core_OSS_Internal",
    privateMergeSha: sha,
    privateMainShaValidated: sha,
    publicBaseSha: sha,
    promotedBy: "test-agent",
    validatedAt: new Date().toISOString(),
    internalHealthPassed: true,
  };
}

const TMP = join(tmpdir(), `promo-guard-test-${Date.now()}`);

describe("verify-public-promotion", () => {
  let sha;
  let repoDir;

  // Setup: one real git repo reused across tests
  test("setup", () => {
    repoDir = join(TMP, "repo");
    sha = makeGitRepo(repoDir);
    assert.ok(sha, "git SHA required");
  });

  test("missing manifest blocks", () => {
    const dir = join(TMP, "no-manifest");
    sha = makeGitRepo(dir);
    const { code, stderr } = runScript(dir, { GITHUB_ACTIONS: "true" });
    assert.equal(code, 1);
    assert.ok(stderr.includes("BLOCKED"));
  });

  test("wrong schemaVersion blocks", () => {
    writeManifest(repoDir, { ...validManifest(sha), schemaVersion: "wrong" });
    const { code, stderr } = runScript(repoDir, { GITHUB_ACTIONS: "true" });
    assert.equal(code, 1);
    assert.ok(stderr.includes("unsupported promotion manifest schema"));
  });

  test("wrong privateRepository blocks", () => {
    writeManifest(repoDir, { ...validManifest(sha), privateRepository: "wrong/repo" });
    const { code, stderr } = runScript(repoDir, { GITHUB_ACTIONS: "true" });
    assert.equal(code, 1);
    assert.ok(stderr.includes("privateRepository"));
  });

  test("malformed privateMergeSha blocks", () => {
    writeManifest(repoDir, { ...validManifest(sha), privateMergeSha: "abc123" });
    const { code, stderr } = runScript(repoDir, { GITHUB_ACTIONS: "true" });
    assert.equal(code, 1);
    assert.ok(stderr.includes("privateMergeSha"));
  });

  test("internalHealthPassed=false blocks", () => {
    writeManifest(repoDir, { ...validManifest(sha), internalHealthPassed: false });
    const { code, stderr } = runScript(repoDir, { GITHUB_ACTIONS: "true" });
    assert.equal(code, 1);
    assert.ok(stderr.includes("internalHealthPassed"));
  });

  test("valid manifest on public-staging branch passes", () => {
    const dir = join(TMP, "valid");
    const s = makeGitRepo(dir);
    writeManifest(dir, validManifest(s));
    // branch is already public-staging/test from makeGitRepo
    const { code, stdout } = runScript(dir);
    assert.equal(code, 0, stdout);
    assert.ok(stdout.includes("[public-promotion-guard] PASS"));
  });

  test("conflict markers block", () => {
    const dir = join(TMP, "conflict");
    makeGitRepo(dir);
    const s = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    writeManifest(dir, validManifest(s));
    writeFileSync(join(dir, "conflict.txt"), "<<<<<<< HEAD\nfoo\n=======\nbar\n>>>>>>> other\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add conflict"], { cwd: dir, stdio: "ignore" });
    const s2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    writeManifest(dir, validManifest(s2));
    const { code, stderr } = runScript(dir);
    assert.equal(code, 1);
    assert.ok(stderr.includes("conflict markers"));
  });

  test("cleanup", () => {
    try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  });
});
