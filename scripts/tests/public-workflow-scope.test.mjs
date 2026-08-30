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

test("promotion workflow requires public-staging or manual dispatch", async () => {
  const workflow = await readWorkflow(".github/workflows/public-promotion-guard.yml");

  assert.match(workflow, /skip-non-promotion:/);
  assert.match(
    workflow,
    /if:\s+github\.event_name == 'pull_request' && !startsWith\(github\.head_ref, 'public-staging\/'\)/,
  );
  assert.match(
    workflow,
    /if:\s+github\.event_name == 'workflow_dispatch' \|\| startsWith\(github\.head_ref, 'public-staging\/'\)/,
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /node scripts\/verify-public-promotion\.mjs/);
});

test("private repo references still fail inside an explicit public payload", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "martin-public-payload-"));
  await mkdir(path.join(rootDir, "dist"), { recursive: true });
  await writeFile(
    path.join(rootDir, "dist", "index.js"),
    "export const leaked = 'ML_Core_OSS_Internal';\n",
  );

  await assert.rejects(
    () =>
      runPublicPortabilityGuard({
        rootDir,
        files: ["dist/index.js"],
      }),
    /internal OSS repo name/,
  );
});
