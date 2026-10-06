import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { withProductionFixtureLockForTest } from "./helpers/swarm-hosted-fixture-builder.js";

describe("production swarm hosted fixture lock", () => {
  it("keeps an aged fixture lock when its owner process is still active", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-hosted-active-lock-"));
    const lockPath = join(root, "fixture.lock");
    const owner = { pid: process.pid, createdAt: Date.now() - 10_000, nonce: "active-owner" };
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
    try {
      await expect(withProductionFixtureLockForTest(
        async () => undefined,
        { lockPath, waitTimeoutMs: 50, staleAfterMs: 1, pollIntervalMs: 5 },
      )).rejects.toThrow(/Timed out waiting for the production fixture builder lock/u);
      expect(JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"))).toEqual(owner);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers an aged fixture lock only after its owner process has exited", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-hosted-stale-lock-"));
    const lockPath = join(root, "fixture.lock");
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
    const deadPid = child.pid;
    if (!deadPid) throw new Error("The stale-lock test child did not receive a PID.");
    await once(child, "exit");
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({
      pid: deadPid,
      createdAt: Date.now() - 10_000,
      nonce: "stale-owner",
    })}\n`, "utf8");
    let entered = false;
    try {
      await withProductionFixtureLockForTest(
        async () => { entered = true; },
        { lockPath, waitTimeoutMs: 1_000, staleAfterMs: 1, pollIntervalMs: 5 },
      );
      expect(entered).toBe(true);
      await expect(readFile(join(lockPath, "owner.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
