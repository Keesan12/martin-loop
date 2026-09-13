// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { evaluateReleaseRecovery } from "./lib/release-recovery-state.mjs";
function arg(name) { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1]; }
function git(args, allowMissing = false) {
  try { return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch (error) { if (allowMissing) return null; throw error; }
}
const candidate = arg("--candidate-sha"); const version = arg("--version"); const attestationPath = arg("--attestation"); const publicationEvidencePath = arg("--publication-evidence");
if (!candidate || !/^[a-f0-9]{40}$/iu.test(candidate) || !version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version) || !attestationPath || !publicationEvidencePath) { console.error("Usage: --candidate-sha <sha> --version <semver> --attestation <path> --publication-evidence <path>"); process.exit(2); }
const attestation = JSON.parse(readFileSync(attestationPath, "utf8"));
if (attestation.publisherEquivalentValidation !== "PASS" || attestation.validatedReleaseSha !== candidate) { console.error("pre-tag attestation does not authorize this candidate"); process.exit(1); }
const publication = JSON.parse(readFileSync(publicationEvidencePath, "utf8"));
const publicationAgeMs = Date.now() - Date.parse(publication.checkedAt);
if (publication.schemaVersion !== "martin.release-publication-state.v1" || publication.version !== version || !Number.isFinite(publicationAgeMs) || publicationAgeMs < 0 || publicationAgeMs > 15 * 60 * 1000) { console.error("fresh publication-state evidence for this version is required"); process.exit(1); }
const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
const mcpVersion = JSON.parse(readFileSync("packages/mcp/package.json", "utf8")).version;
const serverVersion = JSON.parse(readFileSync("packages/mcp/server.json", "utf8")).version;
if ([packageVersion, mcpVersion, serverVersion].some((value) => value !== version)) { console.error(`version coordinate mismatch root=${packageVersion} mcp=${mcpVersion} server=${serverVersion} requested=${version}`); process.exit(1); }
const rootTag = `v${version}`; const mcpTag = `mcp-v${version}`;
const rootSha = git(["rev-list", "-n", "1", rootTag], true); const mcpSha = git(["rev-list", "-n", "1", mcpTag], true);
const recovery = evaluateReleaseRecovery({ preTagValidationPassed: true, validatedReleaseSha: candidate, rootTagSha: rootSha, mcpTagSha: mcpSha, rootNpmPublished: publication.rootNpmPublished, mcpNpmPublished: publication.mcpNpmPublished, rootGithubReleaseExists: publication.rootGithubReleaseExists, mcpGithubReleaseExists: publication.mcpGithubReleaseExists, failureKind: arg("--failure-kind") });
console.log(JSON.stringify(recovery));
if (!recovery.allowed) process.exit(1);
if (recovery.tagCreationAllowed) {
  git(["tag", "-a", rootTag, candidate, "-m", `Release ${rootTag}`]);
  git(["tag", "-a", mcpTag, candidate, "-m", `Release ${mcpTag}`]);
  try { git(["push", "--atomic", "origin", `refs/tags/${rootTag}`, `refs/tags/${mcpTag}`]); }
  catch (error) { git(["tag", "-d", rootTag], true); git(["tag", "-d", mcpTag], true); throw error; }
  console.log(`[release-tags] PASS atomic=${rootTag},${mcpTag} candidate=${candidate}`);
  console.log(`DISPATCH_STATE=READY_TO_PUBLISH_VALIDATED_TAG`);
} else {
  console.log(`[release-tags] RETRY existing paired tags candidate=${candidate}`);
  console.log(`DISPATCH_STATE=RETRY_PUBLISH_SAME_VALIDATED_TAG`);
}
