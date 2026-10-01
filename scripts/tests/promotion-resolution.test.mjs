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

test("reviewed resolutions can make a private file private-only", () => {
  const source = readFileSync(resolve("scripts/prepare-public-promotion.mjs"), "utf8");
  assert.match(source, /divergenceKind/);
  assert.match(source, /private-only/);
  assert.match(source, /NEW_PRIVATE_ONLY_DIVERGENCES/);
});

test("reviewed private resolutions can collapse or remove old public-only divergences", () => {
  const source = readFileSync(resolve("scripts/prepare-public-promotion.mjs"), "utf8");
  assert.match(source, /COLLAPSED_PUBLIC_ONLY_DIVERGENCES/);
  assert.match(source, /REMOVED_PUBLIC_ONLY_DIVERGENCES/);
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

test("post-manifest extra public file identical to private auto-reconciles", () => {
  const source = readFileSync(resolve("scripts/prepare-public-promotion.mjs"), "utf8");
  assert.match(source, /for \(const path of previousExtra\)/);
  assert.match(source, /reconciledExactExtra/);
  assert.match(source, /post-manifest public file/);
});

test("post-manifest extra public file absent from private is blocked", () => {
  const source = readFileSync(resolve("scripts/prepare-public-promotion.mjs"), "utf8");
  assert.match(source, /absent-from-private/);
  assert.match(source, /extra-unreconciled=/);
});

test("post-manifest extra public file differing without resolution is blocked", () => {
  const source = readFileSync(resolve("scripts/prepare-public-promotion.mjs"), "utf8");
  assert.match(source, /differs-from-private/);
  assert.match(source, /publicEntry\.sha256 === privateEntry\.sha256/);
});

test("post-manifest extra public file differing with reviewed private resolution passes", () => {
  const source = readFileSync(resolve("scripts/prepare-public-promotion.mjs"), "utf8");
  assert.match(source, /reviewedExtraResolutions/);
  assert.match(source, /post-release-extra-requires-private-resolution/);
  assert.match(source, /resolution\.resolution !== "private"/);
});

test("post-manifest extra public file differing with public resolution is blocked", () => {
  const source = readFileSync(resolve("scripts/prepare-public-promotion.mjs"), "utf8");
  assert.match(source, /post-release-extra-requires-private-resolution/);
});


test("changed reviewed content divergence can collapse to private only through explicit reviewed private resolution", () => {
  const source = readFileSync(resolve("scripts/prepare-public-promotion.mjs"), "utf8");
  assert.match(source, /previousDivergence\.kind === "content"/);
  assert.match(source, /resolution\?\.resolution === "private"/);
  assert.match(source, /stale public divergence hash/);
  assert.match(source, /target\.set\(path, \{ content: currentPrivate, mode: entry\.mode \}\)/);
  assert.match(source, /manuallyResolved\.push/);
});

test("changed reviewed content divergence remains fail-closed without a private resolution", () => {
  const source = readFileSync(resolve("scripts/prepare-public-promotion.mjs"), "utf8");
  assert.match(source, /reviewed-divergence-changed/);
  assert.match(source, /resolution\?\.resolution !== "private"/);
});


test("public promotion guard blocks canonical surface changes on non-staging PRs", () => {
  const workflow = readFileSync(resolve(".github/workflows/public-promotion-guard.yml"), "utf8");
  assert.match(workflow, /reject-non-promotion-surface-drift/);
  assert.match(workflow, /Reject canonical surface drift outside governed promotion/);
  assert.match(workflow, /isReleaseSurfacePath/);
  assert.match(workflow, /public-staging\/\*/);
  assert.doesNotMatch(workflow, /No public promotion manifest required/);
});


test("public promotion workflow is scoped to the public repository", () => {
  const workflow = readFileSync(resolve(".github/workflows/public-promotion-guard.yml"), "utf8");
  assert.match(workflow, /github\.repository == 'Keesan12\/martin-loop'/);
  assert.match(workflow, /reject-non-promotion-surface-drift/);
  assert.match(workflow, /verify-public-promotion/);
});


test("merge-file conflict counts from 1 through 127 are treated as manual reconciliation", () => {
  const source = readFileSync(resolve("scripts/prepare-public-promotion.mjs"), "utf8");
  assert.match(source, /result\.status > 0 && result\.status <= 127/);
  assert.match(source, /content divergence requires manual reconciliation/);
  assert.match(source, /git merge-file failed/);
});


test("promotion preparer force-stages the ignored generated promotion manifest", () => {
  const source = readFileSync(resolve("scripts/prepare-public-promotion.mjs"), "utf8");
  assert.match(
    source,
    /git\(PUBLIC_ROOT, \["add", "-f", "\.martin\/promotion-manifest\.json"\], "utf8"\)/,
  );
});
