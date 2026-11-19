import { describe, expect, it } from "vitest";

import {
  executeMemoryCommand,
  parseMemoryCommandArguments,
  type MemoryOperatorPort,
} from "../src/memory-commands.js";
import { renderCliError } from "../src/ux.js";

describe("memory operator commands", () => {
  it("lists candidates without collapsing their persisted states", async () => {
    const parsed = parseMemoryCommandArguments(["candidates", "--runs-dir", "C:/evidence"]);
    expect(parsed).toEqual({
      command: "memory_candidates",
      request: { runsDir: "C:/evidence" },
    });

    const port: MemoryOperatorPort = {
      async inspect() { throw new Error("unused"); },
      async verify() { throw new Error("unused"); },
      async candidates() {
        return {
          schemaVersion: "martin.memory.operator.v1",
          authority: { kind: "persisted", revision: 11 },
          candidates: [
            { memoryId: "m-candidate", state: "candidate" },
            { memoryId: "m-active", state: "active" },
            { memoryId: "m-revoked", state: "revoked" },
            { memoryId: "m-expired", state: "expired" },
            { memoryId: "m-corrupt", state: "corrupt" },
            { memoryId: "m-unreadable", state: "unreadable" },
          ],
        };
      },
      async revoke() { throw new Error("unused"); },
    };

    const result = await executeMemoryCommand(parsed, "json", port);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      command: "memory candidates",
      schemaVersion: "martin.memory.operator.v1",
      authority: { kind: "persisted", revision: 11 },
      candidates: [
        { memoryId: "m-candidate", state: "candidate" },
        { memoryId: "m-active", state: "active" },
        { memoryId: "m-revoked", state: "revoked" },
        { memoryId: "m-expired", state: "expired" },
        { memoryId: "m-corrupt", state: "corrupt" },
        { memoryId: "m-unreadable", state: "unreadable" },
      ],
    });
  });

  it("rejects revoke without current signed host approval using the auth exit contract", () => {
    let failure: unknown;
    try {
      parseMemoryCommandArguments([
        "revoke",
        "--memory-id",
        "memory-001",
        "--reason",
        "superseded",
      ]);
    } catch (error) {
      failure = error;
    }
    expect(renderCliError("json", failure)).toMatchObject({ exitCode: 4 });
    expect(JSON.parse(renderCliError("json", failure).stdout)).toMatchObject({
      ok: false,
      category: "auth",
      message: expect.stringMatching(/current signed host approval/iu),
    });
  });

  it("passes the signed host approval input through to the revoke authority", async () => {
    const parsed = parseMemoryCommandArguments([
      "revoke",
      "--memory-id",
      "memory-001",
      "--reason",
      "superseded",
      "--host-approval",
      "C:/authority/approval.json",
    ]);
    let received: unknown;
    const port: MemoryOperatorPort = {
      async inspect() { throw new Error("unused"); },
      async verify() { throw new Error("unused"); },
      async candidates() { throw new Error("unused"); },
      async revoke(request) {
        received = request;
        return {
          schemaVersion: "martin.memory.operator.v1",
          authority: { kind: "persisted", revision: 12 },
          memoryId: "memory-001",
          state: "revoked",
          outcome: "revoked",
          approval: { status: "verified", approvalId: "approval-77" },
        };
      },
    };

    const result = await executeMemoryCommand(parsed, "json", port);
    expect(received).toEqual({
      selector: { memoryId: "memory-001" },
      reason: "superseded",
      hostApprovalPath: "C:/authority/approval.json",
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "memory revoke",
      memoryId: "memory-001",
      state: "revoked",
      outcome: "revoked",
      approval: { status: "verified", approvalId: "approval-77" },
    });
  });
});
