import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CheckpointStoreError,
  createCheckpointStore,
  type CheckpointEnvelope
} from "../src/persistence/checkpoint-store.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "martin-checkpoints-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CheckpointStore", () => {
  it("publishes checkpoints on the repo-owned synchronized filesystem without hard-link support", async () => {
    const root = await mkdtemp(join(process.cwd(), ".checkpoint-synchronized-fs-"));
    roots.push(root);
    const store = createCheckpointStore<{ value: number }>({ root });
    const appended = await store.append({ value: 1 }, {
      checkpointId: "onedrive-compatible", writerId: "writer", expectedHeadHash: null
    });
    const replaced = await store.append({ value: 2 }, {
      checkpointId: "onedrive-compatible-second", writerId: "writer", expectedHeadHash: appended.checkpoint.hash
    });
    await expect(store.loadHead()).resolves.toEqual(replaced.checkpoint);
  });

  it("recovers the previous head when synchronized-filesystem rotation is interrupted", async () => {
    const root = await tempRoot();
    const store = createCheckpointStore<{ value: number }>({ root });
    const first = await store.append({ value: 1 }, {
      checkpointId: "rotation-first", writerId: "writer", expectedHeadHash: null
    });
    await rename(join(root, "head.json"), join(root, ".head.previous.json"));

    await expect(store.loadHead()).resolves.toEqual(first.checkpoint);
    const second = await store.append({ value: 2 }, {
      checkpointId: "rotation-second", writerId: "writer", expectedHeadHash: first.checkpoint.hash
    });
    await expect(store.loadHead()).resolves.toEqual(second.checkpoint);
    await expect(readFile(join(root, ".head.previous.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes immutable checkpoint bytes before atomically advancing head", async () => {
    const root = await tempRoot();
    const store = createCheckpointStore<{ value: number }>({ root });

    const first = await store.append({ value: 1 }, {
      checkpointId: "cp-1",
      writerId: "writer-a",
      expectedHeadHash: null,
      now: "2026-11-03T00:00:00.000Z"
    });

    expect(first.checkpoint.parentHash).toBeNull();
    expect(first.checkpoint.sequence).toBe(1);
    expect(first.compaction.arraysTrimmed).toBe(0);
    await expect(store.loadHead()).resolves.toEqual(first.checkpoint);

    const checkpointBytes = await readFile(join(root, "checkpoints", "cp-1.json"), "utf8");
    const head = JSON.parse(await readFile(join(root, "head.json"), "utf8")) as {
      checkpointId: string;
      checkpointHash: string;
    };
    expect(JSON.parse(checkpointBytes)).toEqual(first.checkpoint);
    expect(head).toEqual({ checkpointId: "cp-1", checkpointHash: first.checkpoint.hash, sequence: 1 });
  });

  it("rejects duplicate checkpoint ids and stale compare-and-swap writers", async () => {
    const root = await tempRoot();
    const store = createCheckpointStore<{ value: number }>({ root });
    const first = await store.append({ value: 1 }, {
      checkpointId: "cp-1",
      writerId: "writer-a",
      expectedHeadHash: null
    });

    await expect(store.append({ value: 2 }, {
      checkpointId: "cp-1",
      writerId: "writer-b",
      expectedHeadHash: first.checkpoint.hash
    })).rejects.toMatchObject({ code: "duplicate_checkpoint" });

    await expect(store.append({ value: 2 }, {
      checkpointId: "cp-2",
      writerId: "writer-b",
      expectedHeadHash: null
    })).rejects.toMatchObject({ code: "stale_writer" });
  });

  it("assigns and validates a monotonic sequence across the parent chain", async () => {
    const root = await tempRoot();
    const store = createCheckpointStore<{ value: number }>({ root });
    const first = await store.append({ value: 1 }, {
      checkpointId: "seq-1", writerId: "writer", expectedHeadHash: null
    });
    const second = await store.append({ value: 2 }, {
      checkpointId: "seq-2", writerId: "writer", expectedHeadHash: first.checkpoint.hash
    });
    expect(second.checkpoint.sequence).toBe(2);

    const path = join(root, "checkpoints", "seq-2.json");
    const mutated = { ...second.checkpoint, sequence: 1 };
    await writeFile(path, `${JSON.stringify(mutated)}\n`, "utf8");
    await expect(store.loadHead()).rejects.toMatchObject({ code: "corrupt_checkpoint" });
  });

  it("serializes competing writers through a filesystem lock", async () => {
    const root = await tempRoot();
    const firstStore = createCheckpointStore<{ writer: string }>({ root });
    const secondStore = createCheckpointStore<{ writer: string }>({ root });

    const results = await Promise.allSettled([
      firstStore.append({ writer: "a" }, {
        checkpointId: "cp-a",
        writerId: "writer-a",
        expectedHeadHash: null
      }),
      secondStore.append({ writer: "b" }, {
        checkpointId: "cp-b",
        writerId: "writer-b",
        expectedHeadHash: null
      })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "stale_writer" });
  });

  it("fails closed on corrupt checkpoint bytes and a missing parent", async () => {
    const root = await tempRoot();
    const store = createCheckpointStore<{ value: number }>({ root });
    const first = await store.append({ value: 1 }, {
      checkpointId: "cp-1",
      writerId: "writer-a",
      expectedHeadHash: null
    });
    const second = await store.append({ value: 2 }, {
      checkpointId: "cp-2",
      writerId: "writer-a",
      expectedHeadHash: first.checkpoint.hash
    });

    const secondPath = join(root, "checkpoints", "cp-2.json");
    const parsed = JSON.parse(await readFile(secondPath, "utf8")) as CheckpointEnvelope<{ value: number }>;
    await writeFile(secondPath, `${JSON.stringify({ ...parsed, state: { value: 999 } }, null, 2)}\n`, "utf8");
    await expect(store.loadHead()).rejects.toMatchObject({ code: "corrupt_checkpoint" });

    await writeFile(secondPath, `${JSON.stringify(second.checkpoint, null, 2)}\n`, "utf8");
    await unlink(join(root, "checkpoints", "cp-1.json"));
    await expect(store.loadHead()).rejects.toMatchObject({ code: "missing_parent" });
  });

  it("fails closed on malformed head data instead of treating it as an empty store", async () => {
    const root = await tempRoot();
    const store = createCheckpointStore({ root });
    await writeFile(join(root, "head.json"), "{not-json", "utf8");

    await expect(store.loadHead()).rejects.toEqual(
      expect.objectContaining<Partial<CheckpointStoreError>>({ code: "corrupt_head" })
    );
  });

  it("bounds nested arrays during checkpoint compaction without mutating caller state", async () => {
    const root = await tempRoot();
    const store = createCheckpointStore<{ events: number[]; nested: { notes: string[] } }>({
      root,
      maxArrayEntries: 2
    });
    const state = { events: [1, 2, 3, 4], nested: { notes: ["a", "b", "c"] } };

    const result = await store.append(state, {
      checkpointId: "cp-bounded",
      writerId: "writer-a",
      expectedHeadHash: null
    });

    expect(result.checkpoint.state).toEqual({ events: [3, 4], nested: { notes: ["b", "c"] } });
    expect(result.compaction).toMatchObject({
      algorithm: "sha256-json-v1",
      arraysTrimmed: 2,
      entriesRemoved: 3
    });
    expect(result.compaction.removedContentHash).toMatch(/^[a-f0-9]{64}$/u);
    await expect(store.loadCompactionProvenance(result.compaction.removedContentHash)).resolves.toEqual([
      { path: "$/events", entries: [1, 2] },
      { path: "$/nested/notes", entries: ["a"] }
    ]);
    expect(state.events).toEqual([1, 2, 3, 4]);
    expect(await readdir(join(root, "checkpoints"))).toEqual(["cp-bounded.json"]);
  });
});


describe("CheckpointStore fail-closed regressions", () => {
  it("rejects a missing head when checkpoint history still exists", async () => {
    const root = await tempRoot();
    const store = createCheckpointStore({ root });
    await store.append({ value: 1 }, {
      checkpointId: "first", writerId: "writer", expectedHeadHash: null
    });
    await unlink(join(root, "head.json"));
    await expect(store.loadHead()).rejects.toMatchObject({ code: "corrupt_head" });
    await expect(store.append({ value: 2 }, {
      checkpointId: "second", writerId: "writer", expectedHeadHash: null
    })).rejects.toMatchObject({ code: "corrupt_head" });
    expect(await readdir(join(root, "checkpoints"))).toEqual(["first.json"]);
  });

  it("rejects invalid lock limits and timestamps before publishing bytes", async () => {
    const root = await tempRoot();
    expect(() => createCheckpointStore({ root, lockTimeoutMs: Infinity })).toThrow(RangeError);
    expect(() => createCheckpointStore({ root, lockRetryMs: 0 })).toThrow(RangeError);
    const store = createCheckpointStore({ root });
    await expect(store.append({}, {
      checkpointId: "invalid", writerId: "writer", expectedHeadHash: null, now: "invalid"
    })).rejects.toThrow(TypeError);
    await expect(store.loadHead()).resolves.toBeNull();
  });
});


it("enforces CAS across independent writer processes", async () => {
  const root = await tempRoot();
  const moduleUrl = new URL("../src/persistence/checkpoint-store.ts", import.meta.url).href;
  const run = promisify(execFile);
  const results = await Promise.all(["a", "b"].map(async (writer) => {
    const script = `
      const { createCheckpointStore } = await import(${JSON.stringify(moduleUrl)});
      const store = createCheckpointStore({ root: ${JSON.stringify(root)} });
      try {
        await store.append({ writer: ${JSON.stringify(writer)} }, {
          checkpointId: ${JSON.stringify(writer)}, writerId: ${JSON.stringify(writer)}, expectedHeadHash: null
        });
        console.log("published");
      } catch (error) {
        if (error.code !== "stale_writer") throw error;
        console.log(error.code);
      }
    `;
    const result = await run(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", script]);
    return result.stdout.trim();
  }));
  expect(results.sort()).toEqual(["published", "stale_writer"]);
  await expect(createCheckpointStore({ root }).loadHead()).resolves.toBeTruthy();
});

describe("CheckpointStore crash recovery and compaction provenance", () => {
  it("attempts acquisition immediately after reclaiming the exact stale lock", async () => {
    const root = await tempRoot();
    await writeFile(join(root, ".checkpoint.lock"), `${JSON.stringify({
      token: "dead-owner",
      pid: 2_147_483_647,
      acquiredAt: "2020-01-01T00:00:00.000Z"
    })}\n`, "utf8");
    const store = createCheckpointStore({
      root,
      lockTimeoutMs: 0,
      lockRetryMs: 5,
      lockStaleMs: 1
    });

    await expect(store.append({}, {
      checkpointId: "after-immediate-reclaim",
      writerId: "parent",
      expectedHeadHash: null
    })).resolves.toMatchObject({ checkpoint: { checkpointId: "after-immediate-reclaim" } });
  });

  it("reclaims a stale lock only after its real owner process exits", async () => {
    const root = await tempRoot();
    const script = `
      const { mkdir, open } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const root = ${JSON.stringify("__ROOT__")};
      await mkdir(root, { recursive: true });
      const handle = await open(join(root, ".checkpoint.lock"), "wx");
      await handle.writeFile(JSON.stringify({ token: "child", pid: process.pid, acquiredAt: new Date().toISOString() }) + "\\n");
      await handle.close();
      console.log("locked");
      setInterval(() => {}, 1000);
    `.replace("__ROOT__", root.replaceAll("\\", "\\\\"));
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "inherit"]
    });
    await once(child.stdout!, "data");
    const store = createCheckpointStore({
      root,
      lockTimeoutMs: 30,
      lockRetryMs: 5,
      lockStaleMs: 10
    });

    await expect(store.append({}, {
      checkpointId: "while-live", writerId: "parent", expectedHeadHash: null
    })).rejects.toMatchObject({ code: "lock_timeout" });

    child.kill();
    await once(child, "exit");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(store.append({}, {
      checkpointId: "after-crash", writerId: "parent", expectedHeadHash: null
    })).resolves.toMatchObject({ checkpoint: { checkpointId: "after-crash" } });
  });

  it("binds compacted-away content into checkpoint integrity provenance", async () => {
    const root = await tempRoot();
    const store = createCheckpointStore<{ events: string[] }>({ root, maxArrayEntries: 1 });
    const result = await store.append({ events: ["secret-a", "secret-b"] }, {
      checkpointId: "compacted", writerId: "writer", expectedHeadHash: null
    });

    expect(result.compaction).toMatchObject({
      algorithm: "sha256-json-v1",
      entriesRemoved: 1
    });
    expect(result.compaction.removedContentHash).toMatch(/^[a-f0-9]{64}$/u);

    const path = join(root, "checkpoints", "compacted.json");
    const checkpoint = JSON.parse(await readFile(path, "utf8"));
    checkpoint.compaction.removedContentHash = "0".repeat(64);
    await writeFile(path, `${JSON.stringify(checkpoint)}\n`, "utf8");
    await expect(store.loadHead()).rejects.toMatchObject({ code: "corrupt_checkpoint" });
  });

  it("recovers when both a dead lock owner and dead reclaim owner crashed", async () => {
    const root = await tempRoot();
    const old = "2000-01-01T00:00:00.000Z";
    await writeFile(join(root, ".checkpoint.lock"), JSON.stringify({
      token: "dead-lock", pid: 2_147_483_647, acquiredAt: old
    }));
    await writeFile(join(root, ".checkpoint.lock.reclaim"), JSON.stringify({
      token: "dead-reclaimer", pid: 2_147_483_647, acquiredAt: old
    }));
    const store = createCheckpointStore({
      root, lockStaleMs: 1, lockTimeoutMs: 100, lockRetryMs: 5
    });
    await expect(store.append({}, {
      checkpointId: "recovered", writerId: "writer", expectedHeadHash: null
    })).resolves.toMatchObject({ checkpoint: { checkpointId: "recovered" } });
  });

  it("falls back to the last hash-verified head across reserve, mid-write, and before-head crashes", async () => {
    const root = await tempRoot();
    const store = createCheckpointStore<{ value: number }>({ root });
    const first = await store.append({ value: 1 }, {
      checkpointId: "first", writerId: "writer", expectedHeadHash: null
    });
    const firstHead = await readFile(join(root, "head.json"), "utf8");

    await writeFile(join(root, "checkpoints", "reserved.json"), "", "utf8");
    await writeFile(join(root, "checkpoints", ".killed-mid-write.tmp"), "{partial", "utf8");
    const second = await store.append({ value: 2 }, {
      checkpointId: "orphan-before-head",
      writerId: "writer",
      expectedHeadHash: first.checkpoint.hash
    });
    expect(second.checkpoint.parentHash).toBe(first.checkpoint.hash);
    await writeFile(join(root, "head.json"), firstHead, "utf8");

    await expect(store.loadHead()).resolves.toEqual(first.checkpoint);
    await expect(store.append({ value: 3 }, {
      checkpointId: "after-recovery",
      writerId: "writer",
      expectedHeadHash: first.checkpoint.hash
    })).resolves.toMatchObject({
      checkpoint: { parentHash: first.checkpoint.hash, state: { value: 3 } }
    });
  });
});
