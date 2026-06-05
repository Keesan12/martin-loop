import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertPackedSurface,
  assertRootVersionPolicy,
  assertVendoredCliManifest,
  runRootReleaseGuard,
} from "../root-release-guard.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("runRootReleaseGuard accepts the current OSS-safe root package shape", async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT_DIR, "package.json"), "utf8"));
  const expectedTag = `v${manifest.version}`;
  const result = await runRootReleaseGuard({
    rootDir: ROOT_DIR,
    tag: expectedTag,
  });

  assert.equal(result.name, "martin-loop");
  assert.equal(result.version, manifest.version);
  assert.equal(result.tag, expectedTag);
  assert.equal(result.packChecked, false);
});

test("assertRootVersionPolicy rejects non-0.2.x root versions", () => {
  assert.throws(() => assertRootVersionPolicy("1.3.0"), /0\.2\.x/);
});

test("assertPackedSurface rejects unexpected non-OSS paths", () => {
  assert.throws(
    () =>
      assertPackedSurface([
        "package.json",
        "README.md",
        "CODE_OF_CONDUCT.md",
        "dist/index.js",
        "dist/index.d.ts",
        "dist/bin/martin-loop.js",
        "server/secrets.json",
      ]),
    /unexpected path/i,
  );
});

test("assertPackedSurface rejects forbidden vendored implementation paths", () => {
  assert.throws(
    () =>
      assertPackedSurface([
        "package.json",
        "README.md",
        "CODE_OF_CONDUCT.md",
        "dist/index.js",
        "dist/index.d.ts",
        "dist/bin/martin-loop.js",
        "dist/vendor/cli/bin/martin.js",
      ]),
    /forbidden vendored implementation path/i,
  );
});

test("assertVendoredCliManifest accepts the sanitized vendored CLI package manifest", async () => {
  await assertVendoredCliManifest(ROOT_DIR);
});
