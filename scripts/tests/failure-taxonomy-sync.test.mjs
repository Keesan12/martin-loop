import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadFailureClassesFromContracts, syncFailureTaxonomyArtifacts } from "../failure-taxonomy.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readRepoFile(relativePath) {
  return readFile(path.join(ROOT_DIR, relativePath), "utf8");
}

function checksumRecords(records) {
  return createHash("sha256").update(JSON.stringify(records), "utf8").digest("hex");
}

function runTaxonomyCheck() {
  return spawnSync(process.execPath, ["scripts/failure-taxonomy.mjs", "--check"], {
    cwd: ROOT_DIR,
    encoding: "utf8"
  });
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
  assert.equal(classes.length, 13);
  assert.equal(classes.at(-1), "sandbox_write_blocked");
  assert.deepEqual(
    artifact.classes.map((record) => record.classId),
    classes
  );
  assert.equal(new Set(artifact.classes.map((record) => record.classId)).size, 13);
  assert.ok(artifact.classes.every((record) => record.description.trim().length > 0));
  assert.match(artifact.sourceChecksum, /^[a-f0-9]{64}$/);
  assert.equal(artifact.sourceChecksum, checksumRecords(artifact.classes));
  assert.deepEqual(
    {
      file: artifact.sourceProvenance.file,
      symbol: artifact.sourceProvenance.symbol
    },
    {
      file: "packages/contracts/src/index.ts",
      symbol: "FAILURE_CLASSES"
    }
  );
  assert.match(artifact.sourceProvenance.fileSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    artifact.sourceProvenance.fileSha256,
    createHash("sha256")
      .update(
        (await readRepoFile(path.join("packages", "contracts", "src", "index.ts"))).replace(/\r\n/g, "\n"),
        "utf8",
      )
      .digest("hex")
  );

  const docDescriptions = new Map(
    [...doc.matchAll(/^\| `([a-z_]+)` \| (.+) \|$/gm)].map((entry) => [entry[1], entry[2]])
  );
  assert.deepEqual(
    artifact.classes.map((record) => record.description),
    classes.map((classId) => docDescriptions.get(classId))
  );
});

test("check mode rejects reordered, undescribed, and missing taxonomy records", async () => {
  const artifactPath = path.join(ROOT_DIR, "docs", "oss", "failure-taxonomy.runtime.json");
  const original = await readFile(artifactPath, "utf8");
  const artifact = JSON.parse(original);
  const mutations = [
    {
      name: "reordered records",
      apply(value) {
        [value.classes[0], value.classes[1]] = [value.classes[1], value.classes[0]];
      }
    },
    {
      name: "empty description",
      apply(value) {
        value.classes[0].description = "";
      }
    },
    {
      name: "missing record",
      apply(value) {
        value.classes.pop();
      }
    }
  ];

  try {
    for (const mutation of mutations) {
      const changed = structuredClone(artifact);
      mutation.apply(changed);
      await writeFile(artifactPath, `${JSON.stringify(changed, null, 2)}\n`, "utf8");
      const result = runTaxonomyCheck();
      assert.notEqual(result.status, 0, `${mutation.name} unexpectedly passed check mode`);
    }
  } finally {
    await writeFile(artifactPath, original, "utf8");
  }
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
