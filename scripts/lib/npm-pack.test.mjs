import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { parseNpmPackJson, getFirstPackArtifact, NpmPackParseError } from "./npm-pack.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "../fixtures/npm-pack");

async function loadFixture(name) {
  return readFile(path.join(FIXTURES, name), "utf8");
}

describe("parseNpmPackJson", () => {
  it("parses npm v9 array format", async () => {
    const artifacts = parseNpmPackJson(await loadFixture("npm-v9-array.json"));
    assert.ok(Array.isArray(artifacts));
    assert.equal(artifacts[0].filename, "martin-loop-0.4.3.tgz");
  });

  it("parses npm v10 array format", async () => {
    const artifacts = parseNpmPackJson(await loadFixture("npm-v10-array.json"));
    assert.ok(Array.isArray(artifacts));
    assert.equal(artifacts[0].filename, "martin-loop-0.4.3.tgz");
  });

  it("parses keyed-object format", async () => {
    const artifacts = parseNpmPackJson(await loadFixture("keyed-object.json"));
    assert.ok(Array.isArray(artifacts));
    assert.equal(artifacts[0].filename, "martin-loop-0.4.3.tgz");
  });

  it("parses wrapped-object format for scoped package names", async () => {
    const artifacts = parseNpmPackJson(await loadFixture("wrapped-object.json"));
    assert.ok(Array.isArray(artifacts));
    assert.equal(artifacts[0].filename, "scope-martin-loop-0.4.3.tgz");
  });

  it("extracts npm pack JSON from mixed lifecycle stdout", async () => {
    const artifacts = parseNpmPackJson(await loadFixture("mixed-prepack-output.txt"));
    assert.ok(Array.isArray(artifacts));
    assert.equal(artifacts[0].filename, "martin-loop-0.4.3.tgz");
  });

  it("ignores brackets and braces inside JSON strings while extracting the final pack payload", () => {
    const stdout = [
      "> prepack diagnostics",
      "{\"message\":\"diagnostic with [brackets] and {braces}\"}",
      "[{\"filename\":\"martin-loop-0.4.3.tgz\",\"files\":[{\"path\":\"dist/[hash]/{bundle}.js\"}]}]"
    ].join("\n");

    const artifacts = parseNpmPackJson(stdout);
    assert.equal(artifacts[0].filename, "martin-loop-0.4.3.tgz");
    assert.equal(artifacts[0].files[0].path, "dist/[hash]/{bundle}.js");
  });

  it("throws NpmPackParseError on garbage input", () => {
    assert.throws(() => parseNpmPackJson("not json at all"), NpmPackParseError);
  });

  it("throws NpmPackParseError on non-artifact JSON object", () => {
    assert.throws(
      () => parseNpmPackJson('{"name":"martin-loop","version":"0.4.3","packChecked":true}'),
      NpmPackParseError
    );
  });
});

describe("getFirstPackArtifact", () => {
  it("returns first artifact from array", () => {
    const arr = [{ filename: "a.tgz" }, { filename: "b.tgz" }];
    assert.deepEqual(getFirstPackArtifact(arr), { filename: "a.tgz" });
  });

  it("returns first artifact from keyed object", () => {
    const obj = { "martin-loop": [{ filename: "martin-loop-0.4.3.tgz" }] };
    assert.deepEqual(getFirstPackArtifact(obj), { filename: "martin-loop-0.4.3.tgz" });
  });

  it("returns null for empty array", () => {
    assert.equal(getFirstPackArtifact([]), null);
  });

  it("returns null for null", () => {
    assert.equal(getFirstPackArtifact(null), null);
  });
});
