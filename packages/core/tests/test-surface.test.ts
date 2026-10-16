import { describe, expect, it } from "vitest";

import { extractTestSurface, testSurfaceWeakened } from "../src/test-surface.js";

describe("extractTestSurface", () => {
  it("captures a node:test assertion and a test case on one line", () => {
    const surface = extractTestSurface(
      "const test=require('node:test');const assert=require('node:assert/strict');const {add}=require('./math');test('add',()=>assert.equal(add(2,3),5));\n"
    );

    expect(surface.assertions).toEqual(["assert.equal(add(2,3),5)"]);
    expect(surface.cases).toBe(1);
    expect(surface.skips).toBe(0);
  });

  it("captures jest/chai chains as one assertion", () => {
    const surface = extractTestSurface(
      "it('a', () => { expect(sum(1, 2)).toBe(3); expect(list).not.toContain( 'x' ); expect(y).to.equal(2); });\n"
    );

    expect(surface.assertions).toEqual([
      "expect(sum(1,2)).toBe(3)",
      "expect(list).not.toContain('x')",
      "expect(y).to.equal(2)"
    ]);
    expect(surface.cases).toBe(1);
  });

  it("ignores whitespace and line breaks inside an assertion", () => {
    const compact = extractTestSurface("assert.deepEqual(f(1), { a: 1, b: [2, 3] });");
    const spread = extractTestSurface("assert.deepEqual(\n  f(1),\n  { a: 1, b: [2, 3] }\n);");

    expect(spread.assertions).toEqual(compact.assertions);
  });

  it("is not confused by parentheses inside string literals", () => {
    const surface = extractTestSurface("assert.equal(parse(')('), 'a(b');\nassert.ok(x);");

    expect(surface.assertions).toEqual(["assert.equal(parse(')('),'a(b')", "assert.ok(x)"]);
  });

  it("understands python, go, rust and java assertions and cases", () => {
    const python = extractTestSurface("def test_one():\n    assert add(1, 2) == 3\n    self.assertEqual(x, 1)\n");
    expect(python.assertions.slice().sort()).toEqual(["assert add(1,2)==3", "assertEqual(x,1)"]);
    expect(python.cases).toBe(1);
    expect(extractTestSurface("func TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Errorf(\"bad\")\n\t}\n\trequire.Equal(t, 3, Add(1, 2))\n}\n")).toMatchObject({
      assertions: ['t.Errorf("bad")', "require.Equal(t,3,Add(1,2))"],
      cases: 1
    });
    expect(extractTestSurface("#[test]\nfn adds() {\n    assert_eq!(add(1, 2), 3);\n}\n")).toMatchObject({
      assertions: ["assert_eq!(add(1,2),3)"],
      cases: 1
    });
    expect(extractTestSurface("@Test\nvoid adds() {\n    assertEquals(3, add(1, 2));\n}\n")).toMatchObject({
      assertions: ["assertEquals(3,add(1,2))"],
      cases: 1
    });
  });

  it("does not treat require() or ordinary calls as assertions", () => {
    const surface = extractTestSurface("const m = require('./math');\nconst r = check(latest(3));\nvalidate(x);\n");

    expect(surface.assertions).toEqual([]);
    expect(surface.cases).toBe(0);
  });

  it("counts skip and disable markers", () => {
    const surface = extractTestSurface(
      "test.skip('a', f);\nit.todo('b');\nxit('c', f);\n@pytest.mark.skip\ndef test_d(): pass\nt.Skip(\"later\")\n#[ignore]\n"
    );

    expect(surface.skips).toBe(6);
  });

  it("does not count the word skip in ordinary code", () => {
    expect(extractTestSurface("const skipped = list.filter(skip => skip.ok);\n").skips).toBe(0);
  });
});

describe("testSurfaceWeakened", () => {
  const before = "const {add}=require('./math');\ntest('add',()=>assert.equal(add(2,3),5));\n";

  it("allows edits to import and setup lines while adding a test", () => {
    const after =
      "const {add, subtract}=require('./math');\ntest('add',()=>assert.equal(add(2,3),5));\ntest('sub',()=>assert.equal(subtract(3,2),1));\n";

    expect(testSurfaceWeakened(before, after)).toBe(false);
  });

  it("allows the whole file to be reformatted without changing assertions", () => {
    const after = "const { add } = require('./math');\n\ntest('add', () => {\n  assert.equal(add(2, 3), 5);\n});\n";

    expect(testSurfaceWeakened(before, after)).toBe(false);
  });

  it.each([
    ["an assertion is removed", "const {add}=require('./math');\ntest('add',()=>{});\n"],
    ["an expected value is changed", "const {add}=require('./math');\ntest('add',()=>assert.equal(add(2,3),6));\n"],
    ["the actual expression is changed", "const {add}=require('./math');\ntest('add',()=>assert.equal(add(2,2),5));\n"],
    ["the test case is removed", "const {add}=require('./math');\nassert.equal(add(2,3),5);\n"],
    ["the case is skipped", "const {add}=require('./math');\ntest.skip('add',()=>assert.equal(add(2,3),5));\n"],
    ["the file is emptied", ""]
  ])("flags it when %s", (_name, after) => {
    expect(testSurfaceWeakened(before, after)).toBe(true);
  });

  it("flags a removed python assert but allows an added one", () => {
    const py = "def test_one():\n    assert add(1, 2) == 3\n    assert add(2, 2) == 4\n";

    expect(testSurfaceWeakened(py, "def test_one():\n    assert add(1, 2) == 3\n")).toBe(true);
    expect(testSurfaceWeakened(py, `${py}    assert add(3, 3) == 6\n`)).toBe(false);
  });

  it("reports unparseable content as having no surface so callers can fall back", () => {
    expect(extractTestSurface('{"expected": [1, 2, 3]}').assertions).toEqual([]);
    expect(extractTestSurface('{"expected": [1, 2, 3]}').cases).toBe(0);
  });
});
