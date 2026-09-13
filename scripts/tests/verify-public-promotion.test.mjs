// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { SURFACE_SCHEMA, hashSurface, isReleaseSurfacePath, listSurfaceEntries, sha256, surfaceSpecHash } from "../lib/public-release-surface.mjs";

const SCRIPT = resolve(import.meta.dirname, "..", "verify-public-promotion.mjs");
const GENERATOR = resolve(import.meta.dirname, "..", "generate-public-promotion-manifest.mjs");
const TMP = join(tmpdir(), `promo-guard-test-${process.pid}-${Date.now()}`);
let repo;
let baseSha;
function git(args) { return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function commit(message) { git(["add", "."]); git(["commit", "-m", message]); return git(["rev-parse", "HEAD"]); }
function write(path, content) { const target = join(repo, ...path.split("/")); mkdirSync(resolve(target, ".."), { recursive: true }); writeFileSync(target, content); }
function manifest(entries = listSurfaceEntries(repo)) { return { schemaVersion: SURFACE_SCHEMA, sourceAuthority: "validated-internal-release-source", sourceRepositoryFingerprint: "04aac733f3b08513fddcc72a9013b9f59cf7919f9a0a3893d0b3d953929826ec", privateMergeSha: baseSha, privateMainShaValidated: baseSha, publicBaseSha: baseSha, promotedBy: "test", validatedAt: new Date().toISOString(), internalHealthPassed: true, internalHealthEvidenceSha256: "e".repeat(64), surfaceSpecHash: surfaceSpecHash(), surfaceHash: hashSurface(entries), surfaceEntries: entries, reviewedDivergences: [] }; }
function run(value) { write(".martin/promotion-manifest.json", `${JSON.stringify(value)}\n`); commit("promotion candidate"); return spawnSync("node", [SCRIPT], { cwd: repo, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "true" } }); }
function reset() { git(["reset", "--hard", baseSha]); }

describe("complete public promotion surface", () => {
  before(() => {
    repo = join(TMP, "repo"); mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-b", "public-staging/test"], { cwd: repo, stdio: "ignore" });
    git(["config", "user.email", "test@example.com"]); git(["config", "user.name", "Test"]);
    git(["remote", "add", "origin", "https://github.com/example/public-release.git"]);
    write("packages/cli/src/index.ts", "export const version = 1;\n");
    write("packages/cli/tests/release.test.ts", "test('release', () => {});\n");
    write("packages/mcp/scripts/smoke.mjs", "export {};\n");
    write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n"); write("package.json", "{}\n");
    baseSha = commit("validated private surface");
  });
  after(() => rmSync(TMP, { recursive: true, force: true }));
  test("unchanged recursively-derived surface passes", () => { const result = run(manifest()); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /PASS/u); reset(); });
  test("canonical surface defaults to the complete tracked tree", () => {
    for (const path of ["plugins/martinloop/plugin.json", ".github/workflows/martinloop-budget-gate.yml", "tsconfig.base.json", "packages/new-package/file.ts"]) assert.equal(isReleaseSurfacePath(path), true, path);
    assert.equal(isReleaseSurfacePath(".martin/promotion-manifest.json"), false);
  });
  test("manifest generation refuses a non-authority repository even with passing health evidence", () => {
    write("health.json", `${JSON.stringify({ schemaVersion: "martin.internal-health.v1", status: "PASS", validatedReleaseSha: baseSha, commands: [{ command: "pnpm test", exitCode: 0 }] })}\n`);
    const output = join(repo, ".martin", "generated.json");
    const result = spawnSync("node", [GENERATOR, "--private-ref", baseSha, "--public-base", baseSha, "--internal-health-evidence", "health.json", "--output", output], { cwd: repo, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /validated internal release authority/u);
    rmSync(join(repo, "health.json"), { force: true });
    rmSync(output, { force: true });
    reset();
  });
  test("scenario A: stale lockfile is blocked", () => { const expected = manifest(); write("pnpm-lock.yaml", "lockfileVersion: stale\n"); const result = run(expected); assert.equal(result.status, 1); assert.match(result.stderr, /pnpm-lock\.yaml/u); reset(); });
  test("scenario B: stale test or package-smoke file is blocked", () => { const expected = manifest(); write("packages/mcp/scripts/smoke.mjs", "throw new Error('stale');\n"); const result = run(expected); assert.equal(result.status, 1); assert.match(result.stderr, /packages\/mcp\/scripts\/smoke\.mjs/u); reset(); });
  test("scenario C: a newly added surface file is blocked unless reviewed", () => { const expected = manifest(); write("packages/cli/tests/new-release-case.test.ts", "export {};\n"); const result = run(expected); assert.equal(result.status, 1); assert.match(result.stderr, /unreviewed extra/u); reset(); });
  test("reviewed public-only divergence requires exact content hash", () => {
    const expected = manifest(); write("scripts/public-only.mjs", "export {};\n");
    expected.reviewedDivergences = [{ path: "scripts/public-only.mjs", kind: "public-only", privateSha256: null, publicSha256: sha256(Buffer.from("export {};\n")), reason: "public repository integration", reviewedBy: "release-owner" }];
    const result = run(expected); assert.equal(result.status, 0, result.stderr); reset();
  });
});
