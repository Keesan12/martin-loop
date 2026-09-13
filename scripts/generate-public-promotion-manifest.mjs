// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SURFACE_SCHEMA, hashSurface, listSurfaceEntries, sha256, surfaceSpecHash, validateReviewedDivergences } from "./lib/public-release-surface.mjs";
function arg(name, fallback) { const index = process.argv.indexOf(name); return index === -1 ? fallback : process.argv[index + 1]; }
const cwd = process.cwd();
const privateRef = arg("--private-ref");
const publicBaseSha = arg("--public-base");
const privateMergeSha = arg("--private-merge", privateRef);
const healthEvidencePath = arg("--internal-health-evidence");
const output = resolve(cwd, arg("--output", ".martin/promotion-manifest.json"));
if (!privateRef || !publicBaseSha || !healthEvidencePath) { console.error("Usage: node scripts/generate-public-promotion-manifest.mjs --private-ref <sha> --public-base <sha> --internal-health-evidence <json> [--private-merge <sha>] [--divergences <json>] [--output <path>]"); process.exit(2); }
function commit(value, label) {
  const resolved = execFileSync("git", ["rev-parse", `${value}^{commit}`], { cwd, encoding: "utf8" }).trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(resolved)) throw new Error(`${label} did not resolve to a full commit SHA`);
  return resolved;
}
function repositorySlug(remote) {
  const match = /github\.com(?::|\/)([^/]+\/[^/]+?)(?:\.git)?$/iu.exec(remote.trim().replaceAll("\\", "/"));
  if (!match) throw new Error("origin must be a canonical GitHub repository URL");
  return match[1];
}
const privateMainShaValidated = commit(privateRef, "private-ref");
const resolvedPrivateMergeSha = commit(privateMergeSha, "private-merge");
const resolvedPublicBaseSha = commit(publicBaseSha, "public-base");
const origin = execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd, encoding: "utf8" });
const sourceRepositoryFingerprint = sha256(repositorySlug(origin));
if (sourceRepositoryFingerprint !== "04aac733f3b08513fddcc72a9013b9f59cf7919f9a0a3893d0b3d953929826ec") throw new Error("promotion manifest must be generated from the validated internal release authority");
const healthEvidenceBytes = readFileSync(resolve(cwd, healthEvidencePath));
const healthEvidence = JSON.parse(healthEvidenceBytes.toString("utf8"));
if (healthEvidence.schemaVersion !== "martin.internal-health.v1" || healthEvidence.status !== "PASS" || healthEvidence.validatedReleaseSha?.toLowerCase() !== privateMainShaValidated || !Array.isArray(healthEvidence.commands) || healthEvidence.commands.length === 0 || healthEvidence.commands.some((command) => command?.exitCode !== 0)) throw new Error("versioned internal health evidence must PASS every command for the exact private release SHA");
const entries = listSurfaceEntries(cwd, privateMainShaValidated);
const divergencesPath = arg("--divergences");
const reviewedDivergences = divergencesPath ? JSON.parse(readFileSync(resolve(cwd, divergencesPath), "utf8")) : [];
validateReviewedDivergences(entries, reviewedDivergences);
const manifest = { schemaVersion: SURFACE_SCHEMA, sourceAuthority: "validated-internal-release-source", sourceRepositoryFingerprint, privateMergeSha: resolvedPrivateMergeSha, privateMainShaValidated, publicBaseSha: resolvedPublicBaseSha, promotedBy: process.env.GITHUB_ACTOR || process.env.USERNAME || "unknown", validatedAt: new Date().toISOString(), internalHealthPassed: true, internalHealthEvidenceSha256: sha256(healthEvidenceBytes), surfaceSpecHash: surfaceSpecHash(), surfaceHash: hashSurface(entries), surfaceEntries: entries, reviewedDivergences };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[promotion-manifest] wrote ${output} with ${entries.length} canonical entries`);
