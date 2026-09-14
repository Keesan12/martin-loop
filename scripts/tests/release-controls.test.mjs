// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PUBLISHER_EQUIVALENT_COMMANDS } from "../lib/publisher-equivalent-commands.mjs";
import { RELEASE_STATES, assertPublisherCoordinates, evaluateReleaseRecovery } from "../lib/release-recovery-state.mjs";
import { assertInfrastructureRetryEvidence } from "../lib/release-retry-evidence.mjs";

const A = "a".repeat(40); const B = "b".repeat(40);
describe("release source-coordinate recovery", () => {
  test("scenario D: stale tag/source mismatch blocks before dispatch", () => {
    const result = evaluateReleaseRecovery({ preTagValidationPassed: true, validatedReleaseSha: B, rootTagSha: A, mcpTagSha: A, rootPublished: false, mcpPublished: false });
    assert.equal(result.state, RELEASE_STATES.ABORTED); assert.equal(result.dispatchAllowed, false); assert.equal(result.allowed, false);
    assert.throws(() => assertPublisherCoordinates({ validatedReleaseSha: B, tagSha: A, pairedTagSha: A, recoveryState: RELEASE_STATES.RETRY }));
  });
  test("scenario E: infrastructure-only failure permits same validated tag retry", () => {
    const result = evaluateReleaseRecovery({ preTagValidationPassed: true, validatedReleaseSha: A, rootTagSha: A, mcpTagSha: A, rootPublished: false, mcpPublished: false, failureKind: "infrastructure" });
    assert.equal(result.state, RELEASE_STATES.RETRY); assert.equal(result.dispatchAllowed, true); assert.equal(result.tagCreationAllowed, false);
    assert.doesNotThrow(() => assertPublisherCoordinates({ validatedReleaseSha: A, tagSha: A, pairedTagSha: A, recoveryState: RELEASE_STATES.RETRY }));
  });
  test("scenario F: failed pre-tag validation creates no tags and dispatches nothing", () => {
    const result = evaluateReleaseRecovery({ preTagValidationPassed: false, validatedReleaseSha: A, rootTagSha: null, mcpTagSha: null });
    assert.equal(result.state, RELEASE_STATES.REPAIR); assert.equal(result.tagCreationAllowed, false); assert.equal(result.dispatchAllowed, false);
  });
  test("partial or disagreeing root/MCP tags always block", () => {
    for (const [rootTagSha, mcpTagSha] of [[A, null], [null, A], [A, B]]) {
      const result = evaluateReleaseRecovery({ preTagValidationPassed: true, validatedReleaseSha: A, rootTagSha, mcpTagSha });
      assert.equal(result.state, RELEASE_STATES.REPAIR); assert.equal(result.allowed, false);
    }
  });
});

test("pre-tag gate contains the complete root, MCP, and MCPB publisher-equivalent matrix", () => {
  const commands = PUBLISHER_EQUIVALENT_COMMANDS.map(([command, args]) => [command, ...args].join(" "));
  for (const required of ["pnpm install --frozen-lockfile", "pnpm lint", "pnpm test", "pnpm build", "pnpm public:smoke", "pnpm --filter @martinloop/mcp smoke:pack", "pnpm --filter @martinloop/mcp smoke:published:pack", "pnpm --filter @martinloop/mcp verify:release", "pnpm --filter @martinloop/mcp mcpb:build", "pnpm --filter @martinloop/mcp mcpb:validate", "pnpm --filter @martinloop/mcp mcpb:smoke"]) assert.ok(commands.includes(required), `missing ${required}`);
  assert.ok(!commands.includes("pnpm public:promotion-guard"), "promotion verification belongs to the public-staging PR boundary, not the post-merge tag gate");
  assert.ok(commands.indexOf("pnpm build") < commands.indexOf("pnpm test"), "clean-checkout build artifacts must exist before the full test lane");
  const gate = readFileSync(resolve(import.meta.dirname, "..", "pre-tag-release-gate.mjs"), "utf8");
  assert.match(gate, /root-release-guard\.mjs[\s\S]*--pack/u);
  assert.equal(gate.match(/release:clean-check/g)?.length, 1, "gate must append a final clean check in addition to the matrix pre-check");
});

test("tag cutter uses one atomic remote operation", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "cut-release-tags.mjs"), "utf8");
  assert.match(source, /\["push", "--atomic", "origin"/u);
});

test("scenario F integration: failed attestation leaves a bare remote tagless, then a valid candidate creates the paired tags", () => {
  const root = mkdtempSync(join(tmpdir(), "release-tags-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  try {
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    mkdirSync(repo);
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo });
    mkdirSync(join(repo, "packages", "mcp"), { recursive: true });
    for (const path of ["package.json", "packages/mcp/package.json", "packages/mcp/server.json"]) writeFileSync(join(repo, ...path.split("/")), '{"version":"1.2.3"}\n');
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "candidate"], { cwd: repo, stdio: "ignore" });
    const candidate = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    execFileSync("git", ["push", "origin", "main"], { cwd: repo, stdio: "ignore" });
    const attestation = join(repo, "attestation.json");
    const publication = join(repo, "publication.json");
    writeFileSync(publication, `${JSON.stringify({ schemaVersion: "martin.release-publication-state.v1", version: "1.2.3", checkedAt: new Date().toISOString(), rootNpmPublished: false, mcpNpmPublished: false, rootGithubReleaseExists: false, mcpGithubReleaseExists: false })}\n`);
    writeFileSync(attestation, `${JSON.stringify({ publisherEquivalentValidation: "FAIL", validatedReleaseSha: candidate })}\n`);
    const cutter = resolve(import.meta.dirname, "..", "cut-release-tags.mjs");
    const failed = spawnSync("node", [cutter, "--candidate-sha", candidate, "--version", "1.2.3", "--attestation", attestation, "--publication-evidence", publication], { cwd: repo, encoding: "utf8" });
    assert.equal(failed.status, 1);
    const refsAfterFailure = spawnSync("git", ["--git-dir", remote, "show-ref", "--tags"], { encoding: "utf8" });
    assert.equal(refsAfterFailure.status, 1, refsAfterFailure.stdout);
    writeFileSync(attestation, `${JSON.stringify({ publisherEquivalentValidation: "PASS", validatedReleaseSha: candidate })}\n`);
    const passed = spawnSync("node", [cutter, "--candidate-sha", candidate, "--version", "1.2.3", "--attestation", attestation, "--publication-evidence", publication], { cwd: repo, encoding: "utf8" });
    assert.equal(passed.status, 0, passed.stderr);
    for (const tag of ["v1.2.3", "mcp-v1.2.3"]) assert.equal(execFileSync("git", ["--git-dir", remote, "rev-list", "-n", "1", tag], { encoding: "utf8" }).trim(), candidate);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("same-tag retry requires GitHub-bound infrastructure evidence", () => {
  const run = { id: 42, head_sha: A, path: "Keesan12/martin-loop/.github/workflows/cut-release-tags.yml", conclusion: "timed_out" };
  assert.deepEqual(assertInfrastructureRetryEvidence({ run, jobs: [], candidateSha: A }), { classification: "infrastructure", runId: 42 });
  assert.throws(() => assertInfrastructureRetryEvidence({ run, jobs: [{ conclusion: "cancelled", steps: [{ conclusion: "failure" }] }], candidateSha: A }), /failed workflow step/u);
  assert.throws(() => assertInfrastructureRetryEvidence({ run: { ...run, conclusion: "failure" }, jobs: [{ conclusion: "failure", steps: [{ conclusion: "failure" }] }], candidateSha: A }), /failed workflow step/u);
  assert.throws(() => assertInfrastructureRetryEvidence({ run: { ...run, head_sha: B }, jobs: [], candidateSha: A }), /candidate SHA/u);
});

test("partial publication never redispatches both coordinated publishers", () => {
  for (const publication of [
    { rootNpmPublished: true, mcpNpmPublished: false, rootGithubReleaseExists: false, mcpGithubReleaseExists: false },
    { rootNpmPublished: true, mcpNpmPublished: true, rootGithubReleaseExists: false, mcpGithubReleaseExists: false },
    { rootNpmPublished: true, mcpNpmPublished: false, rootGithubReleaseExists: false, mcpGithubReleaseExists: true },
  ]) {
    const result = evaluateReleaseRecovery({ preTagValidationPassed: true, validatedReleaseSha: A, rootTagSha: A, mcpTagSha: A, ...publication, failureKind: "infrastructure" });
    assert.equal(result.state, RELEASE_STATES.REPAIR);
    assert.equal(result.dispatchAllowed, false);
  }
});

test("cut workflow validates trusted main before the atomic tag job and dispatches coordinated publishers", () => {
  const workflow = readFileSync(resolve(import.meta.dirname, "..", "..", ".github", "workflows", "cut-release-tags.yml"), "utf8");
  assert.match(workflow, /if: github\.event_name == 'workflow_dispatch' && github\.repository == 'Keesan12\/martin-loop'/u);
  assert.doesNotMatch(workflow, /push:\s*[\s\S]*branches:/u);
  assert.match(workflow, /publisher-equivalent-validation:[\s\S]*ref: main[\s\S]*persist-credentials: false[\s\S]*pre-tag-release-gate\.mjs/u);
  assert.match(workflow, /atomic-tag-coordinates:[\s\S]*needs: publisher-equivalent-validation[\s\S]*contents: write[\s\S]*persist-credentials: false/u);
  assert.match(workflow, /atomic-tag-coordinates:[\s\S]*git fetch origin main[\s\S]*git rev-parse origin\/main/u);
  assert.match(workflow, /publish-root:[\s\S]*id-token: write[\s\S]*uses: \.\/\.github\/workflows\/release\.yml/u);
  assert.match(workflow, /publish-mcp:[\s\S]*id-token: write[\s\S]*uses: \.\/\.github\/workflows\/publish-mcp\.yml/u);
  assert.doesNotMatch(workflow, /recover-root-0-6-3/u);
  assert.doesNotMatch(workflow, /recover-mcp-0-6-3/u);
  assert.doesNotMatch(workflow, /gh workflow run/u);
  assert.doesNotMatch(workflow, /--candidate-sha '\$\{\{/u);
});
