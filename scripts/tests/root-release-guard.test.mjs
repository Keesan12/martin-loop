import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertPackedSurface,
  assertRootVersionPolicy,
  runRootReleaseGuard,
} from "../root-release-guard.mjs";
import rootPackageJson from "../../package.json" with { type: "json" };

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT_TAG = `v${rootPackageJson.version}`;

test("runRootReleaseGuard accepts the current OSS-safe root package shape", async () => {
  const result = await runRootReleaseGuard({
    rootDir: ROOT_DIR,
    tag: ROOT_TAG,
  });

  assert.equal(result.name, "martin-loop");
  assert.equal(result.version, rootPackageJson.version);
  assert.equal(result.tag, ROOT_TAG);
  assert.equal(result.packChecked, false);
});

test("assertRootVersionPolicy accepts the approved 0.1.x and 0.2.x root lines", () => {
  assert.doesNotThrow(() => assertRootVersionPolicy("0.1.8"));
  assert.doesNotThrow(() => assertRootVersionPolicy("0.2.0"));
  assert.throws(() => assertRootVersionPolicy("1.3.0"), /0\.1\.x or 0\.2\.x/);
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
