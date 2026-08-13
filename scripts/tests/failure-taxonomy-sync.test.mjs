import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadFailureClassesFromContracts, syncFailureTaxonomyArtifacts } from "../failure-taxonomy.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readRepoFile(relativePath) {
  return readFile(path.join(ROOT_DIR, relativePath), "utf8");
}

test("canonical taxonomy artifacts stay synced with FAILURE_CLASSES", async () => {
  await syncFailureTaxonomyArtifacts({ write: false });

  const classes = await loadFailureClassesFromContracts();
  const artifact = JSON.parse(await readRepoFile(path.join("docs", "oss", "failure-taxonomy.runtime.json")));
  const doc = await readRepoFile(path.join("docs", "oss", "FAILURE-TAXONOMY-13.md"));
  const docClasses = [...doc.matchAll(/^\| `([a-z_]+)` \|/gm)].map((entry) => entry[1]);

  assert.deepEqual(artifact.failureClasses, classes);
  assert.deepEqual(docClasses, classes);
  assert.equal(artifact.canonicalClassCount, classes.length);
});

test("public taxonomy copy never claims non-canonical class counts", async () => {
  const [readme, taxonomyDoc, ossReadme] = await Promise.all([
    readRepoFile("README.md"),
    readRepoFile(path.join("docs", "oss", "FAILURE-TAXONOMY-13.md")),
    readRepoFile(path.join("docs", "oss", "README.md"))
  ]);

  for (const contents of [readme, taxonomyDoc, ossReadme]) {
    assert.doesNotMatch(contents, /\b11-class failure taxonomy\b/i);
    assert.doesNotMatch(contents, /\b12 runtime classes\b/i);
    assert.doesNotMatch(contents, /\b14 Known Modes\b/i);
    assert.doesNotMatch(contents, /\bcanonical 14-class\b/i);
  }
});
