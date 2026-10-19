import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findWeakenedTestFiles, isTestPath } from "../src/test-integrity.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

function git(directory: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

const BASE_TEST = "test('add', () => assert.equal(add(2, 3), 5));\ntest('sub', () => assert.equal(sub(3, 2), 1));\n";

async function createRepository(): Promise<{ directory: string; head: string }> {
  const directory = await mkdtemp(join(tmpdir(), "martin-test-weakening-"));
  temporaryDirectories.push(directory);
  git(directory, "init", "-q");
  git(directory, "config", "user.email", "weakening@test.invalid");
  git(directory, "config", "user.name", "Weakening Test");
  git(directory, "config", "core.autocrlf", "false");
  await writeFile(join(directory, "math.js"), "module.exports = {};\n", "utf8");
  await writeFile(join(directory, "math.test.js"), BASE_TEST, "utf8");
  await mkdir(join(directory, "tests"), { recursive: true });
  await writeFile(join(directory, "tests", "suite.py"), "def test_one():\n    assert 1 == 1\n", "utf8");
  git(directory, "add", "-A");
  git(directory, "commit", "-q", "-m", "fixture");
  return { directory, head: git(directory, "rev-parse", "HEAD") };
}

describe("isTestPath", () => {
  it.each(["math.test.js", "a/b.spec.ts", "x.test.mjs", "tests/suite.py", "src/__tests__/a.ts", "test/a.js", "pkg/test_util.py", "pkg/util_test.go"])(
    "recognises %s",
    (file) => expect(isTestPath(file)).toBe(true)
  );

  it.each(["math.js", "src/testing-utils.ts", "latest/a.js", "contest.js"])("ignores %s", (file) =>
    expect(isTestPath(file)).toBe(false)
  );
});

describe("findWeakenedTestFiles", () => {
  it("flags an existing test that lost assertions", async () => {
    const { directory, head } = await createRepository();
    await writeFile(join(directory, "math.test.js"), "test('add', () => assert.equal(add(2, 3), 5));\n", "utf8");

    expect(findWeakenedTestFiles({ repoRoot: directory, baseRef: head, changedFiles: ["math.test.js"] })).toEqual([
      "math.test.js"
    ]);
  });

  it("flags a deleted test file", async () => {
    const { directory, head } = await createRepository();
    await rm(join(directory, "tests", "suite.py"));

    expect(findWeakenedTestFiles({ repoRoot: directory, baseRef: head, changedFiles: ["tests/suite.py"] })).toEqual([
      "tests/suite.py"
    ]);
  });

  it("flags a test weakened inside an attempt commit", async () => {
    const { directory, head } = await createRepository();
    await writeFile(join(directory, "math.test.js"), "", "utf8");
    git(directory, "commit", "-qam", "agent");

    expect(findWeakenedTestFiles({ repoRoot: directory, baseRef: head, changedFiles: ["math.test.js"] })).toEqual([
      "math.test.js"
    ]);
  });

  it("does not flag appended test cases", async () => {
    const { directory, head } = await createRepository();
    await writeFile(join(directory, "math.test.js"), `${BASE_TEST}test('mul', () => assert.equal(mul(2, 3), 6));\n`, "utf8");

    expect(findWeakenedTestFiles({ repoRoot: directory, baseRef: head, changedFiles: ["math.test.js"] })).toEqual([]);
  });

  it("does not flag editing the import line to add a test (single-line test file)", async () => {
    const { directory } = await createRepository();
    const oneLine = [
      "const test=require('node:test');",
      "const assert=require('node:assert/strict');",
      "const {add}=require('./math');",
      "test('add',()=>assert.equal(add(2,3),5));"
    ].join("");
    await writeFile(join(directory, "one.test.js"), `${oneLine}
`, "utf8");
    git(directory, "add", "-A");
    git(directory, "commit", "-q", "-m", "one-line test");
    const base = git(directory, "rev-parse", "HEAD");
    await writeFile(
      join(directory, "one.test.js"),
      `${oneLine.replace("{add}", "{add, subtract}")}test('sub',()=>assert.equal(subtract(3,2),1));
`,
      "utf8"
    );

    expect(findWeakenedTestFiles({ repoRoot: directory, baseRef: base, changedFiles: ["one.test.js"] })).toEqual([]);
  });

  it("flags a test whose expected value was edited to match the implementation", async () => {
    const { directory, head } = await createRepository();
    await writeFile(join(directory, "math.test.js"), BASE_TEST.replace("add(2, 3), 5", "add(2, 3), 6"), "utf8");

    expect(findWeakenedTestFiles({ repoRoot: directory, baseRef: head, changedFiles: ["math.test.js"] })).toEqual([
      "math.test.js"
    ]);
  });

  it("flags a newly skipped test", async () => {
    const { directory, head } = await createRepository();
    await writeFile(join(directory, "math.test.js"), BASE_TEST.replace("test('sub'", "test.skip('sub'"), "utf8");

    expect(findWeakenedTestFiles({ repoRoot: directory, baseRef: head, changedFiles: ["math.test.js"] })).toEqual([
      "math.test.js"
    ]);
  });

  it("flags an inserted focused test even when no existing line was removed", async () => {
    const { directory, head } = await createRepository();
    await writeFile(
      join(directory, "math.test.js"),
      `${BASE_TEST}test.only('mul', () => assert.equal(mul(2, 3), 6));\n`,
      "utf8"
    );

    expect(findWeakenedTestFiles({ repoRoot: directory, baseRef: head, changedFiles: ["math.test.js"] })).toEqual([
      "math.test.js"
    ]);
  });

  it.each(["fdescribe", "fit"])("flags a newly focused %s case", async (focus) => {
    const { directory, head } = await createRepository();
    await writeFile(join(directory, "math.test.js"), `${BASE_TEST}${focus}('focused', () => {});\n`, "utf8");

    expect(findWeakenedTestFiles({ repoRoot: directory, baseRef: head, changedFiles: ["math.test.js"] })).toEqual([
      "math.test.js"
    ]);
  });

  it("flags a newly inserted pytest expected-failure marker", async () => {
    const { directory, head } = await createRepository();
    await writeFile(
      join(directory, "tests", "suite.py"),
      "import pytest\n\n@pytest.mark.xfail\ndef test_one():\n    assert 1 == 1\n",
      "utf8"
    );

    expect(findWeakenedTestFiles({ repoRoot: directory, baseRef: head, changedFiles: ["tests/suite.py"] })).toEqual([
      "tests/suite.py"
    ]);
  });

  it("keeps the strict removed-line rule for golden and data files in test directories", async () => {
    const { directory } = await createRepository();
    const golden = join(directory, "tests", "expected.json");
    await writeFile(golden, `{"a":1}
{"b":2}
`, "utf8");
    git(directory, "add", "-A");
    git(directory, "commit", "-q", "-m", "golden");
    const base = git(directory, "rev-parse", "HEAD");

    await writeFile(golden, `{"a":1}
{"b":3}
`, "utf8");
    expect(findWeakenedTestFiles({ repoRoot: directory, baseRef: base, changedFiles: ["tests/expected.json"] })).toEqual([
      "tests/expected.json"
    ]);

    await writeFile(golden, `{"a":1}
{"b":2}
{"c":3}
`, "utf8");
    expect(findWeakenedTestFiles({ repoRoot: directory, baseRef: base, changedFiles: ["tests/expected.json"] })).toEqual([]);
  });

  it("does not flag brand-new test files or non-test edits", async () => {
    const { directory, head } = await createRepository();
    await writeFile(join(directory, "mul.test.js"), "test('mul', () => {});\n", "utf8");
    await writeFile(join(directory, "math.js"), "", "utf8");

    expect(
      findWeakenedTestFiles({ repoRoot: directory, baseRef: head, changedFiles: ["mul.test.js", "math.js"] })
    ).toEqual([]);
  });

  it.each([
    ["focused-new.test.js", "test.only('focused', () => {});\n"],
    ["suite-new.test.js", "fdescribe('focused', () => {});\n"],
    ["tests/test_expected.py", "import pytest\n\n@pytest.mark.xfail\ndef test_expected():\n    assert True\n"]
  ])("flags focus or expected-failure markers in brand-new test file %s", async (filePath, content) => {
    const { directory, head } = await createRepository();
    const absolutePath = join(directory, filePath);
    await writeFile(absolutePath, content, "utf8");

    expect(findWeakenedTestFiles({ repoRoot: directory, baseRef: head, changedFiles: [filePath] })).toEqual([filePath]);
  });

  it("allows an ordinary brand-new test file", async () => {
    const { directory, head } = await createRepository();
    await writeFile(join(directory, "ordinary-new.test.js"), "test('ordinary', () => assert.equal(1, 1));\n", "utf8");

    expect(findWeakenedTestFiles({ repoRoot: directory, baseRef: head, changedFiles: ["ordinary-new.test.js"] })).toEqual([]);
  });
});
