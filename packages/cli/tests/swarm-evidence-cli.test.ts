import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseCliArguments } from "../src/index.js";
import {
  executeSwarmDossierCommand,
  executeSwarmShareCommand,
  executeSwarmVerifyCommand,
  type SwarmEvidenceCommandDependencies,
} from "../src/swarm-command.js";

const scratch: string[] = [];

async function createCanonicalTempRoot(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("swarm dossier and verify", () => {
  it("keeps dossier, verify, and share complete offline without fetch, queue, or hosted warnings", async () => {
    const root = await createCanonicalTempRoot("martin-swarm-offline-evidence-");
    scratch.push(root);
    const queueDir = join(root, "queue");
    const outputDir = join(root, "share");
    const dependencies = evidenceDependencies();
    vi.mocked(dependencies.buildSwarmShareProjection).mockResolvedValue(shareProjection());
    const previousQueue = process.env["MARTIN_SYNC_QUEUE_DIR"];
    const previousEndpoint = process.env["MARTIN_TELEMETRY_ENDPOINT"];
    const previousToken = process.env["MARTIN_API_TOKEN"];
    process.env["MARTIN_SYNC_QUEUE_DIR"] = queueDir;
    delete process.env["MARTIN_TELEMETRY_ENDPOINT"];
    delete process.env["MARTIN_API_TOKEN"];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must stay offline"));

    try {
      const dossier = await executeSwarmDossierCommand({ latest: true }, "json", dependencies);
      const verify = await executeSwarmVerifyCommand({ latest: true }, "json", dependencies);
      const share = await executeSwarmShareCommand({ latest: true, outputDir }, "json", dependencies);

      expect([dossier.exitCode, verify.exitCode, share.exitCode]).toEqual([0, 0, 0]);
      expect([dossier.stderr, verify.stderr, share.stderr]).toEqual(["", "", ""]);
      expect(fetchSpy).not.toHaveBeenCalled();
      await expect(readdir(queueDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousQueue === undefined) delete process.env["MARTIN_SYNC_QUEUE_DIR"];
      else process.env["MARTIN_SYNC_QUEUE_DIR"] = previousQueue;
      if (previousEndpoint === undefined) delete process.env["MARTIN_TELEMETRY_ENDPOINT"];
      else process.env["MARTIN_TELEMETRY_ENDPOINT"] = previousEndpoint;
      if (previousToken === undefined) delete process.env["MARTIN_API_TOKEN"];
      else process.env["MARTIN_API_TOKEN"] = previousToken;
    }
  });

  it("parses exact --id or --latest selectors and rejects duplicates, missing values, extras, and unknown options", () => {
    expect(parseCliArguments(["swarm", "dossier", "--id", "swarm-a", "--runs-dir", "runs"]))
      .toEqual({ command: "swarm_dossier", request: { swarmId: "swarm-a", runsDir: "runs" } });
    expect(parseCliArguments(["swarm", "verify", "--latest"]))
      .toEqual({ command: "swarm_verify", request: { latest: true } });
    expect(() => parseCliArguments(["swarm", "dossier"])).toThrow(/exactly one selector|--id|--latest/iu);
    expect(() => parseCliArguments(["swarm", "verify", "--id"])).toThrow(/requires a value/iu);
    expect(() => parseCliArguments(["swarm", "verify", "--latest", "--latest"])).toThrow(/duplicate/iu);
    expect(() => parseCliArguments(["swarm", "dossier", "--latest", "--id", "swarm-a"])).toThrow(/exactly one selector/iu);
    expect(() => parseCliArguments(["swarm", "verify", "--latest", "extra"])).toThrow(/unsupported/iu);
    expect(() => parseCliArguments(["swarm", "verify", "--latest", "--force"])).toThrow(/unsupported/iu);
  });

  it("renders stable dossier JSON and human output with separate integrity and task states", async () => {
    const dependencies = evidenceDependencies();
    const request = { swarmId: "swarm-a", runsDir: "C:/runs" } as const;

    const first = await executeSwarmDossierCommand(request, "json", dependencies);
    const second = await executeSwarmDossierCommand(request, "json", dependencies);
    const human = await executeSwarmDossierCommand(request, "human", dependencies);

    expect(first).toEqual(second);
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      command: "swarm dossier",
      swarmId: "swarm-a",
      integrityState: "verified",
      taskVerificationState: "passed",
    });
    expect(human.stdout).toContain("Integrity: VERIFIED");
    expect(human.stdout).toContain("Task verification: PASSED");
  });

  it("keeps intact failed task evidence distinct and exits verification_failed", async () => {
    const dependencies = evidenceDependencies({
      taskVerificationState: "failed",
      parentOutcomeState: "needs_review",
      verified: false,
    });

    const result = await executeSwarmVerifyCommand({ latest: true }, "json", dependencies);

    expect(result.exitCode).toBe(7);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "swarm verify",
      integrityState: "verified",
      taskVerificationState: "failed",
      parentOutcomeState: "needs_review",
      verified: false,
    });
  });

  it.each([
    ["MISSING_SWARM_STORE", "not_found"],
    ["ENOENT", "store_unreadable"],
    ["MALFORMED_JSON", "store_unreadable"],
    ["MALFORMED_EVENT_LOG", "store_unreadable"],
    ["EVENT_CLAIM_GAP", "store_unreadable"],
    ["SWARM_SEAL_COMMIT_MISMATCH", "verification_failed"],
    ["SWARM_SEAL_INTEGRITY_FAILED", "verification_failed"],
    ["EVIDENCE_INDEX_CONFLICT", "verification_failed"],
    ["SWARM_SEAL_PATH_ALIAS", "policy_blocked"],
    ["STORE_PATH_ESCAPE", "policy_blocked"],
  ] as const)("maps Core evidence failure %s to %s", async (code, category) => {
    const dependencies = evidenceDependencies();
    vi.mocked(dependencies.verifySwarmEvidence).mockRejectedValue(Object.assign(new Error(code), { code }));

    await expect(executeSwarmVerifyCommand({ latest: true }, "human", dependencies))
      .rejects.toMatchObject({ category });
  });

  it("imports only the narrow Core root facade and no internal swarm authority", async () => {
    const source = await readFile(new URL("../src/swarm-command.ts", import.meta.url), "utf8");
    expect(source).toContain("readSwarmDossier");
    expect(source).toContain("verifySwarmEvidence");
    expect(source).toContain("buildSwarmShareProjection");
    expect(source).not.toMatch(/@martin\/core\/src\//u);
    expect(source).not.toMatch(/from ["'][^"']*swarm\/(?:live-store|evidence|parent-receipt)/u);
  });
});

describe("swarm share", () => {
  it("parses a required output directory without accepting force or unsafe overrides", () => {
    expect(parseCliArguments(["swarm", "share", "--id", "swarm-a", "--out-dir", "bundle"]))
      .toEqual({ command: "swarm_share", request: { swarmId: "swarm-a", outputDir: "bundle" } });
    expect(parseCliArguments(["swarm", "share", "--latest", "--out-dir", "bundle"]))
      .toEqual({ command: "swarm_share", request: { latest: true, outputDir: "bundle" } });
    expect(() => parseCliArguments(["swarm", "share", "--latest"])).toThrow(/out-dir/iu);
    expect(() => parseCliArguments(["swarm", "share", "--latest", "--out-dir", "bundle", "--force"]))
      .toThrow(/unsupported/iu);
  });

  it("atomically publishes exactly three deterministic redacted local artifacts", async () => {
    const root = await createCanonicalTempRoot("martin-swarm-share-");
    scratch.push(root);
    const firstDir = join(root, "first");
    const secondDir = join(root, "second");
    const dependencies = evidenceDependencies();
    vi.mocked(dependencies.buildSwarmShareProjection).mockResolvedValue(shareProjection());

    const first = await executeSwarmShareCommand(
      { swarmId: "swarm-a", outputDir: firstDir }, "json", dependencies,
    );
    const second = await executeSwarmShareCommand(
      { latest: true, outputDir: secondDir }, "json", dependencies,
    );

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect((await readdir(firstDir)).sort()).toEqual([
      "swarm-proof.md", "swarm-proof.svg", "swarm-receipt.json",
    ]);
    expect((await readdir(secondDir)).sort()).toEqual((await readdir(firstDir)).sort());
    for (const file of await readdir(firstDir)) {
      expect(await readFile(join(firstDir, file), "utf8"))
        .toBe(await readFile(join(secondDir, file), "utf8"));
    }
    const combined = (await Promise.all((await readdir(firstDir)).map((file) => readFile(join(firstDir, file), "utf8")))).join("\n");
    expect(combined).not.toMatch(/sk-proj-|AKIA[0-9A-Z]{16}|C:\\Users\\|ML_Core_OSS_Internal|private-repo/iu);
    expect(JSON.parse(first.stdout)).toMatchObject({
      command: "swarm share", swarmId: "swarm-a", outputDir: firstDir,
    });
  });

  it.each([
    "MISSING_SWARM_STORE",
    "ENOENT",
    "MALFORMED_JSON",
    "SWARM_SEAL_COMMIT_MISMATCH",
    "EVIDENCE_INDEX_CONFLICT",
    "SWARM_SEAL_INTEGRITY_FAILED",
    "SWARM_SHARE_NOT_VERIFIED",
  ])("creates zero files when Core rejects unsafe evidence with %s", async (code) => {
    const root = await createCanonicalTempRoot("martin-swarm-share-denied-");
    scratch.push(root);
    const outputDir = join(root, "bundle");
    const dependencies = evidenceDependencies();
    vi.mocked(dependencies.buildSwarmShareProjection).mockRejectedValue(Object.assign(new Error(code), { code }));

    await expect(executeSwarmShareCommand(
      { latest: true, outputDir }, "human", dependencies,
    )).rejects.toBeDefined();
    await expect(readdir(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses overwrite and an aliased output ancestor without changing existing files", async () => {
    const root = await createCanonicalTempRoot("martin-swarm-share-paths-");
    scratch.push(root);
    const existing = join(root, "existing");
    await mkdir(existing);
    await writeFile(join(existing, "keep.txt"), "keep", "utf8");
    const dependencies = evidenceDependencies();
    vi.mocked(dependencies.buildSwarmShareProjection).mockResolvedValue(shareProjection());

    await expect(executeSwarmShareCommand(
      { latest: true, outputDir: existing }, "human", dependencies,
    )).rejects.toMatchObject({ category: "policy_blocked" });
    expect(await readdir(existing)).toEqual(["keep.txt"]);

    const real = join(root, "real-parent");
    const alias = join(root, "alias-parent");
    await mkdir(real);
    await symlink(real, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(executeSwarmShareCommand(
      { latest: true, outputDir: join(alias, "bundle") }, "human", dependencies,
    )).rejects.toMatchObject({ category: "policy_blocked" });
    expect(await readdir(real)).toEqual([]);
  });

  it("fails closed when the validated parent is swapped before staging", async () => {
    const root = await createCanonicalTempRoot("martin-swarm-share-swap-");
    scratch.push(root);
    const parent = join(root, "parent");
    const moved = join(root, "moved-parent");
    const outputDir = join(parent, "bundle");
    await mkdir(parent);
    const dependencies = evidenceDependencies();
    vi.mocked(dependencies.buildSwarmShareProjection).mockResolvedValue(shareProjection());

    await expect(executeSwarmShareCommand(
      { latest: true, outputDir },
      "human",
      dependencies,
      {
        afterInitialValidation: async () => {
          await rename(parent, moved);
          await symlink(moved, parent, process.platform === "win32" ? "junction" : "dir");
        },
      },
    )).rejects.toMatchObject({ category: "policy_blocked" });
    expect(await readdir(moved)).toEqual([]);
  });

  it("rejects a destination created during publication and serializes concurrent publishers", async () => {
    const root = await createCanonicalTempRoot("martin-swarm-share-race-");
    scratch.push(root);
    const racedOutput = join(root, "raced");
    const dependencies = evidenceDependencies();
    vi.mocked(dependencies.buildSwarmShareProjection).mockResolvedValue(shareProjection());

    await expect(executeSwarmShareCommand(
      { latest: true, outputDir: racedOutput },
      "human",
      dependencies,
      {
        afterFinalValidation: async () => {
          await mkdir(racedOutput);
          await writeFile(join(racedOutput, "foreign.txt"), "do not replace\n", "utf8");
        },
      },
    )).rejects.toMatchObject({ category: "policy_blocked" });
    expect(await readdir(racedOutput)).toEqual(["foreign.txt"]);
    expect(await readFile(join(racedOutput, "foreign.txt"), "utf8")).toBe("do not replace\n");

    const concurrentOutput = join(root, "concurrent");
    const results = await Promise.allSettled([
      executeSwarmShareCommand({ latest: true, outputDir: concurrentOutput }, "human", dependencies),
      executeSwarmShareCommand({ latest: true, outputDir: concurrentOutput }, "human", dependencies),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { category: "policy_blocked" } });
    expect((await readdir(concurrentOutput)).sort()).toEqual([
      "swarm-proof.md", "swarm-proof.svg", "swarm-receipt.json",
    ]);
  });

  it("fails closed when the parent changes after final validation", async () => {
    const root = await createCanonicalTempRoot("martin-swarm-share-final-swap-");
    scratch.push(root);
    const parent = join(root, "parent");
    const moved = join(root, "moved-parent");
    const outputDir = join(parent, "bundle");
    await mkdir(parent);
    const dependencies = evidenceDependencies();
    vi.mocked(dependencies.buildSwarmShareProjection).mockResolvedValue(shareProjection());

    await expect(executeSwarmShareCommand(
      { latest: true, outputDir },
      "human",
      dependencies,
      {
        afterFinalValidation: async () => {
          await rename(parent, moved);
          await symlink(moved, parent, process.platform === "win32" ? "junction" : "dir");
        },
      },
    )).rejects.toMatchObject({ category: "policy_blocked" });
    expect(await readdir(moved)).toEqual([]);
  });

  it("pins the claimed destination while a replacement is installed before artifact writes", async () => {
    const root = await createCanonicalTempRoot("martin-swarm-share-claimed-swap-");
    scratch.push(root);
    const outputDir = join(root, "bundle");
    const moved = join(root, "owned-bundle");
    const dependencies = evidenceDependencies();
    vi.mocked(dependencies.buildSwarmShareProjection).mockResolvedValue(shareProjection());

    await expect(executeSwarmShareCommand(
      { latest: true, outputDir },
      "human",
      dependencies,
      {
        afterDestinationClaim: async () => {
          await rename(outputDir, moved);
          await mkdir(outputDir);
          await writeFile(join(outputDir, "foreign.txt"), "untouched\n", "utf8");
        },
      },
    )).rejects.toMatchObject({ category: "policy_blocked" });
    if (process.platform === "win32") {
      expect(await readdir(outputDir)).toEqual([]);
      await expect(readdir(moved)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(await readdir(outputDir)).toEqual(["foreign.txt"]);
      expect(await readFile(join(outputDir, "foreign.txt"), "utf8")).toBe("untouched\n");
      expect((await readdir(moved)).sort()).toEqual([
        "swarm-proof.md", "swarm-proof.svg", "swarm-receipt.json",
      ]);
    }
  });

  it("never writes a share bundle inside the canonical runs/evidence store", async () => {
    const root = await createCanonicalTempRoot("martin-swarm-share-store-");
    scratch.push(root);
    const runsRoot = join(root, "runs");
    const evidenceParent = join(runsRoot, "_swarms", "swarm-a", "evidence");
    await mkdir(evidenceParent, { recursive: true });
    const outputDir = join(evidenceParent, "share");
    const dependencies = evidenceDependencies();
    vi.mocked(dependencies.buildSwarmShareProjection).mockResolvedValue(shareProjection());

    await expect(executeSwarmShareCommand(
      { latest: true, runsDir: runsRoot, outputDir }, "human", dependencies,
    )).rejects.toMatchObject({ category: "policy_blocked" });
    await expect(readdir(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not suppress temporary cleanup failures in the publication path", async () => {
    const source = await readFile(new URL("../src/swarm-command.ts", import.meta.url), "utf8");
    expect(source).not.toContain("await rm(temporary, { recursive: true, force: true }).catch(() => undefined)");
    expect(source).not.toContain("await rename(temporary, outputDir)");
    expect(source).not.toContain("rm(outputDir");
  });
});

function evidenceDependencies(overrides: Record<string, unknown> = {}): SwarmEvidenceCommandDependencies {
  const dossier = {
    schemaVersion: "martin.swarm-dossier.v1" as const,
    swarmId: "swarm-a",
    planHash: "a".repeat(64),
    receiptId: "swarm-receipt-a",
    receiptSha256: "b".repeat(64),
    objective: "Ship a governed swarm",
    engine: { engine: "codex" as const, model: "gpt-test" },
    baselineCommit: "c".repeat(40),
    parentOutcome: { state: "verified" as const, reason: "global_verifier_passed" },
    integrityState: "verified" as const,
    taskVerificationState: "passed" as const,
    sealedAt: "2026-10-03T12:00:00.000Z",
    taskCounts: { total: 1, accepted: 1, stopped: 0, needsReview: 0, other: 0 },
    agentCounts: { total: 1, verified: 1, stopped: 0, needsReview: 0, other: 0 },
    budget: { capUsd: 2, settledUsd: 0.25, settledTokens: 100 },
    evidence: { files: 4, childReceipts: 1, events: 8, blockedActions: 0, reassignments: 0 },
  };
  const verification = {
    schemaVersion: "martin.swarm-verification.v1" as const,
    swarmId: dossier.swarmId,
    planHash: dossier.planHash,
    receiptId: dossier.receiptId,
    receiptSha256: dossier.receiptSha256,
    integrityState: "verified" as const,
    taskVerificationState: "passed" as const,
    parentOutcomeState: "verified" as const,
    verified: true,
    verifiedAt: dossier.sealedAt,
    ...overrides,
  };
  return {
    readSwarmDossier: vi.fn(async () => dossier),
    verifySwarmEvidence: vi.fn(async () => verification as never),
    buildSwarmShareProjection: vi.fn(async () => ({}) as never),
  };
}

function shareProjection() {
  return {
    schemaVersion: "martin.swarm-share.v1" as const,
    generatedAt: "2026-10-03T12:00:00.000Z",
    swarmId: "swarm-a",
    planHash: "a".repeat(64),
    receiptId: "swarm-receipt-a",
    receiptSha256: "b".repeat(64),
    baselineCommit: "c".repeat(40),
    parentOutcomeState: "verified" as const,
    integrityState: "verified" as const,
    taskVerificationState: "passed" as const,
    engine: { engine: "codex" as const, model: "gpt-test" },
    taskCounts: { total: 1, accepted: 1, stopped: 0, needsReview: 0, other: 0 },
    agentCounts: { total: 1, verified: 1, stopped: 0, needsReview: 0, other: 0 },
    budget: { capUsd: 2, settledUsd: 0.25, settledTokens: 100 },
    evidence: { files: 4, childReceipts: 1, events: 8, blockedActions: 0, reassignments: 0 },
  };
}
