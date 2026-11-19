import type { MissionQueueEntry } from "./work-queue.js";

export type MissionRecoveryClass = "resume_child" | "resume_verification" | "resume_integration" | "none";

export function classifyMissionRecovery(entry: MissionQueueEntry): MissionRecoveryClass {
  if (entry.phase === "launching") return "resume_child";
  if (entry.phase === "candidate" || entry.phase === "verifying") return "resume_verification";
  if (entry.phase === "integrating") return "resume_integration";
  return "none";
}
