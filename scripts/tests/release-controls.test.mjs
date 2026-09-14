import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { RELEASE_STATES, assertPublisherCoordinates, evaluateReleaseRecovery } from "../lib/release-recovery-state.mjs";
import { assertPreTagAttestation, cutPairedReleaseTags } from "../lib/release-tag-controller.mjs";
import { assertInfrastructureRetryEvidence } from "../lib/release-retry-evidence.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);

test("release source-coordinate recovery", async (t) => {
  await t.test("scenario D: stale tag/source mismatch blocks before dispatch", () => {
    const result = evaluateReleaseRecovery({ preTagValidationPassed: true, validatedReleaseSha: B, rootTagSha: A, mcpTagSha: A, rootPublished: false, mcpPublished: false });
    assert.equal(result.state, RELEASE_STATES.ABORTED);
    assert.equal(result.allowed, false);
    assert.equal(result.dispatchAllowed, false);
  });
  await t.test("scenario E: infrastructure-only failure permits same validated tag retry", () => {
    const result = evaluateReleaseRecovery({ preTagValidationPassed: true, validatedReleaseSha: A, rootTagSha: A, mcpTagSha: A, rootPublished: false, mcpPublished: false, failureKind: "infrastructure" });
    assert.equal(result.state, RELEASE_STATES.RETRY);
    assert.equal(result.allowed, true);
    assert.equal(result.dispatchAllowed, true);
    assert.deepEqual(assertPublisherCoordinates({ validatedReleaseSha: A, tagSha: A, pairedTagSha: A, recoveryState: result.state }), { validatedReleaseSha: A, recoveryState: RELEASE_STATES.RETRY });
  });
  await t.test("scenario F: failed pre-tag validation creates no tags and dispatches nothing", () => {
    const result = evaluateReleaseRecovery({ preTagValidationPassed: false, validatedReleaseSha: A, rootTagSha: null, mcpTagSha: null, rootPublished: false, mcpPublished: false });
    assert.equal(result.state, RELEASE_STATES.REPAIR);
    assert.equal(result.allowed, false);
    assert.equal(result.dispatchAllowed, false);
    assert.equal(result.tagCreationAllowed, false);
  });
  await t.test("partial or disagreeing root/MCP tags always block", () => {
    for (const [root, mcp] of [[A, null], [null, A], [A, B]]) {
      const result = evaluateReleaseRecovery({ preTagValidationPassed: true, validatedReleaseSha: A, rootTagSha: root, mcpTagSha: mcp, rootPublished: false, mcpPublished: false });
      assert.equal(result.allowed, false);
      assert.equal(result.dispatchAllowed, false);
      assert.equal(result.tagCreationAllowed, false);
    }
  });
});

test("pre-tag gate contains the complete root, MCP, and MCPB publisher-equivalent matrix", () => {
  const script = readFileSync(resolve(import.meta.dirname, "..", "pre-tag-release-gate.mjs"), "utf8");
  for (const required of ["pnpm install --frozen-lockfile", "pnpm release:clean-check", "pnpm release:authority:check", "pnpm build", "pnpm lint", "pnpm public:copy-scan", "pnpm public:portability-guard", "pnpm public:git-surface", "pnpm test", "pnpm release:authority:check:built", "pnpm oss:validate", "pnpm public:smoke", "root-release-guard.mjs", "mcp-release-validation.mjs", "verify:release", "mcpb:build", "mcpb:validate", "mcpb:smoke"]) assert.match(script, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
});

test("tag cutter uses one atomic remote operation", () => {
  const script = readFileSync(resolve(import.meta.dirname, "..", "cut-release-tags.mjs"), "utf8");
  assert.match(script, /cutPairedReleaseTags/u);
  assert.doesNotMatch(script, /git tag/u);
  const library = readFileSync(resolve(import.meta.dirname, "..", "lib", "release-tag-controller.mjs"), "utf8");
  assert.match(library, /git", "push", "--atomic", "origin"/u);
});

test("scenario F integration: failed attestation leaves a bare remote tagless, then a valid candidate creates the paired tags", async () => {
  const temp = mkdtempSync(resolve(tmpdir(), "martin-release-tags-"));
  const bare = resolve(temp, "remote.git");
  const work = resolve(temp, "work");
  try {
    execFileSync("git", ["init", "--bare", bare]);
    execFileSync("git", ["clone", bare, work]);
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: work });
    execFileSync("git", ["config", "user.name", "test"], { cwd: work });
    execFileSync("git", ["commit", "--allow-empty", "-m", "candidate"], { cwd: work });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
    assert.throws(() => assertPreTagAttestation({ status: "failed", candidateSha: sha, validatedReleaseSha: sha }), /not passed/u);
    assert.equal(execFileSync("git", ["tag", "--list"], { cwd: work, encoding: "utf8" }).trim(), "");
    const attestation = assertPreTagAttestation({ status: "passed", candidateSha: sha, validatedReleaseSha: sha });
    cutPairedReleaseTags({ cwd: work, candidateSha: sha, version: "0.6.3", attestation });
    const tags = execFileSync("git", ["ls-remote", "--tags", "origin"], { cwd: work, encoding: "utf8" });
    assert.match(tags, /refs\/tags\/v0\.6\.3/u);
    assert.match(tags, /refs\/tags\/mcp-v0\.6\.3/u);
  } finally { rmSync(temp, { recursive: true, force: true }); }
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