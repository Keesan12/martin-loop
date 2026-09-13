// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const SURFACE_SCHEMA = "martin.public-promotion.v2";
export const SURFACE_SPEC = Object.freeze({
  // The authority is the complete tracked tree. Exclusions are exceptional,
  // explicit, and hashed as part of the surface specification.
  excludedFiles: Object.freeze([".martin/promotion-manifest.json"]),
  excludedPrefixes: Object.freeze([]),
});

export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
export function surfaceSpecHash() { return sha256(JSON.stringify(SURFACE_SPEC)); }
export function isReleaseSurfacePath(path) { return !SURFACE_SPEC.excludedFiles.includes(path) && !SURFACE_SPEC.excludedPrefixes.some((prefix) => path.startsWith(prefix)); }
function comparePath(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function git(cwd, args, encoding = "utf8") { return execFileSync("git", args, { cwd, encoding, stdio: ["ignore", "pipe", "pipe"] }); }
function gitBuffer(cwd, args, input) { return execFileSync("git", args, { cwd, input, encoding: null, maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }); }

export function listSurfaceEntries(cwd, ref = "HEAD") {
  const tree = gitBuffer(cwd, ["ls-tree", "-r", "-z", ref]);
  const selected = tree.toString("utf8").split("\0").filter(Boolean).map((record) => {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/u.exec(record);
    if (!match) throw new Error(`malformed git tree record: ${record}`);
    return { type: match[2], object: match[3], path: match[4] };
  }).filter((entry) => entry.type === "blob" && isReleaseSurfacePath(entry.path)).sort((a, b) => comparePath(a.path, b.path));
  if (selected.length === 0) return [];
  const batch = gitBuffer(cwd, ["cat-file", "--batch"], `${selected.map((entry) => entry.object).join("\n")}\n`);
  let offset = 0;
  return selected.map((entry) => {
    const headerEnd = batch.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error(`missing git cat-file header for ${entry.path}`);
    const header = batch.subarray(offset, headerEnd).toString("utf8");
    const match = /^([a-f0-9]+) blob (\d+)$/u.exec(header);
    if (!match || match[1] !== entry.object) throw new Error(`unexpected git cat-file header for ${entry.path}: ${header}`);
    const size = Number(match[2]);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (batch[contentEnd] !== 0x0a) throw new Error(`malformed git cat-file payload for ${entry.path}`);
    offset = contentEnd + 1;
    return { path: entry.path, sha256: sha256(batch.subarray(contentStart, contentEnd)) };
  });
}
export function hashSurface(entries) { return sha256(JSON.stringify([...entries].sort((a, b) => comparePath(a.path, b.path)))); }

export function validateReviewedDivergences(entries, divergences) {
  const privateEntries = new Map(entries.map((entry) => [entry.path, entry.sha256]));
  const seen = new Set();
  for (const item of divergences) {
    if (!item || typeof item.path !== "string" || !isReleaseSurfacePath(item.path)) throw new Error("reviewed divergence path must belong to the canonical release surface");
    if (seen.has(item.path)) throw new Error(`duplicate reviewed divergence: ${item.path}`);
    seen.add(item.path);
    if (!["content", "public-only", "private-only"].includes(item.kind)) throw new Error(`unsupported divergence kind for ${item.path}`);
    if (typeof item.reason !== "string" || item.reason.trim().length < 8) throw new Error(`reviewed divergence ${item.path} requires a substantive reason`);
    if (typeof item.reviewedBy !== "string" || item.reviewedBy.trim().length === 0) throw new Error(`reviewed divergence ${item.path} requires reviewedBy`);
    const privateHash = privateEntries.get(item.path);
    if (item.kind === "public-only" && privateHash) throw new Error(`${item.path} is not public-only`);
    if ((item.kind === "content" || item.kind === "private-only") && !privateHash) throw new Error(`${item.path} is absent from the private surface`);
    if (item.privateSha256 !== (privateHash ?? null)) throw new Error(`private hash mismatch for reviewed divergence ${item.path}`);
    const expectsPublic = item.kind !== "private-only";
    if (expectsPublic !== (typeof item.publicSha256 === "string" && /^[a-f0-9]{64}$/u.test(item.publicSha256))) throw new Error(`invalid public hash for reviewed divergence ${item.path}`);
  }
}

export function expectedPublicEntries(entries, divergences = []) {
  validateReviewedDivergences(entries, divergences);
  const expected = new Map(entries.map((entry) => [entry.path, entry.sha256]));
  for (const item of divergences) {
    if (item.kind === "private-only") expected.delete(item.path);
    else expected.set(item.path, item.publicSha256);
  }
  return [...expected].map(([path, digest]) => ({ path, sha256: digest })).sort((a, b) => comparePath(a.path, b.path));
}
export function compareSurface(expected, actual) {
  const expectedMap = new Map(expected.map((entry) => [entry.path, entry.sha256]));
  const actualMap = new Map(actual.map((entry) => [entry.path, entry.sha256]));
  const missing = [...expectedMap.keys()].filter((path) => !actualMap.has(path));
  const extra = [...actualMap.keys()].filter((path) => !expectedMap.has(path));
  const changed = [...expectedMap.keys()].filter((path) => actualMap.has(path) && actualMap.get(path) !== expectedMap.get(path));
  return { missing, extra, changed, matches: missing.length === 0 && extra.length === 0 && changed.length === 0 };
}
