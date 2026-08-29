// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const MANIFEST_PATH = resolve(ROOT, ".martin", "promotion-manifest.json");

function fail(message) {
  console.error(`[public-promotion-guard] BLOCKED: ${message}`);
  process.exit(1);
}

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = error?.stderr?.toString().trim();
    fail(stderr || `git ${args.join(" ")} failed`);
  }
}

function requireSha(value, field) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/i.test(value)) {
    fail(`${field} must be a full 40-character Git SHA`);
  }
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
} catch {
  fail(`missing or invalid ${MANIFEST_PATH}`);
}

if (manifest.schemaVersion !== "martin.public-promotion.v1") {
  fail("unsupported promotion manifest schema");
}

if (manifest.privateRepository !== "martin-Loop/ML_Core_OSS_Internal") {
  fail("privateRepository must be martin-Loop/ML_Core_OSS_Internal");
}

requireSha(manifest.privateMergeSha, "privateMergeSha");
requireSha(manifest.privateMainShaValidated, "privateMainShaValidated");
requireSha(manifest.publicBaseSha, "publicBaseSha");

if (manifest.internalHealthPassed !== true) {
  fail("internalHealthPassed must be true");
}

if (
  typeof manifest.validatedAt !== "string" ||
  Number.isNaN(Date.parse(manifest.validatedAt))
) {
  fail("validatedAt must be a valid ISO-8601 timestamp");
}

// Reject conflict markers — git grep exits nonzero when nothing matches (good),
// and exits 0 when markers ARE found (bad).
try {
  const result = execFileSync(
    "git",
    ["grep", "-n", "-E", "^(<<<<<<<|=======|>>>>>>>)", "--", "."],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  if (result.trim()) {
    fail(`merge-conflict markers found:\n${result.trim()}`);
  }
} catch (err) {
  // exit code 1 = no matches = good; exit code > 1 = git error
  if (err.status !== undefined && err.status > 1) {
    fail(`git grep for conflict markers failed: ${err.stderr?.toString().trim()}`);
  }
}

const currentBranch = git(["branch", "--show-current"]);
if (
  !currentBranch.startsWith("public-staging/") &&
  !process.env.GITHUB_ACTIONS
) {
  fail(
    `public promotion must run from public-staging/*; current branch is ${currentBranch}`
  );
}

const publicBaseType = git(["cat-file", "-t", manifest.publicBaseSha]);
if (publicBaseType !== "commit") {
  fail("publicBaseSha does not resolve to a commit");
}

// git merge-base --is-ancestor exits 0 if ancestor, nonzero if not.
// Our git() helper fails on nonzero — if this throws, publicBaseSha is not an ancestor.
try {
  execFileSync("git", ["merge-base", "--is-ancestor", manifest.publicBaseSha, "HEAD"], {
    cwd: ROOT,
    stdio: "ignore",
  });
} catch {
  fail(`publicBaseSha ${manifest.publicBaseSha} is not an ancestor of HEAD`);
}

console.log("[public-promotion-guard] PASS");
console.log(`private merge:          ${manifest.privateMergeSha}`);
console.log(`validated private main: ${manifest.privateMainShaValidated}`);
console.log(`public base:            ${manifest.publicBaseSha}`);
