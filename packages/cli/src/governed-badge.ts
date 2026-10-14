// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

export const MARTINLOOP_BADGE_MARKDOWN =
  "[![MartinLoop Governed](https://img.shields.io/badge/MartinLoop-Governed-blue)](https://martinloop.com)";

// Shields endpoint fields matching the badge rendered by MARTINLOOP_BADGE_MARKDOWN.
export const MARTINLOOP_BADGE_SHIELDS = {
  schemaVersion: 1,
  label: "MartinLoop",
  message: "Governed",
  color: "blue",
} as const;

export const MARTINLOOP_BADGE_CTA = [
  "",
  "Your repo is now governed by MartinLoop.",
  "Add the badge to your README:",
  "",
  MARTINLOOP_BADGE_MARKDOWN,
] as const;
