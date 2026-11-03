// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { posix } from "node:path";

export const SURFACE_SCHEMA = "martin.public-promotion.v3";
export const PRIVATE_PROMOTION_PROOF_SCHEMA = "martin.private-promotion-boundary.v1";
export const PRIVATE_PROMOTION_NOTES_SCHEMA = "martin.promotion-proof-notes.v1";
export const PRIVATE_PROMOTION_NOTES_REF = "refs/notes/martin-promotion-boundaries";
const REVIEWED_DIVERGENCES_DOMAIN = "martin.public-promotion.reviewed-divergences.v1\0";
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
    return { mode: match[1], type: match[2], object: match[3], path: match[4] };
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
    return { path: entry.path, mode: entry.mode, sha256: sha256(batch.subarray(contentStart, contentEnd)) };
  });
}
export function hashSurface(entries) { return sha256(JSON.stringify([...entries].sort((a, b) => comparePath(a.path, b.path)))); }

function isCanonicalReleasePath(path) {
  return typeof path === "string"
    && path.length > 0
    && !path.includes("\\")
    && !path.includes("\0")
    && !path.startsWith("/")
    && !/^[A-Za-z]:/u.test(path)
    && posix.normalize(path) === path
    && path.split("/").every((segment) => segment !== "." && segment !== "..");
}

function requireExactFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${label} has unsupported fields`);
  }
}

export function validatePublicSurfaceEntries(entries) {
  if (!Array.isArray(entries)) throw new Error("publicSurfaceEntries must be an array");
  let previousPath;
  for (const entry of entries) {
    requireExactFields(entry, ["path", "mode", "sha256"], "public surface entry");
    if (!isCanonicalReleasePath(entry.path)) throw new Error("public surface entry path must be canonical");
    if (!isReleaseSurfacePath(entry.path)) throw new Error("public surface entry path is outside the release surface");
    if (typeof entry.mode !== "string" || !/^100(?:644|755)$/u.test(entry.mode)) throw new Error(`public surface entry mode is invalid for ${entry.path}`);
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new Error(`public surface entry digest is invalid for ${entry.path}`);
    if (previousPath !== undefined && entry.path === previousPath) throw new Error(`duplicate public surface entry: ${entry.path}`);
    if (previousPath !== undefined && comparePath(previousPath, entry.path) > 0) throw new Error("publicSurfaceEntries must be sorted by path");
    previousPath = entry.path;
  }
  return entries;
}

function canonicalReviewedDivergences(divergences) {
  return divergences
    .map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      privateSha256: entry.privateSha256,
      privateMode: entry.privateMode ?? null,
      publicSha256: entry.publicSha256,
      publicMode: entry.publicMode ?? null,
      reason: entry.reason,
      reviewedBy: entry.reviewedBy,
    }))
    .sort((a, b) => comparePath(a.path, b.path));
}

export function reviewedDivergencesHash(divergences) {
  return sha256(`${REVIEWED_DIVERGENCES_DOMAIN}${JSON.stringify(canonicalReviewedDivergences(divergences))}`);
}

export function createPublicPromotionBoundary(entries, divergences) {
  validateReviewedDivergences(entries, divergences);
  const publicSurfaceEntries = expectedPublicEntries(entries, divergences);
  validatePublicSurfaceEntries(publicSurfaceEntries);
  const reviewed = canonicalReviewedDivergences(divergences);
  const publicManifestFields = {
    publicSurfaceHash: hashSurface(publicSurfaceEntries),
    publicSurfaceEntries,
    reviewedDivergencesCount: reviewed.length,
    reviewedDivergencesHash: sha256(`${REVIEWED_DIVERGENCES_DOMAIN}${JSON.stringify(reviewed)}`),
  };
  return {
    publicManifestFields,
    privateProof: {
      schemaVersion: PRIVATE_PROMOTION_PROOF_SCHEMA,
      ...publicManifestFields,
      reviewedDivergences: [...divergences].sort((a, b) => comparePath(a.path, b.path)),
    },
  };
}

export function validatePrivatePromotionProof(proof, publicFields, privateEntries) {
  requireExactFields(proof, [
    "schemaVersion",
    "publicSurfaceHash",
    "publicSurfaceEntries",
    "reviewedDivergencesCount",
    "reviewedDivergencesHash",
    "reviewedDivergences",
  ], "private promotion proof");
  if (proof.schemaVersion !== PRIVATE_PROMOTION_PROOF_SCHEMA) throw new Error("unsupported private promotion proof schema");
  if (!Array.isArray(privateEntries)) throw new Error("private promotion proof validation requires private surface entries");
  validatePublicSurfaceEntries(proof.publicSurfaceEntries);
  if (!Array.isArray(proof.reviewedDivergences)) throw new Error("private promotion proof reviewedDivergences must be an array");
  for (let index = 1; index < proof.reviewedDivergences.length; index += 1) {
    if (comparePath(proof.reviewedDivergences[index - 1].path, proof.reviewedDivergences[index].path) >= 0) {
      throw new Error("private promotion proof reviewedDivergences must be uniquely sorted by path");
    }
  }
  const rebuilt = createPublicPromotionBoundary(privateEntries, proof.reviewedDivergences);
  const expected = rebuilt.publicManifestFields;
  for (const field of ["publicSurfaceHash", "reviewedDivergencesCount", "reviewedDivergencesHash"]) {
    if (proof[field] !== expected[field] || publicFields[field] !== expected[field]) throw new Error(`private promotion proof ${field} does not match the public manifest`);
  }
  if (JSON.stringify(proof.publicSurfaceEntries) !== JSON.stringify(expected.publicSurfaceEntries)
      || JSON.stringify(publicFields.publicSurfaceEntries) !== JSON.stringify(expected.publicSurfaceEntries)) {
    throw new Error("private promotion proof publicSurfaceEntries do not match the public manifest");
  }
  return proof.reviewedDivergences;
}

export function validatePrivatePromotionRecord(record) {
  requireExactFields(record, ["packageVersion", "sourceRepositoryFingerprint", "privateMainShaValidated", "publicBaseSha", "boundary"], "private promotion record");
  if (typeof record.packageVersion !== "string" || record.packageVersion.length === 0) throw new Error("private promotion record packageVersion is required");
  for (const field of ["sourceRepositoryFingerprint", "privateMainShaValidated", "publicBaseSha"]) {
    const length = field === "sourceRepositoryFingerprint" ? 64 : 40;
    if (typeof record[field] !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`, "u").test(record[field])) throw new Error(`private promotion record ${field} is invalid`);
  }
  return record;
}

function privatePromotionRecordKey(record) {
  return [record.packageVersion, record.sourceRepositoryFingerprint, record.privateMainShaValidated, record.publicBaseSha].join("\0");
}

export function validatePrivatePromotionNote(note, privateMainShaValidated) {
  requireExactFields(note, ["schemaVersion", "records"], "private promotion note");
  if (note.schemaVersion !== PRIVATE_PROMOTION_NOTES_SCHEMA) throw new Error("unsupported private promotion note schema");
  if (!Array.isArray(note.records) || note.records.length === 0) throw new Error("private promotion note records must be a non-empty array");
  let previousKey;
  for (const record of note.records) {
    validatePrivatePromotionRecord(record);
    if (privateMainShaValidated !== undefined && record.privateMainShaValidated !== privateMainShaValidated) {
      throw new Error("private promotion note contains a record for a different commit");
    }
    const key = privatePromotionRecordKey(record);
    if (previousKey !== undefined && comparePath(previousKey, key) >= 0) {
      throw new Error("private promotion note records must be uniquely sorted");
    }
    previousKey = key;
  }
  return note;
}

function validateRemoteName(remote) {
  if (typeof remote !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(remote)) throw new Error("private promotion proof remote name is invalid");
}

function githubRepositorySlug(remoteUrl) {
  const normalized = remoteUrl.trim().replaceAll("\\", "/");
  const scpLike = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/iu.exec(normalized);
  if (scpLike) return scpLike[1];
  let parsed;
  try { parsed = new URL(normalized); } catch { throw new Error("private promotion proof remote must identify a GitHub repository"); }
  if (parsed.hostname.toLowerCase() !== "github.com") throw new Error("private promotion proof remote must identify a GitHub repository");
  const slug = parsed.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/iu, "");
  if (!/^[^/]+\/[^/]+$/u.test(slug)) throw new Error("private promotion proof remote must identify a GitHub repository");
  return slug;
}

export function validatePrivatePromotionRemote(cwd, remote, sourceRepositoryFingerprint) {
  validateRemoteName(remote);
  if (typeof sourceRepositoryFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(sourceRepositoryFingerprint)) {
    throw new Error("private promotion source repository fingerprint is invalid");
  }
  let sourceUrls;
  let targetUrls;
  try {
    sourceUrls = git(cwd, ["config", "--get-all", "remote.origin.url"]).trim().split(/\r?\n/u).filter(Boolean);
    const fetchUrls = git(cwd, ["config", "--get-all", `remote.${remote}.url`]).trim().split(/\r?\n/u).filter(Boolean);
    let pushUrls;
    try { pushUrls = git(cwd, ["config", "--get-all", `remote.${remote}.pushurl`]).trim().split(/\r?\n/u).filter(Boolean); }
    catch { pushUrls = fetchUrls; }
    targetUrls = [...fetchUrls, ...pushUrls];
  } catch {
    throw new Error("private promotion proof remote is not configured");
  }
  const sourceSlugs = sourceUrls.map(githubRepositorySlug);
  const targetSlugs = targetUrls.map(githubRepositorySlug);
  const sourceSlug = sourceSlugs[0];
  if (!sourceSlug
      || sha256(sourceSlug) !== sourceRepositoryFingerprint
      || sourceSlugs.some((slug) => slug.toLowerCase() !== sourceSlug.toLowerCase())
      || targetSlugs.length === 0
      || targetSlugs.some((slug) => slug.toLowerCase() !== sourceSlug.toLowerCase())) {
    throw new Error("private promotion proof remote must match the validated private release authority");
  }
  return { sourceSlug, targetSlugs };
}

export function syncPrivatePromotionNotes(cwd, remote, sourceRepositoryFingerprint) {
  validatePrivatePromotionRemote(cwd, remote, sourceRepositoryFingerprint);
  const output = git(cwd, ["ls-remote", "--refs", remote, PRIVATE_PROMOTION_NOTES_REF]).trim();
  if (!output) {
    try { git(cwd, ["update-ref", "-d", PRIVATE_PROMOTION_NOTES_REF]); } catch {}
    return null;
  }
  const lines = output.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) throw new Error("private promotion proof ref resolved ambiguously");
  const [remoteSha, remoteRef] = lines[0].split(/\s+/u);
  if (!/^[a-f0-9]{40}$/u.test(remoteSha) || remoteRef !== PRIVATE_PROMOTION_NOTES_REF) throw new Error("private promotion proof ref is malformed");
  git(cwd, ["fetch", "--no-tags", remote, `+${PRIVATE_PROMOTION_NOTES_REF}:${PRIVATE_PROMOTION_NOTES_REF}`]);
  const localSha = git(cwd, ["rev-parse", PRIVATE_PROMOTION_NOTES_REF]).trim();
  if (localSha !== remoteSha) throw new Error("private promotion proof ref fetch did not match the remote");
  return localSha;
}

export function readPrivatePromotionNote(cwd, privateMainShaValidated) {
  if (typeof privateMainShaValidated !== "string" || !/^[a-f0-9]{40}$/u.test(privateMainShaValidated)) throw new Error("private promotion note target is invalid");
  let raw;
  try { raw = git(cwd, ["notes", `--ref=${PRIVATE_PROMOTION_NOTES_REF}`, "show", privateMainShaValidated]); }
  catch { throw new Error("required private promotion proof note is missing"); }
  let record;
  try { record = JSON.parse(raw); } catch { throw new Error("private promotion proof note is invalid JSON"); }
  return validatePrivatePromotionNote(record, privateMainShaValidated);
}

export function persistPrivatePromotionNote(cwd, remote, record, sourceRepositoryFingerprint = record?.sourceRepositoryFingerprint) {
  validatePrivatePromotionRemote(cwd, remote, sourceRepositoryFingerprint);
  validatePrivatePromotionRecord(record);
  syncPrivatePromotionNotes(cwd, remote, sourceRepositoryFingerprint);
  let note;
  try {
    note = readPrivatePromotionNote(cwd, record.privateMainShaValidated);
  } catch (error) {
    if (!String(error?.message ?? error).includes("is missing")) throw error;
    note = { schemaVersion: PRIVATE_PROMOTION_NOTES_SCHEMA, records: [] };
  }
  const recordKey = privatePromotionRecordKey(record);
  const records = [...note.records.filter((item) => privatePromotionRecordKey(item) !== recordKey), record]
    .sort((a, b) => comparePath(privatePromotionRecordKey(a), privatePromotionRecordKey(b)));
  note = { schemaVersion: PRIVATE_PROMOTION_NOTES_SCHEMA, records };
  validatePrivatePromotionNote(note, record.privateMainShaValidated);
  execFileSync("git", ["notes", `--ref=${PRIVATE_PROMOTION_NOTES_REF}`, "add", "-f", "-F", "-", record.privateMainShaValidated], {
    cwd,
    input: `${JSON.stringify(note, null, 2)}\n`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  git(cwd, ["push", remote, `${PRIVATE_PROMOTION_NOTES_REF}:${PRIVATE_PROMOTION_NOTES_REF}`]);
  const localSha = git(cwd, ["rev-parse", PRIVATE_PROMOTION_NOTES_REF]).trim();
  const remoteOutput = git(cwd, ["ls-remote", "--refs", remote, PRIVATE_PROMOTION_NOTES_REF]).trim();
  if (!remoteOutput.startsWith(`${localSha}\t`)) throw new Error("private promotion proof note was not durably persisted");
  const readBack = readPrivatePromotionNote(cwd, record.privateMainShaValidated);
  if (JSON.stringify(readBack) !== JSON.stringify(note)) throw new Error("private promotion proof note read-back mismatch");
  return record;
}

export function requirePrivatePromotionProof(note, manifest) {
  validatePrivatePromotionNote(note, manifest.privateMainShaValidated);
  const record = note.records.find((item) => item.packageVersion === manifest.packageVersion
    && item.sourceRepositoryFingerprint === manifest.sourceRepositoryFingerprint
    && item.privateMainShaValidated === manifest.privateMainShaValidated
    && item.publicBaseSha === manifest.publicBaseSha);
  if (!record) throw new Error("required private promotion proof is missing for the public manifest");
  return record;
}

export function validateReviewedDivergences(entries, divergences) {
  const privateEntries = new Map(entries.map((entry) => [entry.path, entry]));
  const seen = new Set();
  for (const item of divergences) {
    if (!item || !isCanonicalReleasePath(item.path)) throw new Error("reviewed divergence path must be canonical");
    if (!isReleaseSurfacePath(item.path)) throw new Error("reviewed divergence path must belong to the canonical release surface");
    if (seen.has(item.path)) throw new Error(`duplicate reviewed divergence: ${item.path}`);
    seen.add(item.path);
    if (!["content", "public-only", "private-only"].includes(item.kind)) throw new Error(`unsupported divergence kind for ${item.path}`);
    const fields = item.kind === "private-only"
      ? ["path", "kind", "privateSha256", "privateMode", "publicSha256", "reason", "reviewedBy"]
      : ["path", "kind", "privateSha256", "privateMode", "publicSha256", "publicMode", "reason", "reviewedBy"];
    requireExactFields(item, fields, `reviewed divergence ${item.path}`);
    if (typeof item.reason !== "string" || item.reason.trim().length < 8) throw new Error(`reviewed divergence ${item.path} requires a substantive reason`);
    if (typeof item.reviewedBy !== "string" || item.reviewedBy.trim().length === 0) throw new Error(`reviewed divergence ${item.path} requires reviewedBy`);
    const privateEntry = privateEntries.get(item.path);
    const privateHash = privateEntry?.sha256;
    if (item.kind === "public-only" && privateEntry) throw new Error(`${item.path} is not public-only`);
    if ((item.kind === "content" || item.kind === "private-only") && !privateEntry) throw new Error(`${item.path} is absent from the private surface`);
    if (item.privateSha256 !== (privateHash ?? null)) throw new Error(`private hash mismatch for reviewed divergence ${item.path}`);
    if (item.privateMode !== (privateEntry?.mode ?? null)) throw new Error(`private mode mismatch for reviewed divergence ${item.path}`);
    const expectsPublic = item.kind !== "private-only";
    if (expectsPublic !== (typeof item.publicSha256 === "string" && /^[a-f0-9]{64}$/u.test(item.publicSha256))) throw new Error(`invalid public hash for reviewed divergence ${item.path}`);
    if (item.kind !== "private-only" && (typeof item.publicMode !== "string" || !/^\d{6}$/u.test(item.publicMode))) throw new Error(`invalid public mode for reviewed divergence ${item.path}`);
  }
}

export function expectedPublicEntries(entries, divergences = []) {
  validateReviewedDivergences(entries, divergences);
  const expected = new Map(entries.map((entry) => [entry.path, { ...entry }]));
  for (const item of divergences) {
    if (item.kind === "private-only") {
      expected.delete(item.path);
      continue;
    }
    const previous = expected.get(item.path);
    expected.set(item.path, {
      path: item.path,
      mode: item.publicMode ?? previous?.mode ?? "100644",
      sha256: item.publicSha256
    });
  }
  return [...expected.values()].sort((a, b) => comparePath(a.path, b.path));
}
export function compareSurface(expected, actual) {
  const expectedMap = new Map(expected.map((entry) => [entry.path, entry]));
  const actualMap = new Map(actual.map((entry) => [entry.path, entry]));
  const missing = [...expectedMap.keys()].filter((path) => !actualMap.has(path));
  const extra = [...actualMap.keys()].filter((path) => !expectedMap.has(path));
  const changed = [...expectedMap.keys()].filter((path) => {
    if (!actualMap.has(path)) return false;
    const expectedEntry = expectedMap.get(path);
    const actualEntry = actualMap.get(path);
    return expectedEntry.sha256 !== actualEntry.sha256 || expectedEntry.mode !== actualEntry.mode;
  });
  return { missing, extra, changed, matches: missing.length === 0 && extra.length === 0 && changed.length === 0 };
}
