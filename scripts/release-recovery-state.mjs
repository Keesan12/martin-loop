// SPDX-License-Identifier: Apache-2.0
import { assertPublisherCoordinates, evaluateReleaseRecovery } from "./lib/release-recovery-state.mjs";
function arg(name) { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1]; }
const publisherMode = process.argv.includes("--publisher-coordinates");
let result;
if (publisherMode) result = assertPublisherCoordinates({ validatedReleaseSha: arg("--validated-sha"), tagSha: arg("--tag-sha"), pairedTagSha: arg("--paired-tag-sha"), recoveryState: arg("--recovery-state") });
else result = evaluateReleaseRecovery({
  preTagValidationPassed: arg("--pretag") === "pass",
  validatedReleaseSha: arg("--validated-sha"),
  rootTagSha: arg("--root-tag-sha"),
  mcpTagSha: arg("--mcp-tag-sha"),
  rootPublished: arg("--root-published") === "true",
  mcpPublished: arg("--mcp-published") === "true",
  failureKind: arg("--failure-kind"),
});
console.log(JSON.stringify(result));
if (!publisherMode && !result.allowed) process.exitCode = 1;
