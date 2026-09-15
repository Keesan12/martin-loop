import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("root release workflow uses GitHub Actions trusted publishing without npm tokens", async () => {
  const workflowPath = path.join(ROOT_DIR, ".github", "workflows", "release.yml");
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /workflow_call:/);
  assert.doesNotMatch(workflow, /workflow_dispatch:/);
  assert.match(workflow, /push:\s*[\s\S]*branches:\s*[\s\S]*- main[\s\S]*paths:\s*[\s\S]*\.github\/workflows\/release\.yml/);
  assert.match(workflow, /validated_release_sha:/);
  assert.match(workflow, /recovery_state:/);
  assert.match(workflow, /EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  assert.match(workflow, /TAG="v0\.6\.4"/);
  assert.match(workflow, /VALIDATED_RELEASE_SHA="29bd341fd6efb1ddd1e315579d2c9a5d8bd82ccf"/);
  assert.match(workflow, /RECOVERY_STATE="RETRY_PUBLISH_SAME_VALIDATED_TAG"/);
  assert.match(workflow, /ref: \$\{\{ steps\.invocation\.outputs\.tag \}\}/);
  assert.match(workflow, /release-recovery-state\.mjs --publisher-coordinates/);
  assert.doesNotMatch(workflow, /push:\s*[\s\S]*tags:/);
  assert.match(workflow, /permissions:\s*[\s\S]*contents:\s*write/);
  assert.match(workflow, /permissions:\s*[\s\S]*id-token:\s*write/);
  assert.match(workflow, /node-version:\s*24/);
  assert.match(workflow, /registry-url:\s*https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /npm install -g npm@latest/);
  assert.ok(
    workflow.indexOf("Validate OSS release surface") < workflow.indexOf("Use latest npm for trusted publishing"),
    "trusted-publishing npm upgrade must happen after immutable-tag validation",
  );
  assert.ok(
    workflow.indexOf("Check npm for existing version") < workflow.indexOf("Use latest npm for trusted publishing"),
    "trusted-publishing npm upgrade must happen only after the duplicate-publication guard",
  );
  assert.match(workflow, /npm pack --json --pack-destination dist-release/);
  assert.match(workflow, /find dist-release -maxdepth 1 -type f -name '\*\.tgz'/);
  assert.match(workflow, /echo "tarball=\.\/\$\{TARBALLS\[0\]#\.\/\}" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /npm publish "\$\{\{ steps\.root-pack\.outputs\.tarball \}\}" --access public --provenance/);
  assert.match(workflow, /npm view "martin-loop@\$\{\{ steps\.package-version\.outputs\.version \}\}" version/);
  assert.match(
    workflow,
    /node \.\/scripts\/published-artifact-e2e\.mjs --package-spec "martin-loop@\$\{\{ steps\.package-version\.outputs\.version \}\}"/,
  );
  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /pnpm\/action-setup@b0f76dfb45f55f8421693e4803ac7bb65143bd34/);
  assert.match(workflow, /actions\/setup-node@v6/);
  assert.match(workflow, /softprops\/action-gh-release@718ea10b132b3b2eba29c1007bb80653f286566b/);
  assert.match(workflow, /pnpm release:authority:check/);
  assert.match(workflow, /pnpm release:authority:check:built/);
  assert.equal(workflow.match(/pnpm release:clean-check/g)?.length, 2);

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
  assert.equal(workflow.match(/pnpm release:clean-check/g)?.length, 2);
});
