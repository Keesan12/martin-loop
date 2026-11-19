import { expect, it } from "vitest";

import { executeCli } from "../src/index.js";

it("returns the stable auth error when memory revoke omits signed host approval", async () => {
  const result = await executeCli([
    "memory",
    "revoke",
    "--memory-id",
    "memory-22",
    "--reason",
    "superseded",
    "--json",
  ]);
  expect(result.exitCode).toBe(4);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    category: "auth",
    message: expect.stringMatching(/current signed host approval/iu),
  });
});

it("preserves corrupt and unreadable memory verification exit codes", async () => {
  const base = {
    schemaVersion: "martin.memory.operator.v1",
    authority: { kind: "persisted" as const, revision: 5 },
    memoryId: "memory-22",
  };
  const corrupt = await executeCli(
    ["memory", "verify", "--memory-id", "memory-22", "--json"],
    {
      memory: {
        async inspect() { throw new Error("unused"); },
        async candidates() { throw new Error("unused"); },
        async revoke() { throw new Error("unused"); },
        async verify() {
          return { ...base, state: "corrupt" as const, verification: { status: "corrupt" as const } };
        },
      },
    },
  );
  expect(corrupt.exitCode).toBe(7);
  expect(JSON.parse(corrupt.stdout)).toMatchObject({ state: "corrupt", verification: { status: "corrupt" } });

  const unreadable = await executeCli(
    ["memory", "verify", "--memory-id", "memory-22", "--json"],
    {
      memory: {
        async inspect() { throw new Error("unused"); },
        async candidates() { throw new Error("unused"); },
        async revoke() { throw new Error("unused"); },
        async verify() {
          return { ...base, state: "unreadable" as const, verification: { status: "unreadable" as const } };
        },
      },
    },
  );
  expect(unreadable.exitCode).toBe(6);
  expect(JSON.parse(unreadable.stdout)).toMatchObject({ state: "unreadable", verification: { status: "unreadable" } });
});

it("serves read-only help for every memory command", async () => {
  for (const action of ["inspect", "verify", "candidates", "revoke"]) {
    const result = await executeCli(["memory", action, "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Command: martin memory ${action}`);
    expect(result.stdout).toContain("Help only: no command was executed or state changed.");
  }
});

it("renders exact memory usage and labels revoke as host-only", async () => {
  const candidates = await executeCli(["memory", "candidates", "--help"]);
  expect(candidates.stdout).toContain("martin memory candidates [--state <state>]");
  expect(candidates.stdout).not.toContain("martin memory candidates [options]");

  const revoke = await executeCli(["memory", "revoke", "--help"]);
  expect(revoke.stdout).toContain("Availability: embedded host only");
  expect(revoke.stdout).toContain("standalone binary has no approval authority");

  const root = await executeCli(["--help"]);
  expect(root.stdout).not.toContain("martin memory revoke");
});
