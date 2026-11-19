import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  __setPersistenceLeaseAppendForTests,
  acquirePersistenceLease,
  resolvePersistenceLeasePath
} from "../src/persistence/lease.js";

const scratchRoots: string[] = [];
const originalIntegrityKeyDir = process.env["MARTIN_INTEGRITY_KEY_DIR"];
const originalPersistenceLeaseDir = process.env["MARTIN_PERSISTENCE_LEASE_DIR"];

afterEach(async () => {
  __setPersistenceLeaseAppendForTests(undefined);
  if (originalIntegrityKeyDir === undefined) delete process.env["MARTIN_INTEGRITY_KEY_DIR"];
  else process.env["MARTIN_INTEGRITY_KEY_DIR"] = originalIntegrityKeyDir;
  if (originalPersistenceLeaseDir === undefined) delete process.env["MARTIN_PERSISTENCE_LEASE_DIR"];
  else process.env["MARTIN_PERSISTENCE_LEASE_DIR"] = originalPersistenceLeaseDir;
  await Promise.all(scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function useScratchLeaseRoot(runsRoot: string): void {
  process.env["MARTIN_PERSISTENCE_LEASE_DIR"] = join(runsRoot, "private-leases");
}

describe("persistence lease queue", () => {
  it("keeps mutable lease journals outside the immutable integrity-key root", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-lease-storage-boundary-"));
    scratchRoots.push(runsRoot);
    const integrityRoot = join(runsRoot, "immutable-integrity-keys");
    const leaseRoot = join(runsRoot, "mutable-persistence-leases");
    process.env["MARTIN_INTEGRITY_KEY_DIR"] = integrityRoot;
    process.env["MARTIN_PERSISTENCE_LEASE_DIR"] = leaseRoot;

    const queuePath = resolvePersistenceLeasePath(runsRoot, "loop_storage_boundary");

    expect(queuePath.startsWith(leaseRoot)).toBe(true);
    expect(queuePath.startsWith(integrityRoot)).toBe(false);
  });

  it("keeps a failed release retryable and publishes one release under concurrent callers", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-lease-release-"));
    scratchRoots.push(runsRoot);
    useScratchLeaseRoot(runsRoot);
    const runId = "loop_release_retry";
    const release = await acquirePersistenceLease(runsRoot, runId);
    let failReleaseOnce = true;
    __setPersistenceLeaseAppendForTests(async (path, value) => {
      if (value.includes('"type":"release"') && failReleaseOnce) {
        failReleaseOnce = false;
        throw new Error("injected release append failure");
      }
      await appendFile(path, value, { encoding: "utf8", flag: "a" });
    });

    await expect(release()).rejects.toThrow("injected release append failure");
    await Promise.all([release(), release()]);

    const queuePath = resolvePersistenceLeasePath(runsRoot, runId);
    const records = (await readFile(queuePath, "utf8"))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string });
    expect(records.filter((record) => record.type === "acquire")).toHaveLength(1);
    expect(records.filter((record) => record.type === "release")).toHaveLength(1);
  });

  it("recovers a torn final record but rejects malformed non-final history", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-lease-tail-"));
    scratchRoots.push(runsRoot);
    useScratchLeaseRoot(runsRoot);
    const recoverableRunId = "loop_torn_tail";
    const recoverableQueuePath = resolvePersistenceLeasePath(runsRoot, recoverableRunId);
    await mkdir(dirname(recoverableQueuePath), { recursive: true });
    await writeFile(
      recoverableQueuePath,
      `${JSON.stringify({ type: "acquire", token: "dead", pid: 999_999, acquiredAt: "2020-01-01T00:00:00.000Z" })}\n{"type":"acq`,
      "utf8"
    );

    const release = await acquirePersistenceLease(runsRoot, recoverableRunId);
    await release();

    const corruptRunId = "loop_corrupt_middle";
    const corruptQueuePath = resolvePersistenceLeasePath(runsRoot, corruptRunId);
    await writeFile(
      corruptQueuePath,
      `${JSON.stringify({ type: "acquire", token: "dead-a", pid: 999_999, acquiredAt: "2020-01-01T00:00:00.000Z" })}\n{broken\n\n${JSON.stringify({ type: "release", token: "dead-a", releasedAt: "2020-01-01T00:00:01.000Z" })}\n`,
      "utf8"
    );
    await expect(acquirePersistenceLease(runsRoot, corruptRunId)).rejects.toMatchObject({
      code: "RUN_STORE_PERSISTENCE_LEASE_CORRUPT"
    });
  });

  it("preserves a complete final record that is missing only its newline", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-lease-no-newline-"));
    scratchRoots.push(runsRoot);
    useScratchLeaseRoot(runsRoot);
    const runId = "loop_complete_no_newline";
    const queuePath = resolvePersistenceLeasePath(runsRoot, runId);
    await mkdir(dirname(queuePath), { recursive: true });
    await writeFile(
      queuePath,
      JSON.stringify({ type: "acquire", token: "dead", pid: 999_999, acquiredAt: "2020-01-01T00:00:00.000Z" }),
      "utf8"
    );

    const release = await acquirePersistenceLease(runsRoot, runId);
    await release();

    const records = (await readFile(queuePath, "utf8"))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string });
    expect(records.map((record) => record.type)).toEqual(["acquire", "acquire", "release"]);
  });

  it("serializes two contenders that recover the same torn tail", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-lease-concurrent-tail-"));
    scratchRoots.push(runsRoot);
    useScratchLeaseRoot(runsRoot);
    const runId = "loop_concurrent_torn_tail";
    const queuePath = resolvePersistenceLeasePath(runsRoot, runId);
    await mkdir(dirname(queuePath), { recursive: true });
    await writeFile(
      queuePath,
      `${JSON.stringify({ type: "acquire", token: "dead", pid: 999_999, acquiredAt: "2020-01-01T00:00:00.000Z" })}\n{"type":"acq`,
      "utf8"
    );

    const pendingAcquisitions: Array<{ value: string; resolve: () => void; reject: (error: unknown) => void }> = [];
    __setPersistenceLeaseAppendForTests((path, value) => new Promise<void>((resolve, reject) => {
      pendingAcquisitions.push({ value, resolve, reject });
      if (pendingAcquisitions.length !== 2) return;
      void (async () => {
        try {
          await appendFile(path, pendingAcquisitions.map((pending) => pending.value).join(""), {
            encoding: "utf8",
            flag: "a"
          });
          __setPersistenceLeaseAppendForTests(undefined);
          for (const pending of pendingAcquisitions) pending.resolve();
        } catch (error) {
          for (const pending of pendingAcquisitions) pending.reject(error);
        }
      })();
    }));

    const firstAcquisition = acquirePersistenceLease(runsRoot, runId);
    const secondAcquisition = acquirePersistenceLease(runsRoot, runId);
    const firstRelease = await firstAcquisition;
    await firstRelease();
    const secondRelease = await secondAcquisition;
    await secondRelease();

    const records = (await readFile(queuePath, "utf8"))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as { type: string };
        } catch {
          return { type: "torn" };
        }
      });
    expect(records.filter((record) => record.type === "recover-torn-tail")).toHaveLength(2);
    expect(records.filter((record) => record.type === "acquire")).toHaveLength(3);
    expect(records.filter((record) => record.type === "release")).toHaveLength(2);
  });
});
