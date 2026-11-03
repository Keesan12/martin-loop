import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("root release workflow uses GitHub Actions trusted publishing without npm tokens", async () => {
  const workflowPath = path.join(ROOT_DIR, ".github", "workflows", "release.yml");
  const workflow = await readFile(workflowPath, "utf8");

  assert.doesNotMatch(workflow, /workflow_call:/);
  assert.match(workflow, /workflow_dispatch:\s*[\s\S]*candidate_sha:\s*[\s\S]*version:\s*[\s\S]*failed_run_id:/);
  assert.match(workflow, /workflow_run:\s*[\s\S]*Validate and cut paired release tags[\s\S]*completed/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /ref:\s*\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.candidate_sha \|\| 'main' \}\}/);
  assert.doesNotMatch(workflow, /github\.event\.workflow_run\.head_sha/);
  assert.match(workflow, /git fetch origin main/);
  assert.match(workflow, /test "\$HEAD_SHA" = "\$TAG_SHA"/);
  assert.match(workflow, /test "\$TAG_SHA" = "\$MCP_TAG_SHA"/);
  assert.match(workflow, /test "\$TAG_SHA" = "\$MAIN_SHA"/);
  assert.doesNotMatch(workflow, /validated_release_sha:/);
  assert.doesNotMatch(workflow, /recovery_state:/);
  assert.doesNotMatch(workflow, /release-recovery-state\.mjs --publisher-coordinates/);
  assert.match(workflow, /actions\/runs\/\$\{FAILED_RUN_ID\}/);
  assert.match(workflow, /Pack root tarball/);
  assert.match(workflow, /git merge-base --is-ancestor "\$CANDIDATE_SHA" "\$MAIN_SHA"/);
  assert.match(workflow, /npm view "@martinloop\/mcp@\$VERSION" version/);
  assert.match(workflow, /npm view "martin-loop@\$VERSION" version/);
  assert.match(workflow, /permissions:\s*[\s\S]*contents:\s*write/);
  assert.match(workflow, /permissions:\s*[\s\S]*id-token:\s*write/);
  assert.match(workflow, /node-version:\s*24/);
  assert.match(workflow, /registry-url:\s*https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /npm install -g npm@11\.5\.1/);
  assert.doesNotMatch(workflow, /npm install -g npm@latest/);
  assert.match(workflow, /npm pack --ignore-scripts --json --pack-destination dist-release/);
  assert.match(workflow, /npm pack --ignore-scripts[\s\S]*git restore --source=HEAD -- package\.json[\s\S]*pnpm release:clean-check/);
  assert.doesNotMatch(workflow, /git (?:tag|push)[^\n]*refs\/tags/u);
  assert.match(workflow, /find dist-release -maxdepth 1 -type f -name '\*\.tgz'/);
  assert.match(workflow, /echo "tarball=\.\/\$\{TARBALLS\[0\]#\.\/\}" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /npm publish "\$\{\{ steps\.root-pack\.outputs\.tarball \}\}" --access public --provenance/);
  assert.match(workflow, /npm view "martin-loop@\$\{\{ steps\.package-version\.outputs\.version \}\}" version/);
  assert.match(
    workflow,
    /node \.\/scripts\/published-artifact-e2e\.mjs --package-spec "martin-loop@\$\{\{ steps\.package-version\.outputs\.version \}\}"/,
  );
  assert.match(workflow, /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/);
  assert.match(workflow, /pnpm\/action-setup@b0f76dfb45f55f8421693e4803ac7bb65143bd34/);
  assert.match(workflow, /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/);
  assert.match(workflow, /softprops\/action-gh-release@718ea10b132b3b2eba29c1007bb80653f286566b/);
  assert.match(workflow, /pnpm release:authority:check/);
  assert.match(workflow, /pnpm release:authority:check:built/);
  assert.equal(workflow.match(/pnpm release:clean-check/g)?.length, 3);

  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN/);
  assert.doesNotMatch(workflow, /NPM_TOKEN/);
  assert.doesNotMatch(workflow, /_authToken/);
  assert.doesNotMatch(workflow, /secrets\./);
});

test("platform release validation enforces source, built, and clean-state authority", async () => {
  const workflowPath = path.join(ROOT_DIR, ".github", "workflows", "platform-release-validation.yml");
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /fleet-release-authority-check\.mjs --source/);
  assert.match(workflow, /fleet-release-authority-check\.mjs --built/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(
    workflow,
    /git fetch --no-tags --depth=1 https:\/\/github\.com\/Keesan12\/martin-loop\.git main:refs\/remotes\/public\/main/,
  );
  assert.equal(workflow.match(/pnpm release:clean-check/g)?.length, 2);
});
