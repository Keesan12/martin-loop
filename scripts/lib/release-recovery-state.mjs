// SPDX-License-Identifier: Apache-2.0
export const RELEASE_STATES = Object.freeze({
  RETRY: "RETRY_PUBLISH_SAME_VALIDATED_TAG",
  REPAIR: "REPAIR_SOURCE_BEFORE_FIRST_PUBLISH",
  ABORTED: "ABORTED_PRE_PUBLISH_TAG_CUT",
  READY: "READY_TO_PUBLISH_VALIDATED_TAG",
  COMPLETE: "PUBLISH_COMPLETE",
});

function shaOrNull(value, name) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/iu.test(value)) throw new Error(`${name} must be a full Git SHA or null`);
  return value.toLowerCase();
}

export function evaluateReleaseRecovery(input) {
  const validated = shaOrNull(input.validatedReleaseSha, "validatedReleaseSha");
  const root = shaOrNull(input.rootTagSha, "rootTagSha");
  const mcp = shaOrNull(input.mcpTagSha, "mcpTagSha");
  const detailedPublication = [input.rootNpmPublished, input.mcpNpmPublished, input.rootGithubReleaseExists, input.mcpGithubReleaseExists];
  const publicationFlags = detailedPublication.some((value) => value !== undefined)
    ? detailedPublication.map(Boolean)
    : [Boolean(input.rootPublished), Boolean(input.mcpPublished)];
  const published = publicationFlags.some(Boolean);
  const publicationComplete = publicationFlags.every(Boolean);
  const publicationPartial = published && !publicationComplete;
  if (!input.preTagValidationPassed) {
    return { state: RELEASE_STATES.REPAIR, allowed: false, dispatchAllowed: false, tagCreationAllowed: false, releaseSha: null, reason: "publisher-equivalent pre-tag validation did not pass" };
  }
  if (!validated) return { state: RELEASE_STATES.REPAIR, allowed: false, dispatchAllowed: false, tagCreationAllowed: false, releaseSha: null, reason: "validated release SHA is missing" };
  if ((root && !mcp) || (!root && mcp) || (root && mcp && root !== mcp)) {
    return { state: RELEASE_STATES.REPAIR, allowed: false, dispatchAllowed: false, tagCreationAllowed: false, releaseSha: validated, reason: "root and MCP tag coordinates are partial or disagree" };
  }
  if (root && root !== validated) {
    if (!published) return { state: RELEASE_STATES.ABORTED, allowed: false, dispatchAllowed: false, tagCreationAllowed: false, releaseSha: validated, reason: "pre-publish paired tags point to stale source and the tag cut is aborted" };
    return { state: RELEASE_STATES.REPAIR, allowed: false, dispatchAllowed: false, tagCreationAllowed: false, releaseSha: validated, reason: "published tags do not point to the validated release SHA" };
  }
  if (!root) {
    if (published) return { state: RELEASE_STATES.REPAIR, allowed: false, dispatchAllowed: false, tagCreationAllowed: false, releaseSha: validated, reason: "publication exists without paired validated tags" };
    return { state: RELEASE_STATES.REPAIR, allowed: true, dispatchAllowed: false, tagCreationAllowed: true, releaseSha: validated, reason: "validated source is ready for first atomic paired tag cut" };
  }
  if (publicationPartial) return { state: RELEASE_STATES.REPAIR, allowed: false, dispatchAllowed: false, tagCreationAllowed: false, releaseSha: validated, reason: "partial publication requires explicit release-owner recovery" };
  if (publicationComplete) {
    return { state: RELEASE_STATES.COMPLETE, allowed: false, dispatchAllowed: false, tagCreationAllowed: false, releaseSha: validated, reason: "both release coordinates are already published" };
  }
  if (input.tagsCreatedNow) return { state: RELEASE_STATES.READY, allowed: true, dispatchAllowed: true, tagCreationAllowed: false, releaseSha: validated, reason: "atomic paired tags were created from the validated release SHA" };
  const infrastructureFailure = input.failureKind === "infrastructure";
  return { state: RELEASE_STATES.RETRY, allowed: infrastructureFailure, dispatchAllowed: infrastructureFailure, tagCreationAllowed: false, releaseSha: validated, reason: infrastructureFailure ? "same validated paired tags may retry after infrastructure failure" : "same-tag retry requires an infrastructure failure classification" };
}

export function assertPublisherCoordinates({ validatedReleaseSha, tagSha, pairedTagSha, recoveryState }) {
  const validated = shaOrNull(validatedReleaseSha, "validatedReleaseSha");
  const tag = shaOrNull(tagSha, "tagSha");
  const paired = shaOrNull(pairedTagSha, "pairedTagSha");
  if (!validated || tag !== validated || paired !== validated) throw new Error("publisher coordinates must satisfy HEAD == TAG_SHA == PAIRED_TAG_SHA == VALIDATED_RELEASE_SHA");
  if (![RELEASE_STATES.READY, RELEASE_STATES.RETRY].includes(recoveryState)) throw new Error(`publisher dispatch is forbidden for recovery state ${recoveryState}`);
  return { validatedReleaseSha: validated, recoveryState };
}
