import { describe, expect, it } from "vitest";

import {
  executeMissionCommand,
  parseMissionCommandArguments,
  type MissionOperatorPort,
} from "../src/mission-commands.js";

describe("mission operator commands", () => {
  it("parses and renders mission status from the persisted authority", async () => {
    const parsed = parseMissionCommandArguments([
      "status",
      "--mission-id",
      "mission-001",
      "--runs-dir",
      "C:/evidence",
    ]);
    expect(parsed).toEqual({
      command: "mission_status",
      request: {
        selector: { missionId: "mission-001" },
        runsDir: "C:/evidence",
      },
    });

    const port: MissionOperatorPort = {
      async status() {
        return {
          schemaVersion: "martin.mission.operator.v1",
          missionId: "mission-001",
          authority: { kind: "persisted", revision: 7 },
          lifecycle: "active",
          completed: { count: 2, taskIds: ["task-a", "task-b"] },
          active: { count: 1, taskIds: ["task-c"] },
          interrupted: { count: 0, taskIds: [] },
          candidates: { count: 1, candidateIds: ["candidate-1"] },
          rollback: { status: "not_required" },
          budget: { status: "within_limit", spentUsd: 1.25, maxUsd: 5 },
          verification: { status: "pending" },
          updatedAt: "2026-11-03T01:02:03.000Z",
        };
      },
      async inspect() { throw new Error("unused"); },
      async resume() { throw new Error("unused"); },
      async requestControl() { throw new Error("unused"); },
    };

    const result = await executeMissionCommand(parsed, "json", port);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      command: "mission status",
      schemaVersion: "martin.mission.operator.v1",
      missionId: "mission-001",
      authority: { kind: "persisted", revision: 7 },
      lifecycle: "active",
      completed: { count: 2, taskIds: ["task-a", "task-b"] },
      active: { count: 1, taskIds: ["task-c"] },
      interrupted: { count: 0, taskIds: [] },
      candidates: { count: 1, candidateIds: ["candidate-1"] },
      rollback: { status: "not_required" },
      budget: { status: "within_limit", spentUsd: 1.25, maxUsd: 5 },
      verification: { status: "pending" },
      updatedAt: "2026-11-03T01:02:03.000Z",
    });
  });

  it("writes a pause control intent without inventing approval or changing mission authority", async () => {
    const parsed = parseMissionCommandArguments([
      "pause",
      "--latest",
      "--reason",
      "operator maintenance",
      "--host-approval",
      "C:/authority/mission-approval.json",
    ]);
    let received: unknown;
    const port: MissionOperatorPort = {
      async status() { throw new Error("unused"); },
      async inspect() { throw new Error("unused"); },
      async resume() { throw new Error("unused"); },
      async requestControl(action, request) {
        received = { action, request };
        return {
          schemaVersion: "martin.mission.control-intent.v1",
          missionId: "mission-009",
          authority: { kind: "persisted", revision: 3 },
          intent: {
            action: "pause",
            status: "requested",
            reason: request.reason,
          },
        };
      },
    };

    const result = await executeMissionCommand(parsed, "json", port);
    expect(received).toEqual({
      action: "pause",
      request: {
        selector: { latest: true },
        reason: "operator maintenance",
        hostApprovalPath: "C:/authority/mission-approval.json",
      },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      command: "mission pause",
      schemaVersion: "martin.mission.control-intent.v1",
      missionId: "mission-009",
      authority: { kind: "persisted", revision: 3 },
      intent: {
        action: "pause",
        status: "requested",
        reason: "operator maintenance",
      },
    });
    expect(JSON.parse(result.stdout)).not.toHaveProperty("approved");
  });

  it("reports every resume decision surface without accepting budget or scope mutation", async () => {
    expect(() => parseMissionCommandArguments([
      "resume",
      "--latest",
      "--budget-usd",
      "100",
    ])).toThrow(/unsupported/iu);

    const parsed = parseMissionCommandArguments(["resume", "--latest"]);
    const port: MissionOperatorPort = {
      async status() { throw new Error("unused"); },
      async inspect() { throw new Error("unused"); },
      async requestControl() { throw new Error("unused"); },
      async resume() {
        return {
          schemaVersion: "martin.mission.operator.v1",
          missionId: "mission-resume",
          authority: { kind: "persisted", revision: 9 },
          lifecycle: "interrupted",
          completed: { count: 1, taskIds: ["done"] },
          active: { count: 0, taskIds: [] },
          interrupted: { count: 1, taskIds: ["interrupted"] },
          candidates: { count: 2, candidateIds: ["candidate-a", "candidate-b"] },
          rollback: { status: "required" },
          budget: { status: "exhausted" },
          verification: { status: "failed" },
          updatedAt: "2026-11-03T03:00:00.000Z",
        };
      },
    };
    const result = await executeMissionCommand(parsed, "human", port);
    expect(result.stdout).toContain("Lifecycle: interrupted");
    expect(result.stdout).toContain("Completed: 1");
    expect(result.stdout).toContain("Active: 0");
    expect(result.stdout).toContain("Interrupted: 1");
    expect(result.stdout).toContain("Candidates: 2");
    expect(result.stdout).toContain("Rollback: required");
    expect(result.stdout).toContain("Budget: exhausted");
    expect(result.stdout).toContain("Verification: failed");
  });
});
