import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertPackedSurface,
  assertRootVersionPolicy,
  runRootReleaseGuard,
} from "../root-release-guard.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("runRootReleaseGuard accepts the current OSS-safe root package shape", async () => {
  const result = await runRootReleaseGuard({
    rootDir: ROOT_DIR,
    tag: "v0.2.5",
  });

  assert.equal(result.name, "martin-loop");
  assert.equal(result.version, "0.2.5");
  assert.equal(result.tag, "v0.2.5");
  assert.equal(result.packChecked, false);
});

test("assertRootVersionPolicy rejects versions outside approved pre-1.0 OSS lines", () => {
  assert.doesNotThrow(() => assertRootVersionPolicy("0.1.6"));
  assert.doesNotThrow(() => assertRootVersionPolicy("0.2.0"));
  assert.throws(() => assertRootVersionPolicy("1.3.0"), /approved pre-1\.0 OSS lines/);
});

test("assertPackedSurface rejects unexpected private paths", () => {
  assert.throws(
    () =>
      assertPackedSurface([
        "package.json",
        "README.md",
        "CODE_OF_CONDUCT.md",
        "dist/index.js",
        "dist/index.d.ts",
        "dist/bin/martin-loop.js",
        "apps/control-plane/secrets.json",
      ]),
    /unexpected path/i,
  );
});
