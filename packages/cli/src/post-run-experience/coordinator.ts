// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import type { PostRunExperience, PostRunExperienceInput } from "./types.js";

export function selectPostRunExperience(
  input: Readonly<PostRunExperienceInput>
): PostRunExperience {
  const eligible =
    input.run.completed &&
    input.run.verified &&
    input.run.receiptFinalized &&
    input.run.persistenceFinalized &&
    input.run.exitCode === 0 &&
    input.environment.interactiveTty &&
    !input.environment.ci &&
    input.environment.outputMode === "human";

  if (!eligible) return { kind: "none" };

  if (input.remote.required) {
    return { kind: "required-notice", message: input.remote.required };
  }

  // If the startup update prompt was shown this session, suppress all optional post-run experiences.
  if (input.environment.startupPromptShown === true) {
    return { kind: "none" };
  }

  if (input.telemetry.noticeEligible) {
    return { kind: "telemetry-notice" };
  }

  if (input.localEngagement.runFiveFeedbackEligible) {
    return { kind: "feedback", milestone: 5 };
  }

  if (input.localEngagement.starEligible) {
    return { kind: "star" };
  }

  if (input.localEngagement.badgeEligible) {
    return { kind: "badge" };
  }

  if (input.remote.engagement) {
    return { kind: "remote-experience", message: input.remote.engagement };
  }

  return { kind: "none" };
}
