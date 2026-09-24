import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("promotion preparer supports explicit reviewed conflict resolutions", () => {
  const source = readFileSync(resolve("scripts/prepare-public-promotion.mjs"), "utf8");
  assert.match(source, /--resolutions/);
  assert.match(source, /resolution=private\|public/);
  assert.match(source, /unused promotion resolutions/);
  assert.match(source, /MANUALLY_RESOLVED_CONTENT_DIVERGENCES/);
});
