// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SURFACE_SCHEMA, compareSurface, expectedPublicEntries, hashSurface, listSurfaceEntries, surfaceSpecHash } from "./lib/public-release-surface.mjs";

const ROOT = process.cwd();
const MANIFEST_PATH = resolve(ROOT, ".martin", "promotion-manifest.json");
function fail(message) { console.error(`[public-promotion-guard] BLOCKED: ${message}`); process.exit(1); }
function git(args) {
  try { return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch (error) { fail(error?.stderr?.toString().trim() || `git ${args.join(" ")} failed`); }
}
function requireSha(value, field) { if (typeof value !== "string" || !/^[a-f0-9]{40}$/iu.test(value)) fail(`${field} must be a full 40-character Git SHA`); }

let manifest;
try { manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")); } catch { fail(`missing or invalid ${MANIFEST_PATH}`); }
if (manifest.schemaVersion !== SURFACE_SCHEMA) fail("unsupported promotion manifest schema");
if (manifest.sourceAuthority !== "validated-internal-release-source") fail("sourceAuthority must identify the validated internal release source");
if (manifest.sourceRepositoryFingerprint !== "04aac733f3b08513fddcc72a9013b9f59cf7919f9a0a3893d0b3d953929826ec") fail("source repository fingerprint does not match the release authority");
for (const field of ["privateMergeSha", "privateMainShaValidated", "publicBaseSha"]) requireSha(manifest[field], field);
if (manifest.internalHealthPassed !== true) fail("internalHealthPassed must be true");
if (typeof manifest.internalHealthEvidenceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(manifest.internalHealthEvidenceSha256)) fail("internal health evidence digest is required");
if (typeof manifest.validatedAt !== "string" || Number.isNaN(Date.parse(manifest.validatedAt))) fail("validatedAt must be a valid ISO-8601 timestamp");
if (manifest.surfaceSpecHash !== surfaceSpecHash()) fail("canonical release-surface specification changed after validation");
if (!Array.isArray(manifest.surfaceEntries) || hashSurface(manifest.surfaceEntries) !== manifest.surfaceHash) fail("private release-surface inventory is malformed or tampered");

try {
  const markers = execFileSync("git", ["grep", "-n", "-E", "^(<<<<<<<|=======|>>>>>>>)", "--", "."], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (markers.trim()) fail(`merge-conflict markers found:\n${markers.trim()}`);
} catch (error) { if (error.status !== 1) fail(`git grep for conflict markers failed: ${error.stderr?.toString().trim()}`); }

const branch = git(["branch", "--show-current"]);
if (!branch.startsWith("public-staging/") && !process.env.GITHUB_ACTIONS) fail(`public promotion must run from public-staging/*; current branch is ${branch}`);
if (git(["cat-file", "-t", manifest.publicBaseSha]) !== "commit") fail("publicBaseSha does not resolve to a commit");
try { execFileSync("git", ["merge-base", "--is-ancestor", manifest.publicBaseSha, "HEAD"], { cwd: ROOT, stdio: "ignore" }); }
catch { fail(`publicBaseSha ${manifest.publicBaseSha} is not an ancestor of HEAD`); }

let expected;
try { expected = expectedPublicEntries(manifest.surfaceEntries, manifest.reviewedDivergences ?? []); }
catch (error) { fail(error.message); }
const actual = listSurfaceEntries(ROOT, "HEAD");
const comparison = compareSurface(expected, actual);
if (!comparison.matches) {
  const details = [comparison.missing.length && `missing: ${comparison.missing.join(", ")}`, comparison.extra.length && `unreviewed extra: ${comparison.extra.join(", ")}`, comparison.changed.length && `content mismatch: ${comparison.changed.join(", ")}`].filter(Boolean).join("; ");
  fail(`public surface differs from validated private surface (${details})`);
}
console.log(`[public-promotion-guard] PASS entries=${actual.length} private=${manifest.privateMainShaValidated} publicBase=${manifest.publicBaseSha}`);
