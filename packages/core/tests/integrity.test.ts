import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  loadOrCreateIntegrityKey,
  readIntegrityRecord,
  signAndPersistLoopRecord,
  signLoopRecord,
  verifyLoopRecordIntegrity
} from "../src/persistence/integrity";

async function freshRunsRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "martin-integrity-"));
}

const sampleLoop = {
  loopId: "loop_sample",
  status: "completed",
  budget: { maxUsd: 5, maxIterations: 3 },
  events: [{ kind: "run.exited", payload: { status: "exited" } }]
};

describe("canonicalJsonStringify", () => {
  it("produces identical output regardless of key insertion order", () => {
    const a = { z: 1, a: { c: 2, b: 3 } };
    const b = { a: { b: 3, c: 2 }, z: 1 };

    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
  });

  it("preserves array element order while sorting object keys within elements", () => {
    const value = [{ b: 1, a: 2 }, { d: 3, c: 4 }];

    expect(canonicalJsonStringify(value)).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
  });
});

describe("loadOrCreateIntegrityKey", () => {
  it("generates a key on first use and reuses the same key on subsequent loads", async () => {
    const runsRoot = await freshRunsRoot();

    const first = await loadOrCreateIntegrityKey(runsRoot);
    const second = await loadOrCreateIntegrityKey(runsRoot);

    expect(first.equals(second)).toBe(true);

    const persisted = (await readFile(join(runsRoot, ".integrity-key"), "utf8")).trim();
    expect(persisted).toBe(first.toString("hex"));
  });
});

describe("signAndPersistLoopRecord / verifyLoopRecordIntegrity", () => {
  it("reports 'verified' for an untouched signed record", async () => {
    const runsRoot = await freshRunsRoot();
    const runDirectory = join(runsRoot, sampleLoop.loopId);
    await mkdir(runDirectory, { recursive: true });
    await signAndPersistLoopRecord(runsRoot, runDirectory, sampleLoop, () => "2026-06-01T00:00:00.000Z");

    const status = await verifyLoopRecordIntegrity(runsRoot, runDirectory, sampleLoop);
    expect(status).toBe("verified");

    const record = await readIntegrityRecord(runDirectory);
    expect(record?.algorithm).toBe("hmac-sha256");
    expect(record?.signedAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("reports 'tamper_detected' when the loop record is edited after signing", async () => {
    const runsRoot = await freshRunsRoot();
    const runDirectory = join(runsRoot, sampleLoop.loopId);
    await mkdir(runDirectory, { recursive: true });
    await signAndPersistLoopRecord(runsRoot, runDirectory, sampleLoop);

    const tampered = { ...sampleLoop, status: "passed", budget: { ...sampleLoop.budget, maxUsd: 999 } };
    const status = await verifyLoopRecordIntegrity(runsRoot, runDirectory, tampered);

    expect(status).toBe("tamper_detected");
  });

  it("reports 'tamper_detected' when the integrity sidecar itself is hand-edited", async () => {
    const runsRoot = await freshRunsRoot();
    const runDirectory = join(runsRoot, sampleLoop.loopId);
    await mkdir(runDirectory, { recursive: true });
    await signAndPersistLoopRecord(runsRoot, runDirectory, sampleLoop);

    const sidecarPath = join(runDirectory, "integrity.json");
    const record = JSON.parse(await readFile(sidecarPath, "utf8")) as Record<string, unknown>;
    record.loopRecordHash = "0".repeat(64);
    await writeFile(sidecarPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const status = await verifyLoopRecordIntegrity(runsRoot, runDirectory, sampleLoop);
    expect(status).toBe("tamper_detected");
  });

  it("reports 'unsigned' when no integrity sidecar exists", async () => {
    const runsRoot = await freshRunsRoot();
    const runDirectory = join(runsRoot, "loop_no_sidecar");
    await writeFile(join(runsRoot, ".keep"), "", "utf8").catch(() => {});

    const status = await verifyLoopRecordIntegrity(runsRoot, runDirectory, sampleLoop);
    expect(status).toBe("unsigned");
  });

  it("reports 'tamper_detected' when the sidecar was signed with a different local key", async () => {
    const runsRoot = await freshRunsRoot();
    const runDirectory = join(runsRoot, sampleLoop.loopId);

    const foreignKey = Buffer.from("11".repeat(32), "hex");
    const record = signLoopRecord(foreignKey, sampleLoop, "2026-06-01T00:00:00.000Z");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(join(runDirectory, "integrity.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const status = await verifyLoopRecordIntegrity(runsRoot, runDirectory, sampleLoop);
    expect(status).toBe("tamper_detected");
  });

  it("never throws when the runs root cannot be created (best-effort signing)", async () => {
    const parent = await freshRunsRoot();
    const blockerFile = join(parent, "blocker");
    await writeFile(blockerFile, "not a directory", "utf8");

    // `blocker` is a regular file, so treating it as a directory segment makes
    // both key persistence and the canonical write fail with ENOTDIR.
    const runsRoot = join(blockerFile, "runs");
    const runDirectory = join(runsRoot, sampleLoop.loopId);

    await expect(signAndPersistLoopRecord(runsRoot, runDirectory, sampleLoop)).resolves.toBeUndefined();
    expect(await verifyLoopRecordIntegrity(runsRoot, runDirectory, sampleLoop)).toBe("unsigned");
  });
});
