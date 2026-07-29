// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync } from "node:fs";
import { martinFilePath, ensureMartinDir } from "./home-dir.js";

export interface RunStats {
  totalSuccessfulRuns: number;
  lastStarPromptAtRun: number;
  lastFeedbackAtRun: number;
  lastFeatureRequestAtRun: number;
  lastDesignPartnerAskAtRun: number;
  designPartnerConverted: boolean;
  starPromptOptOut: boolean;
  feedbackOptOut: boolean;
  telemetryOptIn: boolean | null;
  martinVersion: string;
}

const STATS_FILE = martinFilePath("run-stats.json");

function defaults(): RunStats {
  return {
    totalSuccessfulRuns: 0,
    lastStarPromptAtRun: 0,
    lastFeedbackAtRun: 0,
    lastFeatureRequestAtRun: 0,
    lastDesignPartnerAskAtRun: 0,
    designPartnerConverted: false,
    starPromptOptOut: false,
    feedbackOptOut: false,
    telemetryOptIn: null,
    martinVersion: ""
  };
}

export function readRunStats(): RunStats {
  ensureMartinDir();
  try {
    return { ...defaults(), ...JSON.parse(readFileSync(STATS_FILE, "utf-8")) };
  } catch {
    return defaults();
  }
}

export function writeRunStats(stats: RunStats): void {
  ensureMartinDir();
  writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), "utf-8");
}

export function recordSuccessfulRun(version: string): RunStats {
  const stats = readRunStats();
  stats.totalSuccessfulRuns += 1;
  stats.martinVersion = version;
  writeRunStats(stats);
  return stats;
}
