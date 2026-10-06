import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  buildSwarmHostedEnvelope,
  type BuiltSwarmHostedEnvelope,
} from "../../core/dist/swarm/hosted-export.js";
import { runProductionLiveSwarm } from "../../core/dist/swarm/live-runtime.js";
import { createSwarmLivePlan } from "@martin/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  enqueueCommittedSwarmForHostedSync,
  enqueueSwarmForHostedSync,
  flushSyncQueue,
  setSwarmClaimTransitionHookForTests,
  setSwarmReleaseIdentityResolvedHookForTests,
} from "../src/swarm-sync-client.js";

const execFileAsync = promisify(execFile);

describe("swarm hosted sync", () => {
  let root: string;
  let queueDir: string;
  let runsRoot: string;
  let integrityRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "martin-swarm-sync-"));
    queueDir = join(root, "queue");
    runsRoot = join(root, "runs");
    integrityRoot = join(root, "integrity");
    process.env["MARTIN_SYNC_QUEUE_DIR"] = queueDir;
    process.env["MARTIN_RUNS_DIR"] = runsRoot;
    process.env["MARTIN_INTEGRITY_KEY_DIR"] = integrityRoot;
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = "http://127.0.0.1:1";
    process.env["MARTIN_API_TOKEN"] = "test-token";
    await mkdir(runsRoot, { recursive: true });
  });

  afterEach(async () => {
    setSwarmClaimTransitionHookForTests(undefined);
    setSwarmReleaseIdentityResolvedHookForTests(undefined);
    vi.restoreAllMocks();
    delete process.env["MARTIN_SYNC_QUEUE_DIR"];
    delete process.env["MARTIN_RUNS_DIR"];
    delete process.env["MARTIN_INTEGRITY_KEY_DIR"];
    delete process.env["MARTIN_TELEMETRY_ENDPOINT"];
    delete process.env["MARTIN_API_TOKEN"];
    await rm(root, { recursive: true, force: true });
  });

  it("does not build, fetch, queue, or warn when hosted sync configuration is absent", async () => {
    delete process.env["MARTIN_TELEMETRY_ENDPOINT"];
    delete process.env["MARTIN_API_TOKEN"];
    const buildEnvelope = vi.fn(async () => {
      throw new Error("the authenticated exporter must not run offline");
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must stay offline"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(enqueueCommittedSwarmForHostedSync({
      runsRoot,
      swarmId: "swarm-offline",
      runtimeVersion: "0.8.0",
    }, { buildSwarmHostedEnvelope: buildEnvelope as never })).resolves.toBe("disabled");

    expect(buildEnvelope).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(readdir(queueDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(stderr).not.toHaveBeenCalled();
  });

  it("queues only an authenticated post-seal projection without changing any Phase 4 or 5 evidence bytes", async () => {
    const exported = await buildProductionExport(root, integrityRoot, 1);
    const productionRunsRoot = join(root, "production-runs");
    const before = await hashTree(productionRunsRoot);
    const buildEnvelope = vi.fn(async (input: { runsRoot: string; swarmId: string; runtimeVersion: string }) => {
      expect(input).toEqual({
        runsRoot: productionRunsRoot,
        swarmId: "swarm-production-sync",
        runtimeVersion: "0.8.0",
      });
      return exported;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("enqueue must not upload"));

    await expect(enqueueCommittedSwarmForHostedSync({
      runsRoot: productionRunsRoot,
      swarmId: "swarm-production-sync",
      runtimeVersion: "0.8.0",
    }, { buildSwarmHostedEnvelope: buildEnvelope })).resolves.toBe("queued");

    expect(buildEnvelope).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await hashTree(productionRunsRoot)).toEqual(before);
    expect(await queueFiles()).toHaveLength(1);
  }, 120_000);

  it("persists exact canonical bytes once and rejects conflicting replay for the same swarm", async () => {
    const exported = await writeHostedKey(exportFixture());

    await expect(enqueueSwarmForHostedSync(exported)).resolves.toBe("queued");
    await expect(enqueueSwarmForHostedSync(exported)).resolves.toBe("duplicate");

    const [file] = await queueFiles();
    const raw = await readFile(join(queueDir, file!), "utf8");
    const queued = JSON.parse(raw) as Record<string, unknown>;
    expect(queued).toMatchObject({
      resourceKind: "swarm",
      resourceId: exported.envelope.swarm.swarmId,
      canonicalBody: exported.canonicalBody,
      payloadSha256: exported.payloadSha256,
      envelopeIdentity: exported.envelopeIdentity,
      transportKey: exported.transportKey,
      payloadBytes: Buffer.byteLength(exported.canonicalBody, "utf8"),
    });
    expect(raw).not.toContain("hosted-secret-sentinel");

    const conflict = {
      ...exported,
      canonicalBody: `${exported.canonicalBody.trimEnd()} `,
      payloadSha256: sha256(`${exported.canonicalBody.trimEnd()} `),
    };
    await expect(enqueueSwarmForHostedSync(conflict)).rejects.toMatchObject({ code: "SWARM_SYNC_CONFLICT" });
    expect(await queueFiles()).toHaveLength(1);
  });

  it("registers the distinct hosted key and uploads the persisted canonical body to the closed swarm route", async () => {
    const exported = await writeHostedKey(exportFixture());
    const requests: Array<{ url: string; body: string; swarmKey?: string }> = [];
    const server = await startServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => {
        requests.push({
          url: req.url ?? "",
          body,
          swarmKey: typeof req.headers["x-martin-swarm-transport-key"] === "string"
            ? req.headers["x-martin-swarm-transport-key"]
            : undefined,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = server.url;

    try {
      await enqueueSwarmForHostedSync(exported);
      const result = await flushSyncQueue();

      expect(result).toMatchObject({ ok: true, uploaded: 1, pending: 0 });
      expect(requests.map((request) => request.url)).toEqual([
        "/register-swarm-transport-key",
        "/api/swarms/sync",
      ]);
      expect(requests[0]).toMatchObject({
        swarmKey: hostedSecret("receipt-secret-sentinel", exported.envelope.swarm.swarmId),
      });
      expect(requests[0]!.body).not.toContain("receipt-secret-sentinel");
      expect(requests[1]!.body).toBe(exported.canonicalBody);
      expect(await queueFiles()).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("preserves exact canonical bytes across a transient retry and quarantines byte tampering before fetch", async () => {
    const exported = await writeHostedKey(exportFixture());
    const seenBodies: string[] = [];
    let fail = true;
    const server = await startServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => {
        if (req.url === "/api/swarms/sync") seenBodies.push(body);
        if (req.url === "/api/swarms/sync" && fail) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "temporary" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = server.url;

    try {
      await enqueueSwarmForHostedSync(exported);
      expect((await flushSyncQueue()).ok).toBe(false);
      const [file] = await queueFiles();
      const path = join(queueDir, file!);
      const queued = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      queued["nextRetryNotBefore"] = new Date(Date.now() - 1_000).toISOString();
      await writeFile(path, JSON.stringify(queued), "utf8");
      fail = false;
      expect((await flushSyncQueue()).ok).toBe(true);
      expect(seenBodies).toEqual([exported.canonicalBody, exported.canonicalBody]);

      await enqueueSwarmForHostedSync(exported);
      const [tamperedFile] = await queueFiles();
      const tamperedPath = join(queueDir, tamperedFile!);
      const tampered = JSON.parse(await readFile(tamperedPath, "utf8")) as Record<string, unknown>;
      tampered["canonicalBody"] = `${String(tampered["canonicalBody"])}tampered`;
      await writeFile(tamperedPath, JSON.stringify(tampered), "utf8");
      const before = seenBodies.length;
      const result = await flushSyncQueue();
      expect(result.quarantined).toBe(1);
      expect(seenBodies).toHaveLength(before);
    } finally {
      await server.close();
    }
  });

  it("quarantines a consistently rehashed persisted swarm above 256 KiB before registration or upload", async () => {
    const exported = await writeHostedKey(exportFixture());
    await enqueueSwarmForHostedSync(exported);
    const [file] = await queueFiles();
    const path = join(queueDir, file!);
    const queued = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const envelope = JSON.parse(String(queued["canonicalBody"])) as Record<string, unknown>;
    envelope["padding"] = "x".repeat(256 * 1_024);
    const canonicalBody = `${JSON.stringify(envelope)}\n`;
    queued["canonicalBody"] = canonicalBody;
    queued["payloadSha256"] = sha256(canonicalBody);
    queued["payloadBytes"] = Buffer.byteLength(canonicalBody, "utf8");
    await writeFile(path, JSON.stringify(queued), "utf8");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await flushSyncQueue();

    expect(result).toMatchObject({ uploaded: 0, quarantined: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps durable same-swarm identity across an actual claim transition and recovers orphaned admission state", async () => {
    const exported = await writeHostedKey(exportFixture());
    const identical = await Promise.all([
      enqueueSwarmForHostedSync(exported),
      enqueueSwarmForHostedSync(exported),
    ]);
    expect(identical.sort()).toEqual(["duplicate", "queued"]);
    expect(await queueFiles()).toHaveLength(1);

    const admissionRoot = join(queueDir, ".swarm-admission");
    const admissionFile = join(admissionRoot, `${sha256(exported.envelope.swarm.swarmId)}.json`);
    await expect(readFile(admissionFile, "utf8")).resolves.toContain(exported.envelopeIdentity);
    const stale = new Date(Date.now() - 10 * 60 * 1_000);
    await utimes(admissionFile, stale, stale);

    const inClaimTransition = deferred<void>();
    const releaseClaimTransition = deferred<void>();
    setSwarmClaimTransitionHookForTests(async () => {
      inClaimTransition.resolve();
      await releaseClaimTransition.promise;
    });
    const claimed = deferred<void>();
    const releaseUpload = deferred<void>();
    const server = await startServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (req.url === "/register-swarm-transport-key") {
          claimed.resolve();
          void releaseUpload.promise.then(() => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          });
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = server.url;
    try {
      const flushing = flushSyncQueue();
      await inClaimTransition.promise;
      expect(await queueFiles()).toHaveLength(0);
      const duplicate = enqueueSwarmForHostedSync(exported);
      const conflictAssertion = expect(enqueueSwarmForHostedSync(mutatedExport(exported)))
        .rejects.toMatchObject({ code: "SWARM_SYNC_CONFLICT" });
      releaseClaimTransition.resolve();
      await claimed.promise;
      await expect(duplicate).resolves.toBe("duplicate");
      await conflictAssertion;
      expect((await readdir(admissionRoot)).filter((name) => name.endsWith(".json"))).toEqual([
        `${sha256(exported.envelope.swarm.swarmId)}.json`,
      ]);
      releaseUpload.resolve();
      await expect(flushing).resolves.toMatchObject({ ok: true, uploaded: 1 });
      await expect(readFile(admissionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseClaimTransition.resolve();
      releaseUpload.resolve();
      await server.close();
    }

    const staleLock = join(admissionRoot, `${sha256(exported.envelope.swarm.swarmId)}.lock`);
    await mkdir(staleLock, { recursive: true });
    await writeFile(join(staleLock, "owner"), "crashed-owner\n", "utf8");
    await utimes(staleLock, stale, stale);
    await expect(enqueueSwarmForHostedSync(exported)).resolves.toBe("queued");
    expect(await readdir(admissionRoot)).not.toContain(`${sha256(exported.envelope.swarm.swarmId)}.lock`);

    await rm(join(queueDir, (await queueFiles())[0]!), { force: true });
    await utimes(admissionFile, stale, stale);
    await expect(enqueueSwarmForHostedSync(exported)).resolves.toBe("queued");
    const recovered = JSON.parse(await readFile(admissionFile, "utf8")) as { envelopeIdentity: string };
    expect(recovered.envelopeIdentity).toBe(exported.envelopeIdentity);
  });

  it("keeps the live replacement admission index when an old recovered owner finishes successfully", async () => {
    const exported = await writeHostedKey(exportFixture());
    await enqueueSwarmForHostedSync(exported);
    const admissionFile = join(
      queueDir,
      ".swarm-admission",
      `${sha256(exported.envelope.swarm.swarmId)}.json`,
    );
    const registrations: ServerResponse[] = [];
    let notifyRegistration: (() => void) | undefined;
    const registrationArrived = () => new Promise<void>((resolve) => { notifyRegistration = resolve; });
    let nextRegistration = registrationArrived();
    const server = await startServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (req.url === "/register-swarm-transport-key") {
          registrations.push(res);
          notifyRegistration?.();
          nextRegistration = registrationArrived();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = server.url;

    try {
      const oldOwnerFlush = flushSyncQueue();
      await nextRegistration;
      const inflightRoot = join(queueDir, ".inflight");
      const [oldClaim] = (await readdir(inflightRoot)).filter((name) => name.endsWith(".claim"));
      expect(oldClaim).toBeDefined();
      const stale = new Date(Date.now() - 6 * 60 * 1_000);
      await utimes(join(inflightRoot, oldClaim!), stale, stale);
      await utimes(admissionFile, stale, stale);

      let notifyOldOwnerIdentityResolved!: () => void;
      const oldOwnerIdentityResolved = new Promise<void>((resolve) => {
        notifyOldOwnerIdentityResolved = resolve;
      });
      let releaseOldOwner!: () => void;
      const holdOldOwner = new Promise<void>((resolve) => { releaseOldOwner = resolve; });
      let firstRelease = true;
      setSwarmReleaseIdentityResolvedHookForTests(async () => {
        if (!firstRelease) return;
        firstRelease = false;
        notifyOldOwnerIdentityResolved();
        await holdOldOwner;
      });

      registrations[0]!.writeHead(200, { "Content-Type": "application/json" });
      registrations[0]!.end(JSON.stringify({ ok: true }));
      await oldOwnerIdentityResolved;

      const replacementFlush = flushSyncQueue();
      await nextRegistration;
      expect(registrations).toHaveLength(2);

      releaseOldOwner();
      await oldOwnerFlush;

      await expect(readFile(admissionFile, "utf8")).resolves.toContain(exported.envelopeIdentity);
      await expect(enqueueSwarmForHostedSync(exported)).resolves.toBe("duplicate");
      await expect(enqueueSwarmForHostedSync(mutatedExport(exported))).rejects.toMatchObject({
        code: "SWARM_SYNC_CONFLICT",
      });

      registrations[1]!.writeHead(200, { "Content-Type": "application/json" });
      registrations[1]!.end(JSON.stringify({ ok: true }));
      await replacementFlush;
      await expect(readFile(admissionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      for (const response of registrations) {
        if (!response.writableEnded) response.end();
      }
      await server.close();
    }
  }, 15_000);

  it("keeps the unchanged 256 KiB cap and reports the exact production-exported 15-agent envelope size", async () => {
    const exported = await buildProductionExport(root, integrityRoot, 15);
    const bytes = Buffer.byteLength(exported.canonicalBody, "utf8");

    expect(bytes).toBe(19_386);
    expect(bytes).toBeLessThanOrEqual(256 * 1_024);
    expect(exported.envelope.topology.agents).toHaveLength(15);
    await expect(enqueueSwarmForHostedSync(exported)).resolves.toBe("queued");
    const [file] = await queueFiles();
    const queued = JSON.parse(await readFile(join(queueDir, file!), "utf8")) as { payloadBytes: number };
    expect(queued.payloadBytes).toBe(bytes);
  }, 120_000);

  it("keeps an explicit run discriminator on the legacy route without changing its body", async () => {
    const payload = { loopId: "loop-explicit-run", task: { title: "t", objective: "o" }, events: [] };
    const item = {
      resourceKind: "run",
      queueId: "10000000-0000-4000-8000-000000000001",
      loopId: payload.loopId,
      payload,
      enqueuedAt: "2026-10-03T12:00:00.000Z",
      attempts: 0,
      payloadBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
    };
    await mkdir(queueDir, { recursive: true });
    await writeFile(join(queueDir, `${item.queueId}.json`), JSON.stringify(item), "utf8");
    const requests: Array<{ url: string; body: string }> = [];
    const server = await startServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => {
        requests.push({ url: req.url ?? "", body });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = server.url;
    try {
      expect((await flushSyncQueue()).ok).toBe(true);
      expect(requests).toEqual([{ url: "/api/runs/sync", body: JSON.stringify(payload) }]);
    } finally {
      await server.close();
    }
  });

  async function writeHostedKey(exported: BuiltSwarmHostedEnvelope): Promise<BuiltSwarmHostedEnvelope> {
    const rootHash = sha256(runsRoot).slice(0, 16);
    const keyDir = join(integrityRoot, rootHash);
    await mkdir(keyDir, { recursive: true });
    await writeFile(join(keyDir, `swarm-${exported.envelope.swarm.swarmId}.key`), "receipt-secret-sentinel\n", "utf8");
    return exported;
  }

  async function queueFiles(): Promise<string[]> {
    return (await readdir(queueDir).catch(() => [])).filter((name) => name.endsWith(".json"));
  }
});

function exportFixture(agentCount = 1): BuiltSwarmHostedEnvelope {
  const derivedSecret = hostedSecret("receipt-secret-sentinel", "swarm-sync-1");
  const agents = Array.from({ length: agentCount }, (_, index) => ({
    agentId: `agent-${index + 1}`,
    role: "worker",
    status: "verified" as const,
    taskIds: [`task-${index + 1}`],
    childRunId: `child-${index + 1}`,
  }));
  const tasks = agents.map((agent, index) => ({
    taskId: `task-${index + 1}`,
    required: true,
    dependsOn: index === 0 ? [] : [`task-${index}`],
    plannedAgentId: agent.agentId,
    effectiveAgentId: agent.agentId,
    status: "accepted" as const,
  }));
  const children = agents.map((agent, index) => ({
    childRunId: agent.childRunId,
    agentId: agent.agentId,
    attemptId: `attempt-${index + 1}`,
    taskIds: agent.taskIds,
    status: "verified" as const,
    receiptIntegrityState: "verified" as const,
    evidence: [{ eventId: `event-${index + 1}`, sequence: index + 1 }],
  }));
  const events = agents.map((agent, index) => ({
    eventId: `event-${index + 1}`,
    sourceIdempotencyKey: `event-${index + 1}`,
    sequence: index + 1,
    type: "CHILD_VERIFIED" as const,
    timestamp: `2026-10-03T12:00:${String(index).padStart(2, "0")}.000Z`,
    taskId: `task-${index + 1}`,
    agentId: agent.agentId,
    childRunId: agent.childRunId,
    attemptId: `attempt-${index + 1}`,
  }));
  events.push({
    eventId: "event-global",
    sourceIdempotencyKey: "event-global",
    sequence: agentCount + 1,
    type: "GLOBAL_VERIFIER_PASSED",
    timestamp: "2026-10-03T12:01:00.000Z",
    verificationId: "verification-1",
  } as never);
  events.push({
    eventId: "event-parent",
    sourceIdempotencyKey: "event-parent",
    sequence: agentCount + 2,
    type: "SWARM_VERIFIED",
    timestamp: "2026-10-03T12:01:01.000Z",
  } as never);
  const envelope = {
    schemaVersion: "martin.swarm-hosted.v1",
    envelopeId: "e".repeat(64),
    sourceSchemas: { swarm: "martin.swarm.v1", receipt: "martin.swarm-receipt.v1", evidenceIndex: "martin.swarm-evidence-index.v1" },
    sourceIdentities: { receiptId: "receipt-1", receiptSha256: "1".repeat(64), evidenceIndexSha256: "2".repeat(64), eventChainSha256: "3".repeat(64) },
    runtimeVersion: "0.8.0",
    createdAt: "2026-10-03T12:01:02.000Z",
    swarm: { swarmId: "swarm-sync-1", workspaceId: "workspace-1", projectId: "project-1", planHash: "a".repeat(64), baselineCommit: "b".repeat(40) },
    topology: { tasks, agents, children },
    budget: { capUsd: 10, capTokens: 100_000, settledUsd: 1, settledTokens: 5_000 },
    interventions: { blockedActions: [], reassignments: [] },
    integration: { admissions: [], rejections: [], conflicts: [], integratedTreeHash: "c".repeat(40) },
    events,
    globalVerification: { state: "passed", verificationId: "verification-1", integratedTreeHash: "c".repeat(40), evidence: [{ eventId: "event-global", sequence: agentCount + 1 }] },
    parentOutcome: { state: "verified", source: "sealed_parent_receipt", evidence: [{ eventId: "event-parent", sequence: agentCount + 2 }] },
    taskVerificationState: "passed",
    receiptIntegrityState: "verified",
    transportSignature: {
      algorithm: "hmac-sha256",
      keyId: `hosted-${sha256(derivedSecret).slice(0, 16)}`,
      keyLocatorHash: sha256(`martin.swarm-hosted.v1\nswarm-sync-1\nhosted-${sha256(derivedSecret).slice(0, 16)}\n`),
      signatureHmacSha256: "f".repeat(64),
    },
  } as BuiltSwarmHostedEnvelope["envelope"];
  const canonicalBody = `${JSON.stringify(envelope)}\n`;
  return {
    envelope,
    canonicalBody,
    payloadSha256: sha256(canonicalBody),
    envelopeIdentity: envelope.envelopeId,
    transportKey: {
      keyId: envelope.transportSignature.keyId,
      keyLocatorHash: envelope.transportSignature.keyLocatorHash,
      domain: "martin.swarm-hosted.v1",
    },
  };
}

function mutatedExport(exported: BuiltSwarmHostedEnvelope): BuiltSwarmHostedEnvelope {
  const envelope = { ...exported.envelope, runtimeVersion: `${exported.envelope.runtimeVersion}-conflict` };
  const canonicalBody = `${JSON.stringify(envelope)}\n`;
  return {
    ...exported,
    envelope,
    canonicalBody,
    payloadSha256: sha256(canonicalBody),
  };
}

async function buildProductionExport(
  root: string,
  integrityRoot: string,
  agentCount: number,
): Promise<BuiltSwarmHostedEnvelope> {
  const canonicalRoot = join(root, "production-repo");
  const productionRunsRoot = join(root, "production-runs");
  await mkdir(canonicalRoot, { recursive: true });
  await mkdir(productionRunsRoot, { recursive: true });
  await git(canonicalRoot, ["init"]);
  await git(canonicalRoot, ["config", "user.email", "swarm-sync@example.invalid"]);
  await git(canonicalRoot, ["config", "user.name", "Swarm Sync"]);
  await writeFile(join(canonicalRoot, "README.md"), "production hosted sync fixture\n", "utf8");
  await git(canonicalRoot, ["add", "README.md"]);
  await git(canonicalRoot, ["commit", "-m", "fixture"]);
  const baselineCommit = (await git(canonicalRoot, ["rev-parse", "HEAD"])).trim();
  const tasks = Array.from({ length: agentCount }, (_, index) => ({
    taskId: `task-${index + 1}`,
    title: `Task ${index + 1}`,
    objective: `Complete task ${index + 1}`,
    required: true,
    dependsOn: index === 0 ? [] : [`task-${index}`],
    assignedAgentId: `agent-${index + 1}`,
    status: "queued" as const,
    mutationMode: "read_only" as const,
    writeScope: [],
  }));
  const agents = tasks.map((task, index) => ({
    agentId: task.assignedAgentId,
    role: "worker",
    status: "queued" as const,
    contract: {
      agentId: task.assignedAgentId,
      taskIds: [task.taskId],
      scope: { allowedPaths: ["src/**"], deniedPaths: [".git/**"] },
      budget: { maxUsd: 1, softLimitUsd: 1, maxIterations: 1, maxTokens: 100 },
      maxWallClockMs: 60_000,
      permissions: { networkDomains: [], commands: ["echo verify"] },
      approvalPolicy: {},
      verifierAuthority: "child_only" as const,
    },
  }));
  const plan = createSwarmLivePlan({
    planId: "plan-production-sync",
    swarmId: "swarm-production-sync",
    workspaceId: "workspace-production-sync",
    projectId: "project-production-sync",
    baselineCommit,
    parentContract: {
      policyVersion: "swarm-policy-v1",
      objective: "Prove a production 15-agent hosted envelope",
      definitionOfDone: ["All required tasks accepted"],
      budget: { maxUsd: 20, softLimitUsd: 18, maxIterations: 20, maxTokens: 10_000 },
      maxWallClockMs: 120_000,
      maxConcurrency: agentCount,
      scope: { allowedPaths: ["src/**"], deniedPaths: [".git/**"] },
      permissions: { networkDomains: [], commands: ["echo verify"] },
      integrationStrategy: "parent_fan_in",
      globalVerifierStack: [{ command: "echo verify", type: "custom" }],
      stopPolicy: { budgetExhausted: "stop", blockingFailure: "needs_review", verifierFailure: "stop" },
      recoveryPolicy: { maxReassignmentsPerTask: 0, dependencyWaiversAllowed: false },
      approvalPolicy: {},
      orchestrationStrategy: "hierarchical_dag",
    },
    tasks,
    agents,
    engine: { engine: "codex", model: "gpt-test" },
    childMaxIterations: 1,
    createdAt: "2026-10-03T12:00:00.000Z",
  });
  process.env["MARTIN_INTEGRITY_KEY_DIR"] = integrityRoot;
  const run = await runProductionLiveSwarm({
    plan,
    canonicalRoot,
    ownedRoot: join(productionRunsRoot, "_swarms", plan.swarmId, "worktrees"),
    storeRoot: productionRunsRoot,
    runsRoot: productionRunsRoot,
    adapterFactory: () => ({
      adapterId: "codex:gpt-test",
      kind: "agent-cli",
      label: "production sync fixture",
      metadata: { providerId: "codex", model: "gpt-test", capabilities: { workspaceMutations: false } },
      async execute(request: any) {
        return {
          status: "completed" as const,
          summary: "done",
          usage: { actualUsd: 0.01, tokensIn: 2, tokensOut: 3 },
          verification: {
            passed: true,
            summary: "pass",
            binding: {
              runId: request.loopId,

              attemptId: request.attemptId,

              ...(request.context.runsRoot ? { runsRoot: request.context.runsRoot } : {}),

              ...(request.context.executionProfile ? { executionProfile: request.context.executionProfile } : {}),

              ...(request.context.allowedNetworkDomains?.length ? { allowedNetworkDomains: request.context.allowedNetworkDomains } : {}),
              workspaceId: request.workspaceId,
              cwd: request.context.repoRoot,
              commands: request.context.verificationPlan,
            },
            steps: [{ command: "echo verify", launched: true, completed: true, crashed: false, exitCode: 0, timedOut: false }],
          },
        };
      },
    }),
    verifierExecutor: {
      async execute(request: any) {
        return {
          passed: true,
          processCloseState: "closed" as const,
          binding: {
            swarmId: request.swarmId,
            workspaceId: request.workspaceId,
            cwd: request.cwd,
            parentPolicyVersion: request.parentPolicyVersion,
            baselineCommit: request.baselineCommit,
            integratedTreeHash: request.integratedTreeHash,
            commands: request.commands.map((step: any) => step.command),
          },
          subprocessResults: request.commands.map((step: any) => ({
            command: step.command,
            launched: true,
            completed: true,
            timedOut: false,
            exitCode: 0,
            startedAt: "2026-10-03T12:01:00.000Z",
            completedAt: "2026-10-03T12:01:01.000Z",
          })),
        };
      },
    },
  });
  expect(run.outcome.state).toBe("verified");
  return buildSwarmHostedEnvelope({
    runsRoot: productionRunsRoot,
    swarmId: plan.swarmId,
    runtimeVersion: "0.8.0",
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 8 * 1_024 * 1_024 });
  return result.stdout;
}

async function hashTree(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(path, relative);
      else if (entry.isFile()) {
        hashes[relative] = createHash("sha256").update(await readFile(path)).digest("hex");
      }
    }
  };
  await visit(root, "");
  return hashes;
}

function hostedSecret(receiptSecret: string, swarmId: string): string {
  return createHmac("sha256", receiptSecret)
    .update(`martin.swarm-hosted.v1\n${swarmId}\n`)
    .digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
