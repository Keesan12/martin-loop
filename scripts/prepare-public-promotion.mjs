// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { expectedPublicEntries, listSurfaceEntries, sha256 } from "./lib/public-release-surface.mjs";
import { internalHealthCommandSetSha256 } from "./lib/internal-health-commands.mjs";

const PRIVATE_ROOT = process.cwd();
const EXPECTED_PRIVATE_REPOSITORY_FINGERPRINT = "04aac733f3b08513fddcc72a9013b9f59cf7919f9a0a3893d0b3d953929826ec";
const EXPECTED_PUBLIC_SLUG = "Keesan12/martin-loop";
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}
function git(cwd, args, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd,
    encoding,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function gitText(cwd, args) { return git(cwd, args, "utf8").trim(); }
function repositorySlug(cwd) {
  const remote = gitText(cwd, ["config", "--get", "remote.origin.url"]).replaceAll("\\", "/");
  const scpLike = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/iu.exec(remote);
  if (scpLike) return scpLike[1];
  const parsed = new URL(remote);
  if (parsed.hostname.toLowerCase() !== "github.com") throw new Error(`${cwd}: origin must use github.com`);
  return parsed.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/iu, "");
}
function fingerprint(slug) { return createHash("sha256").update(slug).digest("hex"); }
function resolveCommit(cwd, ref, label) {
  const sha = gitText(cwd, ["rev-parse", `${ref}^{commit}`]).toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error(`${label} did not resolve to a full commit SHA`);
  return sha;
}
function readBlob(cwd, ref, path) {
  return git(cwd, ["show", `${ref}:${path}`], null);
}
function writeTarget(root, path, content, mode) {
  const target = resolve(root, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  if (process.platform !== "win32") chmodSync(target, mode === "100755" ? 0o755 : 0o644);
}
function removeTarget(root, path) {
  const target = resolve(root, ...path.split("/"));
  rmSync(target, { force: true });
}
function mergeContent({ publicBase, oldPrivate, newPrivate, path }) {
  const temp = mkdtempSync(join(tmpdir(), "martin-promotion-"));
  try {
    const ours = join(temp, "public");
    const base = join(temp, "private-old");
    const theirs = join(temp, "private-new");
    writeFileSync(ours, publicBase);
    writeFileSync(base, oldPrivate);
    writeFileSync(theirs, newPrivate);
    const result = spawnSync("git", ["merge-file", "-p", ours, base, theirs], { encoding: null });
    if (result.status !== null && result.status > 0 && result.status <= 127) {
      throw new Error(`content divergence requires manual reconciliation: ${path}`);
    }
    if (result.status !== 0) throw new Error(`git merge-file failed for ${path}: ${result.stderr?.toString() ?? ""}`);
    return result.stdout;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
function sameHash(buffer, expected) { return sha256(buffer) === expected; }

const publicRepoArg = arg("--public-repo");
if (!publicRepoArg) {
  console.error("Usage: node scripts/prepare-public-promotion.mjs --public-repo <path> [--health-evidence <path>] [--public-remote origin] [--resolutions <json>]");
  process.exit(2);
}
const resolutionsPath = arg("--resolutions");
const manualResolutions = resolutionsPath
  ? JSON.parse(readFileSync(resolve(PRIVATE_ROOT, resolutionsPath), "utf8"))
  : [];
if (!Array.isArray(manualResolutions)) throw new Error("promotion resolutions must be a JSON array");
const resolutionByPath = new Map();
for (const item of manualResolutions) {
  if (!item || typeof item.path !== "string" || !["private", "public"].includes(item.resolution)) {
    throw new Error("each promotion resolution requires path and resolution=private|public");
  }
  if (item.divergenceKind !== undefined && item.divergenceKind !== "private-only") {
    throw new Error(`promotion resolution ${item.path} has unsupported divergenceKind`);
  }
  if (item.divergenceKind === "private-only" && item.resolution !== "private") {
    throw new Error(`promotion resolution ${item.path} requires resolution=private for divergenceKind=private-only`);
  }
  if (typeof item.reason !== "string" || item.reason.trim().length < 8) {
    throw new Error(`promotion resolution ${item.path} requires a substantive reason`);
  }
  if (typeof item.reviewedBy !== "string" || item.reviewedBy.trim().length === 0) {
    throw new Error(`promotion resolution ${item.path} requires reviewedBy`);
  }
  if (resolutionByPath.has(item.path)) throw new Error(`duplicate promotion resolution: ${item.path}`);
  resolutionByPath.set(item.path, item);
}
const usedResolutions = new Set();

const PUBLIC_ROOT = resolve(publicRepoArg);
if (fingerprint(repositorySlug(PRIVATE_ROOT)) !== EXPECTED_PRIVATE_REPOSITORY_FINGERPRINT) {
  throw new Error("prepare-public-promotion must run from the private release authority repository");
}
if (repositorySlug(PUBLIC_ROOT) !== EXPECTED_PUBLIC_SLUG) {
  throw new Error(`public repository must be ${EXPECTED_PUBLIC_SLUG}`);
}

const privateSha = resolveCommit(PRIVATE_ROOT, "HEAD", "private HEAD");
const packageJson = JSON.parse(readFileSync(resolve(PRIVATE_ROOT, "package.json"), "utf8"));
const version = packageJson.version;
const healthPath = resolve(PRIVATE_ROOT, arg("--health-evidence", `.martin/generated/health-evidence-${version}-${privateSha.slice(0, 12)}.json`));
if (!existsSync(healthPath)) {
  throw new Error(`missing exact-SHA health evidence: ${healthPath}. Run: pnpm release:health:evidence`);
}
const healthBytes = readFileSync(healthPath);
const health = JSON.parse(healthBytes.toString("utf8"));
if (
  health.schemaVersion !== "martin.internal-health.v2" ||
  health.generator !== "scripts/generate-internal-health-evidence.mjs" ||
  health.repositoryFingerprint !== EXPECTED_PRIVATE_REPOSITORY_FINGERPRINT ||
  health.status !== "PASS" ||
  health.validatedReleaseSha?.toLowerCase() !== privateSha ||
  health.version !== version ||
  health.commandSetSha256 !== internalHealthCommandSetSha256() ||
  !Array.isArray(health.commands) ||
  health.commands.length === 0 ||
  health.commands.some((entry) => entry?.exitCode !== 0)
) {
  throw new Error("health evidence is stale, manually edited, incomplete, or not bound to the current private HEAD; regenerate it");
}

const remote = arg("--public-remote", "origin");
git(PUBLIC_ROOT, ["fetch", remote, "main"], "utf8");
const publicBaseSha = resolveCommit(PUBLIC_ROOT, `${remote}/main`, "public base");
const expectedBranch = `public-staging/${version}`;
const branch = gitText(PUBLIC_ROOT, ["branch", "--show-current"]);
const trackedStatus = gitText(PUBLIC_ROOT, ["status", "--porcelain", "--untracked-files=no"]);
if (trackedStatus) throw new Error(`public repository has tracked changes:\n${trackedStatus}`);

if (branch !== expectedBranch) {
  const head = resolveCommit(PUBLIC_ROOT, "HEAD", "public HEAD");
  if (head !== publicBaseSha) throw new Error(`public repo must be at ${publicBaseSha} before creating ${expectedBranch}`);
  const localExists = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${expectedBranch}`], { cwd: PUBLIC_ROOT }).status === 0;
  if (localExists) throw new Error(`local ${expectedBranch} already exists; inspect it instead of resetting it`);
  git(PUBLIC_ROOT, ["switch", "-c", expectedBranch, publicBaseSha], "utf8");
} else {
  const head = resolveCommit(PUBLIC_ROOT, "HEAD", "public staging HEAD");
  if (head !== publicBaseSha) throw new Error(`${expectedBranch} must start exactly at current public main ${publicBaseSha}; do not reuse a stale staging branch`);
}

let previousManifest;
try {
  previousManifest = JSON.parse(readBlob(PUBLIC_ROOT, publicBaseSha, ".martin/promotion-manifest.json").toString("utf8"));
} catch {
  throw new Error("current public main is missing a valid .martin/promotion-manifest.json");
}

const publicBaseEntries = listSurfaceEntries(PUBLIC_ROOT, publicBaseSha);
const expectedPrevious = expectedPublicEntries(previousManifest.surfaceEntries, previousManifest.reviewedDivergences ?? []);
const previousExpectedByPath = new Map(expectedPrevious.map((entry) => [entry.path, entry]));
const publicBaseByPath = new Map(publicBaseEntries.map((entry) => [entry.path, entry]));
const previousMissing = [...previousExpectedByPath.keys()].filter((path) => !publicBaseByPath.has(path));
const previousExtra = [...publicBaseByPath.keys()].filter((path) => !previousExpectedByPath.has(path));
const previousChanged = [...previousExpectedByPath.keys()].filter((path) => {
  const actual = publicBaseByPath.get(path);
  const expected = previousExpectedByPath.get(path);
  return actual && (actual.sha256 !== expected.sha256 || actual.mode !== expected.mode);
});

const privateEntries = listSurfaceEntries(PRIVATE_ROOT, privateSha);
const privateByPath = new Map(privateEntries.map((entry) => [entry.path, entry]));
const oldDivergences = previousManifest.reviewedDivergences ?? [];
const oldByPath = new Map(oldDivergences.map((entry) => [entry.path, entry]));
const previousPrivateSha = previousManifest.privateMainShaValidated;

// Post-manifest extra files on public main require explicit handling:
//   absent from private           → BLOCK (content would be silently lost)
//   identical to private          → auto-reconcile
//   differs, no resolution        → BLOCK (differs-from-private)
//   differs, resolution="private" → accepted as reviewed post-release extra resolution
//   differs, resolution="public"  → BLOCK (public authority cannot win here)
const unreconciledExtra = [];
const reconciledExactExtra = [];
const reviewedExtraResolutions = [];
for (const path of previousExtra) {
  const publicEntry = publicBaseByPath.get(path);
  const privateEntry = privateByPath.get(path);
  if (!privateEntry) {
    unreconciledExtra.push(`${path}:absent-from-private`);
    continue;
  }
  if (publicEntry.sha256 === privateEntry.sha256 && publicEntry.mode === privateEntry.mode) {
    reconciledExactExtra.push(path);
    continue;
  }
  // Differs — require an explicit reviewed resolution with resolution="private".
  const resolution = resolutionByPath.get(path);
  if (!resolution) {
    unreconciledExtra.push(`${path}:differs-from-private`);
    continue;
  }
  if (resolution.resolution !== "private") {
    unreconciledExtra.push(`${path}:post-release-extra-requires-private-resolution`);
    continue;
  }
  usedResolutions.add(path);
  reviewedExtraResolutions.push({ path, resolution: resolution.resolution, reason: resolution.reason, reviewedBy: resolution.reviewedBy });
}
if (previousMissing.length || unreconciledExtra.length) {
  throw new Error(`public main drifted from its own promotion manifest; missing=${previousMissing.join(",")} extra-unreconciled=${unreconciledExtra.join(",")}`);
}
if (reconciledExactExtra.length) {
  console.log(`[prepare] ${reconciledExactExtra.length} post-manifest public file(s) identical to private authority: ${reconciledExactExtra.join(", ")}`);
}
if (reviewedExtraResolutions.length) {
  console.log(`[prepare] ${reviewedExtraResolutions.length} post-manifest extra public file(s) accepted via reviewed private resolution: ${reviewedExtraResolutions.map((r) => r.path).join(", ")}`);
}

const reconciledPublicDrift = [];
const reviewedPublicDriftResolutions = [];
const unreconciledPublicDrift = [];
for (const path of previousChanged) {
  const expected = previousExpectedByPath.get(path);
  const actual = publicBaseByPath.get(path);
  if (!expected || !actual) {
    unreconciledPublicDrift.push(`${path}:missing-coordinates`);
    continue;
  }
  const previousDivergence = oldByPath.get(path);
  if (previousDivergence) {
    const resolution = resolutionByPath.get(path);
    if (previousDivergence.kind === "content" && resolution?.resolution === "private") {
      usedResolutions.add(path);
      reviewedPublicDriftResolutions.push({
        path,
        resolution: resolution.resolution,
        reason: resolution.reason,
        reviewedBy: resolution.reviewedBy,
      });
      reconciledPublicDrift.push(path);
      continue;
    }
    unreconciledPublicDrift.push(`${path}:reviewed-divergence-changed`);
    continue;
  }
  const currentPrivateEntry = privateByPath.get(path);
  if (!currentPrivateEntry) {
    unreconciledPublicDrift.push(`${path}:missing-current-private`);
    continue;
  }

  let oldPrivate;
  let currentPrivate;
  let publicBase;
  try {
    oldPrivate = readBlob(PRIVATE_ROOT, previousPrivateSha, path);
    currentPrivate = readBlob(PRIVATE_ROOT, privateSha, path);
    publicBase = readBlob(PUBLIC_ROOT, publicBaseSha, path);
  } catch {
    unreconciledPublicDrift.push(`${path}:unreadable-history`);
    continue;
  }

  if (!sameHash(oldPrivate, expected.sha256)) {
    unreconciledPublicDrift.push(`${path}:manifest-private-base-mismatch`);
    continue;
  }

  let merged;
  try {
    merged = mergeContent({ publicBase, oldPrivate, newPrivate: currentPrivate, path });
  } catch {
    const resolution = resolutionByPath.get(path);
    if (!resolution) {
      unreconciledPublicDrift.push(`${path}:merge-conflict`);
      continue;
    }
    if (resolution.resolution !== "private") {
      unreconciledPublicDrift.push(`${path}:post-release-drift-requires-private-resolution`);
      continue;
    }
    usedResolutions.add(path);
    reviewedPublicDriftResolutions.push({
      path,
      resolution: resolution.resolution,
      reason: resolution.reason,
      reviewedBy: resolution.reviewedBy,
    });
    reconciledPublicDrift.push(path);
    continue;
  }

  if (!sameHash(merged, currentPrivateEntry.sha256)) {
    unreconciledPublicDrift.push(`${path}:public-change-not-incorporated-into-private`);
    continue;
  }

  if (actual.mode !== expected.mode && actual.mode !== currentPrivateEntry.mode) {
    unreconciledPublicDrift.push(`${path}:public-mode-not-incorporated-into-private`);
    continue;
  }

  reconciledPublicDrift.push(path);
}

if (unreconciledPublicDrift.length) {
  throw new Error(`public main drifted from its own promotion manifest and current private authority does not safely incorporate it; unreconciled=${unreconciledPublicDrift.join(",")}`);
}

const privateOnly = new Set(oldDivergences.filter((entry) => entry.kind === "private-only").map((entry) => entry.path));
const publicOnly = new Set(oldDivergences.filter((entry) => entry.kind === "public-only").map((entry) => entry.path));
const contentDivergent = new Set(oldDivergences.filter((entry) => entry.kind === "content").map((entry) => entry.path));

const target = new Map();
const refreshedDivergences = [];
const autoMerged = [];
const manuallyResolved = [];
const newPrivateOnly = [];
const collapsedPublicOnly = [];
const removedPublicOnly = [];

for (const entry of privateEntries) {
  const path = entry.path;
  const previous = oldByPath.get(path);
  const resolution = resolutionByPath.get(path);
  if (resolution?.divergenceKind === "private-only") {
    if (previous && previous.kind !== "private-only") {
      throw new Error(`cannot reclassify ${path} from ${previous.kind} to private-only`);
    }
    usedResolutions.add(path);
    newPrivateOnly.push(path);
    refreshedDivergences.push({
      path,
      kind: "private-only",
      privateSha256: entry.sha256,
      privateMode: entry.mode,
      publicSha256: null,
      reason: resolution.reason,
      reviewedBy: resolution.reviewedBy,
    });
    continue;
  }
  if (previous?.kind === "private-only") {
    refreshedDivergences.push({
      ...previous,
      privateSha256: entry.sha256,
      privateMode: entry.mode,
      publicSha256: null,
    });
    continue;
  }
  if (previous?.kind === "public-only") {
    if (resolution?.resolution !== "private") {
      throw new Error(`divergence classification conflict: ${path} is now present privately but was public-only`);
    }
    usedResolutions.add(path);
    collapsedPublicOnly.push(path);
    target.set(path, { content: readBlob(PRIVATE_ROOT, privateSha, path), mode: entry.mode });
    continue;
  }
  if (previous?.kind === "content") {
    const basePublicEntry = publicBaseByPath.get(path);
    if (!basePublicEntry) throw new Error(`content-divergent public path disappeared: ${path}`);
    if (basePublicEntry.sha256 !== previous.publicSha256) {
      const resolution = resolutionByPath.get(path);
      if (resolution?.resolution !== "private") {
        throw new Error(`stale public divergence hash for ${path}; public main no longer matches reviewed content`);
      }
      const currentPrivate = readBlob(PRIVATE_ROOT, privateSha, path);
      target.set(path, { content: currentPrivate, mode: entry.mode });
      usedResolutions.add(path);
      manuallyResolved.push({
        path,
        resolution: resolution.resolution,
        reason: resolution.reason,
        reviewedBy: resolution.reviewedBy,
      });
      continue;
    }
    const previousPrivateSha = previousManifest.privateMainShaValidated;
    const oldPrivate = readBlob(PRIVATE_ROOT, previousPrivateSha, path);
    if (!sameHash(oldPrivate, previous.privateSha256)) throw new Error(`stale private divergence hash for ${path}; previous manifest is inconsistent`);
    const currentPrivate = readBlob(PRIVATE_ROOT, privateSha, path);
    const publicBase = readBlob(PUBLIC_ROOT, publicBaseSha, path);
    let merged;
    if (entry.sha256 === previous.privateSha256) {
      merged = publicBase;
    } else {
      try {
        merged = mergeContent({ publicBase, oldPrivate, newPrivate: currentPrivate, path });
      } catch (error) {
        const resolution = resolutionByPath.get(path);
        if (!resolution || !String(error?.message ?? error).startsWith("content divergence requires manual reconciliation:")) throw error;
        merged = resolution.resolution === "private" ? currentPrivate : publicBase;
        usedResolutions.add(path);
        manuallyResolved.push({
          path,
          resolution: resolution.resolution,
          reason: resolution.reason,
          reviewedBy: resolution.reviewedBy,
        });
      }
    }
    const mergedHash = sha256(merged);
    target.set(path, { content: merged, mode: basePublicEntry.mode });
    if (mergedHash !== entry.sha256 || basePublicEntry.mode !== entry.mode) {
      refreshedDivergences.push({
        ...previous,
        privateSha256: entry.sha256,
        privateMode: entry.mode,
        publicSha256: mergedHash,
        publicMode: basePublicEntry.mode,
      });
    }
    if (entry.sha256 !== previous.privateSha256) autoMerged.push(path);
    continue;
  }
  target.set(path, { content: readBlob(PRIVATE_ROOT, privateSha, path), mode: entry.mode });
}

for (const previous of oldDivergences) {
  if (previous.kind === "private-only" && !privateByPath.has(previous.path)) {
    continue;
  }
  if (previous.kind === "public-only") {
    if (privateByPath.has(previous.path)) continue;
    const resolution = resolutionByPath.get(previous.path);
    if (resolution?.resolution === "private") {
      usedResolutions.add(previous.path);
      removedPublicOnly.push(previous.path);
      continue;
    }
    const base = publicBaseByPath.get(previous.path);
    if (!base) continue;
    if (base.sha256 !== previous.publicSha256) throw new Error(`stale public-only divergence hash for ${previous.path}`);
    target.set(previous.path, { content: readBlob(PUBLIC_ROOT, publicBaseSha, previous.path), mode: base.mode });
    refreshedDivergences.push({
      ...previous,
      privateSha256: null,
      publicSha256: base.sha256,
      publicMode: base.mode,
    });
  }
  if (previous.kind === "content" && !privateByPath.has(previous.path)) {
    throw new Error(`content-divergent path was removed privately and needs explicit reclassification: ${previous.path}`);
  }
}

const unusedResolutions = [...resolutionByPath.keys()].filter((path) => !usedResolutions.has(path));
if (unusedResolutions.length) {
  throw new Error(`unused promotion resolutions: ${unusedResolutions.join(", ")}`);
}

const targetPaths = new Set(target.keys());
for (const baseEntry of publicBaseEntries) {
  if (!targetPaths.has(baseEntry.path)) removeTarget(PUBLIC_ROOT, baseEntry.path);
}
for (const [path, item] of target) writeTarget(PUBLIC_ROOT, path, item.content, item.mode);

git(PUBLIC_ROOT, ["add", "-A"], "utf8");
for (const [path, item] of target) {
  if (item.mode === "100755") git(PUBLIC_ROOT, ["update-index", "--chmod=+x", "--", path], "utf8");
  else if (item.mode === "100644") git(PUBLIC_ROOT, ["update-index", "--chmod=-x", "--", path], "utf8");
}

const temp = mkdtempSync(join(tmpdir(), "martin-promotion-manifest-"));
try {
  const divergencePath = join(temp, "divergences.json");
  writeFileSync(divergencePath, `${JSON.stringify(refreshedDivergences, null, 2)}\n`);
  const generator = resolve(PRIVATE_ROOT, "scripts", "generate-public-promotion-manifest.mjs");
  const manifestPath = resolve(PUBLIC_ROOT, ".martin", "promotion-manifest.json");
  execFileSync(process.execPath, [
    generator,
    "--private-ref", privateSha,
    "--private-merge", privateSha,
    "--public-base", publicBaseSha,
    "--internal-health-evidence", healthPath,
    "--divergences", divergencePath,
    "--output", manifestPath,
  ], { cwd: PRIVATE_ROOT, stdio: "inherit" });
  git(PUBLIC_ROOT, ["add", "-f", ".martin/promotion-manifest.json"], "utf8");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log(`[public-promotion-prepare] READY version=${version} private=${privateSha} publicBase=${publicBaseSha}`);
console.log(`[public-promotion-prepare] RECONCILED_POST_RELEASE_PUBLIC_DRIFT=${reconciledPublicDrift.length}`);
if (reconciledPublicDrift.length) console.log(reconciledPublicDrift.join("\n"));
console.log(`[public-promotion-prepare] REVIEWED_POST_RELEASE_DRIFT_RESOLUTIONS=${reviewedPublicDriftResolutions.length}`);
for (const item of reviewedPublicDriftResolutions) {
  console.log(`${item.path}\t${item.resolution}\t${item.reviewedBy}\t${item.reason}`);
}
console.log(`[public-promotion-prepare] AUTO_MERGED_CONTENT_DIVERGENCES=${autoMerged.length}`);
if (autoMerged.length) console.log(autoMerged.join("\n"));
console.log(`[public-promotion-prepare] MANUALLY_RESOLVED_CONTENT_DIVERGENCES=${manuallyResolved.length}`);
for (const item of manuallyResolved) {
  console.log(`${item.path}\t${item.resolution}\t${item.reviewedBy}\t${item.reason}`);
}
console.log(`[public-promotion-prepare] NEW_PRIVATE_ONLY_DIVERGENCES=${newPrivateOnly.length}`);
if (newPrivateOnly.length) console.log(newPrivateOnly.join("\n"));
console.log(`[public-promotion-prepare] COLLAPSED_PUBLIC_ONLY_DIVERGENCES=${collapsedPublicOnly.length}`);
if (collapsedPublicOnly.length) console.log(collapsedPublicOnly.join("\n"));
console.log(`[public-promotion-prepare] REMOVED_PUBLIC_ONLY_DIVERGENCES=${removedPublicOnly.length}`);
if (removedPublicOnly.length) console.log(removedPublicOnly.join("\n"));
console.log(`[public-promotion-prepare] NEXT: review staged diff in ${PUBLIC_ROOT}, commit, then run pnpm public:promotion-guard`);
