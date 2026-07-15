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
  extractPackedFilePaths,
  extractPackJsonPayload,
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

test("assertRootVersionPolicy accepts the public 0.3.x and 0.4.x root release lines", () => {
  assert.doesNotThrow(() => assertRootVersionPolicy("0.3.0"));
  assert.doesNotThrow(() => assertRootVersionPolicy("0.4.0"));
});

test("assertRootVersionPolicy rejects versions outside the public 0.2.x, 0.3.x, and 0.4.x lines", () => {
  assert.throws(() => assertRootVersionPolicy("1.3.0"), /0\.2\.x, 0\.3\.x, or 0\.4\.x/);
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

test("extractPackJsonPayload parses npm pack json output containing one package", () => {
  const payload = extractPackJsonPayload(
    JSON.stringify([
      {
        filename: "martin-loop-0.4.3.tgz",
        files: [
          { path: "package.json" },
          { path: "dist/bin/martin-loop.js" },
        ],
      },
    ]),
  );

  assert.equal(payload[0].filename, "martin-loop-0.4.3.tgz");
  assert.equal(payload[0].files[1].path, "dist/bin/martin-loop.js");
});

test("extractPackJsonPayload parses npm warnings before json", () => {
  const payload = extractPackJsonPayload(
    [
      "npm warn config production Use --omit=dev instead.",
      JSON.stringify([{ files: [{ path: "package.json" }] }]),
    ].join("\n"),
  );

  assert.equal(payload[0].files[0].path, "package.json");
});

test("extractPackJsonPayload parses Windows CRLF output and paths containing spaces", () => {
  const payload = extractPackJsonPayload(
    [
      "npm notice package",
      JSON.stringify([{ files: [{ path: "demo/seeded-workspace/file with spaces.txt" }] }]),
      "",
    ].join("\r\n"),
  );

  assert.equal(payload[0].files[0].path, "demo/seeded-workspace/file with spaces.txt");
});

test("extractPackJsonPayload parses multiple json package objects", () => {
  const payload = extractPackJsonPayload(
    JSON.stringify([
      { filename: "first.tgz", files: [{ path: "package.json" }] },
      { filename: "second.tgz", files: [{ path: "README.md" }] },
    ]),
  );

  assert.equal(payload.length, 2);
  assert.equal(payload[1].filename, "second.tgz");
});

test("extractPackJsonPayload fails closed on malformed json and empty output", () => {
  assert.throws(() => extractPackJsonPayload(""), /no stdout/i);
  assert.throws(() => extractPackJsonPayload("npm notice\n[{ bad json }\n"), /unable to parse/i);
});

test("extractPackedFilePaths fails closed on an empty files array", () => {
  assert.throws(
    () => extractPackedFilePaths([{ filename: "martin-loop-0.4.3.tgz", files: [] }]),
    /did not report any packaged files/i,
  );
});

test("extractPackedFilePaths accepts a keyed package object payload", () => {
  assert.deepEqual(
    extractPackedFilePaths({
      "martin-loop": {
        filename: "martin-loop-0.4.3.tgz",
        files: [
          { path: "package.json" },
          { path: "dist/bin/martin-loop.js" },
        ],
      },
    }),
    ["package.json", "dist/bin/martin-loop.js"],
  );
});

test("assertPackedSurface rejects missing expected files and forbidden absolute paths", () => {
  assert.throws(
    () =>
      assertPackedSurface([
        "package.json",
        "README.md",
        "CODE_OF_CONDUCT.md",
      ]),
    /missing required file/i,
  );

  assert.throws(
    () =>
      assertPackedSurface([
        "package.json",
        "README.md",
        "CODE_OF_CONDUCT.md",
        "dist/index.js",
        "dist/index.d.ts",
        "dist/bin/martin-loop.js",
        "C:/Users/Torram/private.txt",
      ]),
    /unexpected path/i,
  );

  assert.throws(
    () =>
      assertPackedSurface([
        "package.json",
        "README.md",
        "CODE_OF_CONDUCT.md",
        "dist/index.js",
        "dist/index.d.ts",
        "dist/bin/martin-loop.js",
        "/Users/private/file.txt",
      ]),
    /unexpected path/i,
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
