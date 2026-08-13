// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import type { RemoteExperienceV1 } from "../remote-experience.js";

export type PostRunExperience =
  | { kind: "required-notice"; message: RemoteExperienceV1 }
  | { kind: "telemetry-notice" }
  | { kind: "feedback"; milestone: 5 }
  | { kind: "star" }
  | { kind: "badge" }
  | { kind: "remote-experience"; message: RemoteExperienceV1 }
  | { kind: "none" };

export interface PostRunExperienceInput {
  run: {
    completed: boolean;
    verified: boolean;
    receiptFinalized: boolean;
    persistenceFinalized: boolean;
    exitCode: number;
  };
  environment: {
    interactiveTty: boolean;
    ci: boolean;
    outputMode: "human" | "json" | "quiet" | "mcp";
    startupPromptShown?: boolean;
  };
  telemetry: {
    noticeEligible: boolean;
  };
  localEngagement: {
    runFiveFeedbackEligible: boolean;
    starEligible: boolean;
    badgeEligible: boolean;
  };
  remote: {
    required: RemoteExperienceV1 | null;
    engagement: RemoteExperienceV1 | null;
  };
}
