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


test("post-release public drift is accepted only when current private authority already incorporates it", () => {
  const source = readFileSync(resolve("scripts/prepare-public-promotion.mjs"), "utf8");
  assert.match(source, /RECONCILED_POST_RELEASE_PUBLIC_DRIFT/);
  assert.match(source, /reviewed-divergence-changed/);
  assert.match(source, /manifest-private-base-mismatch/);
  assert.match(source, /mergeContent\(\{ publicBase, oldPrivate, newPrivate: currentPrivate, path \}\)/);
  assert.match(source, /sameHash\(merged, currentPrivateEntry\.sha256\)/);
  assert.match(source, /public-change-not-incorporated-into-private/);
  assert.match(source, /current private authority does not safely incorporate it/);
});


test("post-release drift conflicts require an explicit reviewed private resolution", () => {
  const source = readFileSync(resolve("scripts/prepare-public-promotion.mjs"), "utf8");
  assert.match(source, /const resolution = resolutionByPath\.get\(path\)/);
  assert.match(source, /resolution\.resolution !== "private"/);
  assert.match(source, /post-release-drift-requires-private-resolution/);
  assert.match(source, /usedResolutions\.add\(path\)/);
  assert.match(source, /REVIEWED_POST_RELEASE_DRIFT_RESOLUTIONS/);
});
