// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

export type VerifierExitReason =
  | "passed"
  | "non_zero_exit"
  | "timed_out"
  | "spawn_error"
  | "invalid_command";

export type VerifierStepType = "lint" | "typecheck" | "test_targeted" | "test_full" | "custom";

export interface VerifierStepSnapshot {
  command: string;
  type: VerifierStepType;
  fastFail: boolean;
  passed: boolean;
  exitCode: number;
  exitReason: VerifierExitReason;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  stdout?: string;
  stderr?: string;
}

export interface VerifierSnapshot {
  passed: boolean;
  summary: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  stepCount: number;
  failedStepCount: number;
  commands: string[];
  steps: VerifierStepSnapshot[];
  combinedOutput?: string;
}

export function cloneVerifierSnapshot(snapshot: VerifierSnapshot): VerifierSnapshot {
  return {
    ...snapshot,
    commands: [...snapshot.commands],
    steps: snapshot.steps.map((step) => ({ ...step }))
  };
}
