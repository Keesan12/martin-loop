// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  SURFACE_SCHEMA,
  PRIVATE_PROMOTION_NOTES_REF,
  createPublicPromotionBoundary,
  hashSurface,
  isReleaseSurfacePath,
  listSurfaceEntries,
  persistPrivatePromotionNote,
  readPrivatePromotionNote,
  requirePrivatePromotionProof,
  sha256,
  surfaceSpecHash,
  syncPrivatePromotionNotes,
  validatePrivatePromotionRemote,
  validatePrivatePromotionProof,
  validatePublicSurfaceEntries,
} from "../lib/public-release-surface.mjs";
import { internalHealthCommandSetSha256 } from "../lib/internal-health-commands.mjs";

const SCRIPT = resolve(import.meta.dirname, "..", "verify-public-promotion.mjs");
const GENERATOR = resolve(import.meta.dirname, "..", "generate-public-promotion-manifest.mjs");
const PREPARE = resolve(import.meta.dirname, "..", "prepare-public-promotion.mjs");
const PRODUCTION_REPOSITORY_FINGERPRINT = "04aac733f3b08513fddcc72a9013b9f59cf7919f9a0a3893d0b3d953929826ec";
const PRIVATE_REPOSITORY_SLUG = "example-internal/martin-loop-private-fixture";
const PRIVATE_REPOSITORY_FINGERPRINT = sha256(PRIVATE_REPOSITORY_SLUG);
const PRIVATE_REPOSITORY_URL = `https://github.com/${PRIVATE_REPOSITORY_SLUG}.git`;
const TMP = join(tmpdir(), `promo-guard-test-${process.pid}-${Date.now()}`);
let repo;
let baseSha;
function git(args) { return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function commit(message) { git(["add", "."]); git(["commit", "-m", message]); return git(["rev-parse", "HEAD"]); }
function write(path, content) { const target = join(repo, ...path.split("/")); mkdirSync(resolve(target, ".."), { recursive: true }); writeFileSync(target, content); }
function manifest(entries = listSurfaceEntries(repo)) { return { schemaVersion: SURFACE_SCHEMA, sourceAuthority: "validated-internal-release-source", sourceRepositoryFingerprint: PRODUCTION_REPOSITORY_FINGERPRINT, packageVersion: "0.9.0", privateMergeSha: baseSha, privateMainShaValidated: baseSha, publicBaseSha: baseSha, promotedBy: "test", validatedAt: new Date().toISOString(), internalHealthPassed: true, internalHealthEvidenceSha256: "e".repeat(64), surfaceSpecHash: surfaceSpecHash(), publicSurfaceHash: hashSurface(entries), publicSurfaceEntries: entries, reviewedDivergencesCount: 0, reviewedDivergencesHash: sha256("martin.public-promotion.reviewed-divergences.v1\0[]") }; }
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
    write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n"); write("package.json", "{\"version\":\"0.9.0\"}\n");
    baseSha = commit("validated private surface");
    const proofRemote = join(TMP, "proof.git");
    execFileSync("git", ["init", "--bare", proofRemote]);
    git(["config", `url.${pathToFileURL(proofRemote).href}.insteadOf`, PRIVATE_REPOSITORY_URL]);
    git(["remote", "add", "proof", PRIVATE_REPOSITORY_URL]);
    git(["push", "proof", `HEAD:refs/heads/main`]);

    const publicProofRemote = join(TMP, "public-proof.git");
    execFileSync("git", ["init", "--bare", publicProofRemote]);
    const publicRepositoryUrl = "https://github.com/Keesan12/martin-loop.git";
    git(["config", `url.${pathToFileURL(publicProofRemote).href}.insteadOf`, publicRepositoryUrl]);
    git(["remote", "add", "public-proof", publicRepositoryUrl]);
  });
  after(() => rmSync(TMP, { recursive: true, force: true }));
  test("unchanged recursively-derived surface passes", () => { const result = run(manifest()); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /PASS/u); reset(); });
  test("canonical surface defaults to the complete tracked tree", () => {
    for (const path of ["plugins/martinloop/plugin.json", ".github/workflows/martinloop-budget-gate.yml", "tsconfig.base.json", "packages/new-package/file.ts"]) assert.equal(isReleaseSurfacePath(path), true, path);
    assert.equal(isReleaseSurfacePath(".martin/promotion-manifest.json"), false);
    const attemptedReservedPrefix = [".private", "release"].join("-");
    assert.equal(isReleaseSurfacePath(`${attemptedReservedPrefix}/proof.json`), true);
    assert.equal(listSurfaceEntries(repo).some((entry) => entry.path.startsWith(`${attemptedReservedPrefix}/`)), false);
  });
  test("mode-only surface drift is blocked", () => {
    const expected = manifest();
    write(".martin/promotion-manifest.json", `${JSON.stringify(expected)}\n`);
    git(["add", "."]);
    git(["update-index", "--chmod=+x", "packages/cli/src/index.ts"]);
    git(["commit", "-m", "promotion candidate with mode drift"]);
    const result = spawnSync("node", [SCRIPT], { cwd: repo, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "true" } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /packages\/cli\/src\/index\.ts/u);
    reset();
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
  test("manifest generation pins the production authority fingerprint", () => {
    assert.match(readFileSync(GENERATOR, "utf8"), new RegExp(PRODUCTION_REPOSITORY_FINGERPRINT, "u"));
  });
  test("synthetic private remote binding persists a privacy-safe proof", () => {
    const originalOrigin = git(["config", "--get", "remote.origin.url"]);
    git(["remote", "set-url", "origin", PRIVATE_REPOSITORY_URL]);
    const privateEntry = listSurfaceEntries(repo, baseSha).find((entry) => entry.path === "packages/cli/tests/release.test.ts");
    const secretReason = "Distribution boundary reviewed for this fixture.";
    const entries = listSurfaceEntries(repo, baseSha);
    const divergences = [{
      path: privateEntry.path,
      kind: "private-only",
      privateSha256: privateEntry.sha256,
      privateMode: privateEntry.mode,
      publicSha256: null,
      reason: secretReason,
      reviewedBy: "fixture-reviewer",
    }];
    const boundary = createPublicPromotionBoundary(entries, divergences);
    const publicManifest = {
      ...manifest(boundary.publicManifestFields.publicSurfaceEntries),
      sourceRepositoryFingerprint: PRIVATE_REPOSITORY_FINGERPRINT,
      ...boundary.publicManifestFields,
    };
    const record = {
      packageVersion: publicManifest.packageVersion,
      sourceRepositoryFingerprint: PRIVATE_REPOSITORY_FINGERPRINT,
      privateMainShaValidated: baseSha,
      publicBaseSha: baseSha,
      boundary: boundary.privateProof,
    };
    try {
      assert.doesNotThrow(() => validatePrivatePromotionRemote(repo, "proof", PRIVATE_REPOSITORY_FINGERPRINT));
      git(["remote", "add", "private-ssh", `git@github.com:${PRIVATE_REPOSITORY_SLUG}.git`]);
      assert.doesNotThrow(() => validatePrivatePromotionRemote(repo, "private-ssh", PRIVATE_REPOSITORY_FINGERPRINT));
      git(["remote", "add", "split-proof", PRIVATE_REPOSITORY_URL]);
      git(["remote", "set-url", "--add", "--push", "split-proof", "https://github.com/Keesan12/martin-loop.git"]);
      assert.throws(() => validatePrivatePromotionRemote(repo, "split-proof", PRIVATE_REPOSITORY_FINGERPRINT), /private release authority/iu);
      assert.throws(() => validatePrivatePromotionRemote(repo, "public-proof", PRIVATE_REPOSITORY_FINGERPRINT), /private release authority/iu);
      const publicNotes = spawnSync("git", ["--git-dir", join(TMP, "public-proof.git"), "show-ref", "--verify", "--quiet", PRIVATE_PROMOTION_NOTES_REF]);
      assert.equal(publicNotes.status, 1);
      assert.equal(publicManifest.schemaVersion, "martin.public-promotion.v3");
      assert.equal(publicManifest.reviewedDivergencesCount, 1);
      assert.doesNotMatch(JSON.stringify(publicManifest), /packages\/cli\/tests\/release\.test\.ts|Distribution boundary reviewed for this fixture|fixture-reviewer/u);
      persistPrivatePromotionNote(repo, "proof", record, PRIVATE_REPOSITORY_FINGERPRINT);
      syncPrivatePromotionNotes(repo, "proof", PRIVATE_REPOSITORY_FINGERPRINT);
      const privateProof = readPrivatePromotionNote(repo, baseSha);
      assert.match(JSON.stringify(privateProof), /packages\/cli\/tests\/release\.test\.ts/u);
      assert.match(JSON.stringify(privateProof), /Distribution boundary reviewed for this fixture/u);
      const persistedRecord = requirePrivatePromotionProof(privateProof, publicManifest);
      assert.doesNotThrow(() => validatePrivatePromotionProof(persistedRecord.boundary, publicManifest, listSurfaceEntries(repo, baseSha)));
      persistPrivatePromotionNote(repo, "proof", { ...persistedRecord, publicBaseSha: "e".repeat(40) }, PRIVATE_REPOSITORY_FINGERPRINT);
      syncPrivatePromotionNotes(repo, "proof", PRIVATE_REPOSITORY_FINGERPRINT);
      assert.doesNotThrow(() => requirePrivatePromotionProof(readPrivatePromotionNote(repo, baseSha), publicManifest));
      const clone = join(TMP, "clean-clone");
      execFileSync("git", ["clone", "--quiet", "--branch", "main", join(TMP, "proof.git"), clone]);
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: clone });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: clone });
      execFileSync("git", ["config", `url.${pathToFileURL(join(TMP, "proof.git")).href}.insteadOf`, PRIVATE_REPOSITORY_URL], { cwd: clone });
      execFileSync("git", ["remote", "set-url", "origin", PRIVATE_REPOSITORY_URL], { cwd: clone });
      syncPrivatePromotionNotes(clone, "origin", PRIVATE_REPOSITORY_FINGERPRINT);
      const clonedNote = readPrivatePromotionNote(clone, baseSha);
      const clonedProof = requirePrivatePromotionProof(clonedNote, publicManifest);
      assert.doesNotThrow(() => validatePrivatePromotionProof(clonedProof.boundary, publicManifest, listSurfaceEntries(clone, baseSha)));
      const tamperedNote = structuredClone(clonedNote);
      const tamperedProof = requirePrivatePromotionProof(tamperedNote, publicManifest);
      tamperedProof.boundary.reviewedDivergences[0].reason = "Tampered after cloning.";
      execFileSync("git", ["notes", `--ref=${PRIVATE_PROMOTION_NOTES_REF}`, "add", "-f", "-F", "-", baseSha], {
        cwd: clone,
        input: `${JSON.stringify(tamperedNote, null, 2)}\n`,
      });
      execFileSync("git", ["push", "origin", `${PRIVATE_PROMOTION_NOTES_REF}:${PRIVATE_PROMOTION_NOTES_REF}`], { cwd: clone });
      syncPrivatePromotionNotes(clone, "origin", PRIVATE_REPOSITORY_FINGERPRINT);
      const fetchedTamperedProof = requirePrivatePromotionProof(readPrivatePromotionNote(clone, baseSha), publicManifest);
      assert.throws(() => validatePrivatePromotionProof(fetchedTamperedProof.boundary, publicManifest, listSurfaceEntries(clone, baseSha)), /reviewedDivergencesHash/iu);

      const emptyProofRemote = join(TMP, "empty-proof.git");
      execFileSync("git", ["init", "--bare", emptyProofRemote]);
      const emptyProofUrl = `ssh://git@github.com/${PRIVATE_REPOSITORY_SLUG}.git`;
      execFileSync("git", ["config", `url.${pathToFileURL(emptyProofRemote).href}.insteadOf`, emptyProofUrl], { cwd: clone });
      execFileSync("git", ["remote", "add", "empty-proof", emptyProofUrl], { cwd: clone });
      syncPrivatePromotionNotes(clone, "empty-proof", PRIVATE_REPOSITORY_FINGERPRINT);
      assert.throws(() => readPrivatePromotionNote(clone, baseSha), /missing/iu);
    } finally {
      git(["remote", "set-url", "origin", originalOrigin]);
      reset();
    }
  });
  test("canonical health command set has a stable digest", () => {
    assert.match(internalHealthCommandSetSha256(), /^[a-f0-9]{64}$/u);
  });
  test("schema v3 keeps private-only paths, reasons, and reviewers out of the public manifest", () => {
    const entries = [
      { path: "fixtures/omitted-source.txt", mode: "100644", sha256: "a".repeat(64) },
      { path: "packages/cli/src/index.ts", mode: "100644", sha256: "b".repeat(64) },
    ];
    const divergences = [{
      path: entries[0].path,
      kind: "private-only",
      privateSha256: entries[0].sha256,
      privateMode: entries[0].mode,
      publicSha256: null,
      reason: "Distribution boundary reviewed for this fixture.",
      reviewedBy: "fixture-reviewer",
    }];
    const boundary = createPublicPromotionBoundary(entries, divergences);
    const publicJson = JSON.stringify(boundary.publicManifestFields);

    assert.deepEqual(boundary.publicManifestFields.publicSurfaceEntries, [entries[1]]);
    assert.equal(boundary.publicManifestFields.reviewedDivergencesCount, 1);
    assert.match(boundary.publicManifestFields.reviewedDivergencesHash, /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(publicJson, /fixtures\/omitted-source\.txt|Distribution boundary reviewed for this fixture|fixture-reviewer/u);
    assert.deepEqual(boundary.privateProof.reviewedDivergences, divergences);
    assert.doesNotThrow(() => validatePrivatePromotionProof(boundary.privateProof, boundary.publicManifestFields, entries));
    const tamperedProof = structuredClone(boundary.privateProof);
    tamperedProof.reviewedDivergences[0].reason = "A different private rationale.";
    assert.throws(() => validatePrivatePromotionProof(tamperedProof, boundary.publicManifestFields, entries), /reviewedDivergencesHash/iu);
    assert.throws(() => validatePrivatePromotionProof(boundary.privateProof, boundary.publicManifestFields), /requires private surface entries/iu);
  });
  test("the aggregate commitment detects metadata tampering for every divergence kind", () => {
    const entries = [
      { path: "a.txt", mode: "100644", sha256: "a".repeat(64) },
      { path: "b.txt", mode: "100644", sha256: "b".repeat(64) },
    ];
    const divergences = [
      { path: "a.txt", kind: "content", privateSha256: "a".repeat(64), privateMode: "100644", publicSha256: "c".repeat(64), publicMode: "100644", reason: "Reviewed public content differs.", reviewedBy: "reviewer-a" },
      { path: "b.txt", kind: "private-only", privateSha256: "b".repeat(64), privateMode: "100644", publicSha256: null, reason: "Reviewed private boundary file.", reviewedBy: "reviewer-b" },
      { path: "c.txt", kind: "public-only", privateSha256: null, privateMode: null, publicSha256: "d".repeat(64), publicMode: "100644", reason: "Reviewed public integration file.", reviewedBy: "reviewer-c" },
    ];
    const boundary = createPublicPromotionBoundary(entries, divergences);
    for (let index = 0; index < divergences.length; index += 1) {
      for (const field of ["reason", "reviewedBy"]) {
        const tampered = structuredClone(boundary.privateProof);
        tampered.reviewedDivergences[index][field] += "-tampered";
        assert.throws(() => validatePrivatePromotionProof(tampered, boundary.publicManifestFields, entries), /reviewedDivergencesHash/iu, `${divergences[index].kind}:${field}`);
      }
      const extraField = structuredClone(boundary.privateProof);
      extraField.reviewedDivergences[index].uncommittedPrivateMetadata = true;
      assert.throws(() => validatePrivatePromotionProof(extraField, boundary.publicManifestFields, entries), /unsupported fields/iu, `${divergences[index].kind}:extra-field`);
    }
  });
  test("public surface inventory rejects duplicates, unsorted paths, and extra entry fields", () => {
    const a = { path: "a.txt", mode: "100644", sha256: "a".repeat(64) };
    const b = { path: "b.txt", mode: "100644", sha256: "b".repeat(64) };
    assert.throws(() => validatePublicSurfaceEntries([a, a]), /duplicate/iu);
    assert.throws(() => validatePublicSurfaceEntries([b, a]), /sorted/iu);
    assert.throws(() => validatePublicSurfaceEntries([{ ...a, privatePath: ".planning/secret" }]), /fields/iu);
    for (const path of ["./a.txt", "a//b.txt", "a/../b.txt", "a\\b.txt"]) {
      assert.throws(() => validatePublicSurfaceEntries([{ ...a, path }]), /canonical/iu, path);
      assert.throws(() => createPublicPromotionBoundary([a], [{ path, kind: "private-only", privateSha256: a.sha256, privateMode: a.mode, publicSha256: null, reason: "Reviewed private boundary.", reviewedBy: "reviewer" }]), /canonical/iu, path);
    }
  });
  test("promotion preparer derives coordinates and three-way merges reviewed content divergences", () => {
    const source = readFileSync(PREPARE, "utf8");
    assert.match(source, /resolveCommit\(PRIVATE_ROOT, "HEAD", "private HEAD"\)/u);
    assert.match(source, /resolveCommit\(PUBLIC_ROOT, `\$\{remote\}\/main`, "public base"\)/u);
    assert.match(source, /git merge-file/u);
    assert.match(source, /maxBuffer:\s*GIT_MAX_BUFFER_BYTES/u);
    assert.match(source, /health evidence is stale, manually edited, incomplete/u);
    assert.match(source, /must start exactly at current public main/u);
  });
  test("scenario A: stale lockfile is blocked", () => { const expected = manifest(); write("pnpm-lock.yaml", "lockfileVersion: stale\n"); const result = run(expected); assert.equal(result.status, 1); assert.match(result.stderr, /pnpm-lock\.yaml/u); reset(); });
  test("scenario B: stale test or package-smoke file is blocked", () => { const expected = manifest(); write("packages/mcp/scripts/smoke.mjs", "throw new Error('stale');\n"); const result = run(expected); assert.equal(result.status, 1); assert.match(result.stderr, /packages\/mcp\/scripts\/smoke\.mjs/u); reset(); });
  test("scenario C: a newly added surface file is blocked unless reviewed", () => { const expected = manifest(); write("packages/cli/tests/new-release-case.test.ts", "export {};\n"); const result = run(expected); assert.equal(result.status, 1); assert.match(result.stderr, /unreviewed extra/u); reset(); });
  test("an extra file under an attempted reserved namespace is blocked", () => { const expected = manifest(); const attemptedReservedPrefix = [".private", "release"].join("-"); write(`${attemptedReservedPrefix}/unexpected.json`, "{}\n"); const result = run(expected); assert.equal(result.status, 1); assert.match(result.stderr, /unreviewed extra/u); reset(); });
  test("unknown manifest fields are blocked", () => { const expected = manifest(); expected.reviewedDivergences = []; const result = run(expected); assert.equal(result.status, 1); assert.match(result.stderr, /unsupported fields/u); reset(); });
  test("reviewed public-only divergence requires exact content hash", () => {
    const expected = manifest(); write("scripts/public-only.mjs", "export {};\n");
    expected.publicSurfaceEntries.push({ path: "scripts/public-only.mjs", mode: "100644", sha256: sha256(Buffer.from("export {};\n")) });
    expected.publicSurfaceEntries.sort((a, b) => a.path.localeCompare(b.path));
    expected.publicSurfaceHash = hashSurface(expected.publicSurfaceEntries);
    const result = run(expected); assert.equal(result.status, 0, result.stderr); reset();
  });
  test("promoted runtime sources contain no filesystem promotion-ledger namespace", () => {
    const attemptedReservedPrefix = [".private", "release"].join("-");
    for (const path of [GENERATOR, PREPARE, resolve(import.meta.dirname, "..", "lib", "public-release-surface.mjs"), resolve(import.meta.dirname, "..", "public-portability-guard.mjs")]) {
      assert.doesNotMatch(readFileSync(path, "utf8"), new RegExp(attemptedReservedPrefix.replace(".", "\\."), "u"), path);
    }
    assert.match(PRIVATE_PROMOTION_NOTES_REF, /^refs\/notes\//u);
  });
});
