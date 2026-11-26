import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runPublicPortabilityGuard } from "../public-portability-guard.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readWorkflow(relativePath) {
  return await import("node:fs/promises").then(({ readFile }) =>
    readFile(path.join(ROOT_DIR, relativePath), "utf8"),
  );
}

test("public-surface workflow skips ordinary internal PRs and runs public-staging scans", async () => {
  const workflow = await readWorkflow(".github/workflows/public-surface-guard.yml");

  assert.match(
    workflow,
    /if:\s+github\.event_name != 'pull_request' \|\| startsWith\(github\.head_ref, 'public-staging\/'\)/,
  );
  assert.match(workflow, /push:\s*\n\s+branches:\s*\n\s+- public-staging\/\*\*/);
  assert.doesNotMatch(workflow, /push:\s*\n\s+branches:\s*\n\s+- main/);
  assert.match(workflow, /pnpm public:copy-scan/);
  assert.match(workflow, /pnpm public:portability-guard/);
});

test("promotion workflow is public-repo scoped and requires public-staging or manual dispatch", async () => {
  const workflow = await readWorkflow(".github/workflows/public-promotion-guard.yml");

  assert.match(
    workflow,
    /if:\s+github\.repository == 'Keesan12\/martin-loop' && \(github\.event_name == 'workflow_dispatch' \|\| startsWith\(github\.head_ref, 'public-staging\/'\)\)/,
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /node scripts\/verify-public-promotion\.mjs/);
});

test("public dependency review runs on main pull requests with read-only permissions and pinned actions", async () => {
  const workflow = (await readWorkflow(".github/workflows/dependency-review.yml")).replaceAll("\r\n", "\n");

  assert.match(workflow, /on:\s*\n  pull_request:\s*\n    branches:\s*\n      - main/);
  assert.match(workflow, /permissions:\s*\n  contents: read\n\s*\njobs:/);
  assert.match(workflow, /if: github\.event\.repository\.private == false/);
  assert.match(workflow, /uses: actions\/checkout@[0-9a-f]{40}\b/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /uses: actions\/dependency-review-action@[0-9a-f]{40}\b/);
  assert.doesNotMatch(workflow, /pull_request_target|:\s*write\b/);
});

test("the budget gate composite action pins its artifact uploader", async () => {
  const action = await readWorkflow(".github/actions/martinloop/action.yml");

  assert.match(action, /uses: actions\/upload-artifact@[0-9a-f]{40}\b/);
});

test("private repo references still fail inside an explicit public payload", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "martin-public-payload-"));
  await mkdir(path.join(rootDir, "dist"), { recursive: true });
  await writeFile(
    path.join(rootDir, "dist", "index.js"),
    `export const leaked = '${["Example", "Service", "Internal"].join("_")}';\n`,
  );

  await assert.rejects(
    () =>
      runPublicPortabilityGuard({
        rootDir,
        files: ["dist/index.js"],
      }),
    /internal repository name/,
  );
});
