import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
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

test("assertRootVersionPolicy accepts the current public pre-1.0 release line", () => {
  assert.doesNotThrow(() => assertRootVersionPolicy("0.5.6"));
});

test("assertRootVersionPolicy rejects versions outside the public pre-1.0 line", () => {
  assert.throws(() => assertRootVersionPolicy("1.3.0"), /valid pre-1\.0 release/);
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
  await withTempRoot(async (tempRoot) => {
    await writeFile(
      path.join(tempRoot, "package.json"),
      `${JSON.stringify({ name: "martin-loop", version: "0.3.6" }, null, 2)}\n`,
      "utf8",
    );
    const manifestDir = path.join(tempRoot, "dist", "vendor", "cli");
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      path.join(manifestDir, "package.json"),
      `${JSON.stringify({
        name: "@martin/cli",
        version: "0.3.6",
        type: "module",
        description: "@martin/cli vendored for the martin-loop root package.",
        main: "./index.js",
        types: "./index.d.ts",
        exports: {
          ".": {
            types: "./index.d.ts",
            default: "./index.js",
          },
          "./package.json": "./package.json",
        },
      }, null, 2)}\n`,
      "utf8",
    );

    await assertVendoredCliManifest(tempRoot);
  });
});

async function withTempRoot(run) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "martin-root-release-guard-"));
  try {
    await run(tempRoot);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}
