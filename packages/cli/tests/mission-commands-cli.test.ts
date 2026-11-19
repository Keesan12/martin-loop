import { expect, it } from "vitest";

import { executeCli } from "../src/index.js";
import type { MissionOperatorPort } from "../src/mission-commands.js";

it("routes mission status through the injected persisted-authority port", async () => {
  const mission: MissionOperatorPort = {
    async status() {
      return {
        schemaVersion: "martin.mission.operator.v1",
        missionId: "mission-22",
        authority: { kind: "persisted", revision: 2 },
        lifecycle: "interrupted",
        completed: { count: 1, taskIds: ["done"] },
        active: { count: 0, taskIds: [] },
        interrupted: { count: 1, taskIds: ["stopped"] },
        candidates: { count: 1, candidateIds: ["candidate-3"] },
        rollback: { status: "pending" },
        budget: { status: "stopped" },
        verification: { status: "failed" },
        updatedAt: "2026-11-03T02:00:00.000Z",
      };
    },
    async inspect() { throw new Error("unused"); },
    async resume() { throw new Error("unused"); },
    async requestControl() { throw new Error("unused"); },
  };

  const result = await executeCli(
    ["mission", "status", "--mission-id", "mission-22", "--json"],
    { mission },
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    command: "mission status",
    missionId: "mission-22",
    lifecycle: "interrupted",
    interrupted: { count: 1, taskIds: ["stopped"] },
    rollback: { status: "pending" },
    budget: { status: "stopped" },
    verification: { status: "failed" },
  });
});

it("serves read-only help for every mission command", async () => {
  for (const action of ["status", "inspect", "resume", "pause", "cancel"]) {
    const result = await executeCli(["mission", action, "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Command: martin mission ${action}`);
    expect(result.stdout).toContain("Help only: no command was executed or state changed.");
  }
});

it("renders exact mission usage and labels host-only mutations", async () => {
  const status = await executeCli(["mission", "status", "--help"]);
  expect(status.stdout).toContain("martin mission status (--mission-id <id> | --latest)");
  expect(status.stdout).not.toContain("martin mission status [options]");

  const pause = await executeCli(["mission", "pause", "--help"]);
  expect(pause.stdout).toContain("Availability: embedded host only");
  expect(pause.stdout).toContain("standalone binary has no approval authority");

  const root = await executeCli(["--help"]);
  expect(root.stdout).not.toContain("martin mission pause");
  expect(root.stdout).not.toContain("martin mission cancel");
});
