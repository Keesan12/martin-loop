/**
 * sync-client.test.ts — real HTTP server tests for the sync queue and upload logic.
 *
 * Uses Node's http.createServer — no fetch mocking.
 * Each test gets an isolated temp dir via MARTIN_SYNC_QUEUE_DIR.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  attemptUpload,
  enqueueLoopForHostedSync,
  flushSyncQueue,
  queueFileName,
  syncLoopToHosted,
  syncQueueStatus,
} from "../src/sync-client.js";
import { parseCliArguments } from "../src/index.js";
import type { LoopRecord } from "@martin/contracts";

// ---------------------------------------------------------------------------
// Types (mirrors unexported SyncQueueItem for test helpers)
// ---------------------------------------------------------------------------

interface TestItem {
  queueId: string;
  loopId: string;
  payload: {
    loopId: string;
    workspaceId?: string;
    projectId?: string;
    task: { title: string; objective: string };
    status?: string;
    budget?: { spentUsd?: number; avoidedUsd?: number };
    events: unknown[];
    syncedAt?: string;
  };
  enqueuedAt: string;
  attempts: number;
  lastAttemptAt?: string;
  nextRetryNotBefore?: string;
  payloadBytes: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLoop(overrides: Partial<LoopRecord> = {}): LoopRecord {
  return {
    loopId: `loop-${randomUUID()}`,
    workspaceId: "ws-test",
    projectId: "proj-test",
    status: "completed",
    lifecycleState: "completed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    task: { title: "Test task", objective: "Run the tests", verificationPlan: [] },
    attempts: [],
    events: [],
    artifacts: [],
    budget: { maxIterations: 5, maxUsd: 1, maxTokens: 10000, softLimitUsd: 0.5 },
    cost: { actualUsd: 0.01, avoidedUsd: 0, tokensIn: 100, tokensOut: 50 },
    receiptIntegrity: undefined,
    receiptScope: undefined,
    ...overrides,
  } as unknown as LoopRecord;
}

function makeItem(overrides: Partial<TestItem> = {}): TestItem {
  const loopId = `loop-${randomUUID()}`;
  return {
    queueId: randomUUID(),
    loopId,
    payload: {
      loopId,
      workspaceId: "ws-test",
      task: { title: "Test task", objective: "Run tests" },
      status: "completed",
      events: [
        {
          eventId: `evt_run_synced_${loopId}`,
          eventType: "run.synced",
          occurredAt: new Date().toISOString(),
          sequence: 0,
        },
      ],
      syncedAt: new Date().toISOString(),
    },
    enqueuedAt: new Date().toISOString(),
    attempts: 0,
    payloadBytes: 100,
    ...overrides,
  };
}

type ServerHandler = (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
) => void;

function startServer(handler: ServerHandler): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") { reject(new Error("no addr")); return; }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((res, rej) => server.close((e) => e ? rej(e) : res())),
      });
    });
  });
}

/** Pre-populate queue with n valid items to test cap behavior. */
async function fillQueue(dir: string, n: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  const base = Date.now();
  await Promise.all(
    Array.from({ length: n }, (_, i) => {
      const item = makeItem({
        enqueuedAt: new Date(base + i).toISOString(),
        loopId: `loop-fill-${i}`,
      });
      return writeFile(join(dir, `${item.queueId}.json`), JSON.stringify(item), "utf8");
    })
  );
}

/** Set a file's mtime to msAgo milliseconds in the past. */
async function setMtimeAgo(filePath: string, msAgo: number): Promise<void> {
  const pastDate = new Date(Date.now() - msAgo);
  await utimes(filePath, pastDate, pastDate);
}

// ---------------------------------------------------------------------------
// Per-test isolation
// ---------------------------------------------------------------------------

let tempDir: string;

function qDir(): string { return join(tempDir, "q"); }
function quarDir(): string { return join(qDir(), ".quarantine"); }
function inflightDir(): string { return join(qDir(), ".inflight"); }

async function queueFiles(): Promise<string[]> {
  try { return (await readdir(qDir())).filter((f) => f.endsWith(".json")).sort(); }
  catch { return []; }
}
async function quarantineFiles(): Promise<string[]> {
  try { return (await readdir(quarDir())).filter((f) => f.endsWith(".json")).sort(); }
  catch { return []; }
}
async function inflightFiles(): Promise<string[]> {
  try { return (await readdir(inflightDir())).filter((f) => f.endsWith(".json")).sort(); }
  catch { return []; }
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sync-test-"));
  process.env["MARTIN_SYNC_QUEUE_DIR"] = qDir();
  delete process.env["MARTIN_TELEMETRY_ENDPOINT"];
  delete process.env["MARTIN_API_TOKEN"];
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env["MARTIN_SYNC_QUEUE_DIR"];
  delete process.env["MARTIN_TELEMETRY_ENDPOINT"];
  delete process.env["MARTIN_API_TOKEN"];
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// queueFileName: cross-platform path extraction
// ---------------------------------------------------------------------------

describe("queueFileName", () => {
  it("extracts filename from POSIX path", () => {
    expect(queueFileName("/tmp/sync-test/q/.inflight/abc-123.json")).toBe("abc-123.json");
  });

  it("extracts filename from Windows-style backslash path", () => {
    expect(queueFileName("C:\\Users\\foo\\.martin\\runs\\.sync-queue\\.inflight\\abc-123.json")).toBe("abc-123.json");
  });

  it("extracts filename from mixed separators", () => {
    expect(queueFileName("/home/user\\.martin/runs/.sync-queue/.inflight\\abc-123.json")).toBe("abc-123.json");
  });

  it("returns fallback for empty string", () => {
    const result = queueFileName("");
    expect(result).toMatch(/^unknown-\d+\.json$/);
  });
});

// ---------------------------------------------------------------------------
// Opt-in: no env vars => silent no-op
// ---------------------------------------------------------------------------

describe("opt-in behavior", () => {
  it("is a no-op when MARTIN_TELEMETRY_ENDPOINT not set", async () => {
    const loop = makeLoop();
    await syncLoopToHosted(loop, { runtimeVersion: "0.1.0" });
    expect(await queueFiles()).toHaveLength(0);
  });

  it("is a no-op when MARTIN_API_TOKEN not set", async () => {
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = "http://127.0.0.1:1";
    const loop = makeLoop();
    await syncLoopToHosted(loop, { runtimeVersion: "0.1.0" });
    expect(await queueFiles()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Payload size guard
// ---------------------------------------------------------------------------

describe("payload size guard", () => {
  it("does not queue a payload larger than 256KB", async () => {
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = "http://127.0.0.1:1";
    process.env["MARTIN_API_TOKEN"] = "tok";
    // Build a task string that pushes the payload over 256KB
    const bigTask = "x".repeat(300 * 1024);
    const loop = makeLoop({ task: { title: bigTask, objective: bigTask, verificationPlan: [] } as never });
    const errLines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s) => { errLines.push(String(s)); return true; });
    await syncLoopToHosted(loop, { runtimeVersion: "0.1.0" });
    expect(await queueFiles()).toHaveLength(0);
    expect(errLines.join("")).toContain("too large");
  });
});

// ---------------------------------------------------------------------------
// attemptUpload: HTTP status handling
// ---------------------------------------------------------------------------

describe("attemptUpload — HTTP status codes", () => {
  const minItem = () => makeItem() as unknown as Parameters<typeof attemptUpload>[0];

  it("returns ok:true on 200", async () => {
    const { url, close } = await startServer((_req, res) => { res.writeHead(200); res.end("{}"); });
    expect((await attemptUpload(minItem(), url, "tok")).ok).toBe(true);
    await close();
  });

  it("treats duplicate 200 as success", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200); res.end(JSON.stringify({ ok: true, duplicate: true }));
    });
    expect((await attemptUpload(minItem(), url, "tok")).ok).toBe(true);
    await close();
  });

  it("returns permanent:true on 400", async () => {
    const { url, close } = await startServer((_req, res) => { res.writeHead(400); res.end(); });
    const r = await attemptUpload(minItem(), url, "tok");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.permanent).toBe(true);
    await close();
  });

  it("returns permanent:true on 401", async () => {
    const { url, close } = await startServer((_req, res) => { res.writeHead(401); res.end(); });
    const r = await attemptUpload(minItem(), url, "tok");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.permanent).toBe(true);
    await close();
  });

  it("returns permanent:true on 403", async () => {
    const { url, close } = await startServer((_req, res) => { res.writeHead(403); res.end(); });
    const r = await attemptUpload(minItem(), url, "tok");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.permanent).toBe(true);
    await close();
  });

  it("returns permanent:false (transient) on 429 with Retry-After", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(429, { "Retry-After": "2" }); res.end();
    });
    const r = await attemptUpload(minItem(), url, "tok");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.permanent).toBe(false);
      expect((r as { retryAfterMs?: number }).retryAfterMs).toBe(2000);
    }
    await close();
  });

  it("returns permanent:false (transient) on 500", async () => {
    const { url, close } = await startServer((_req, res) => { res.writeHead(500); res.end(); });
    const r = await attemptUpload(minItem(), url, "tok");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.permanent).toBe(false);
    await close();
  });

  it("returns permanent:false on network error (unreachable port)", async () => {
    const r = await attemptUpload(minItem(), "http://127.0.0.1:1", "tok");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.permanent).toBe(false);
  });

  it("returns permanent:false when server closes connection (ECONNRESET)", async () => {
    const { url, close } = await startServer((_req, res) => { res.destroy(); });
    const r = await attemptUpload(minItem(), url, "tok");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.permanent).toBe(false);
    await close();
  });

  it("sends Authorization header and does NOT send Idempotency-Key header", async () => {
    let auth = "", hasIdemKey = false;
    const { url, close } = await startServer((req, res) => {
      auth = req.headers["authorization"] ?? "";
      hasIdemKey = "idempotency-key" in req.headers;
      res.writeHead(202); res.end("{}");
    });
    await attemptUpload(minItem(), url, "my-secret-token");
    expect(auth).toBe("Bearer my-secret-token");
    expect(hasIdemKey).toBe(false);
    await close();
  });

  it("sends to /api/runs/sync path", async () => {
    let receivedPath = "";
    const { url, close } = await startServer((req, res) => {
      receivedPath = req.url ?? "";
      res.writeHead(202); res.end("{}");
    });
    await attemptUpload(minItem(), url, "tok");
    expect(receivedPath).toBe("/api/runs/sync");
    await close();
  });

  it("returns ok:true on 202 (CP canonical success)", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(202); res.end(JSON.stringify({ ok: true, acceptedEvents: 1, replayedEvents: 0 }));
    });
    expect((await attemptUpload(minItem(), url, "tok")).ok).toBe(true);
    await close();
  });

  it("returns ok:true when replayedEvents>0 and acceptedEvents===0 (idempotency success)", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(202); res.end(JSON.stringify({ ok: true, acceptedEvents: 0, replayedEvents: 3 }));
    });
    expect((await attemptUpload(minItem(), url, "tok")).ok).toBe(true);
    await close();
  });

  it("returns permanent:true on 409 (backdated syncedAt — do not retry)", async () => {
    const { url, close } = await startServer((_req, res) => { res.writeHead(409); res.end(); });
    const r = await attemptUpload(minItem(), url, "tok");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.permanent).toBe(true);
    await close();
  });
});

// ---------------------------------------------------------------------------
// Retry-After parsing edge cases
// ---------------------------------------------------------------------------

describe("attemptUpload — Retry-After parsing", () => {
  const minItem = () => makeItem() as unknown as Parameters<typeof attemptUpload>[0];

  it("clamps huge Retry-After to 30s cap", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(429, { "Retry-After": "999999" }); res.end();
    });
    const r = await attemptUpload(minItem(), url, "tok");
    if (!r.ok) expect((r as { retryAfterMs?: number }).retryAfterMs).toBe(30_000);
    await close();
  });

  it("falls back to undefined for malformed Retry-After string", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(429, { "Retry-After": "not-a-date-or-number" }); res.end();
    });
    const r = await attemptUpload(minItem(), url, "tok");
    if (!r.ok) expect((r as { retryAfterMs?: number }).retryAfterMs).toBeUndefined();
    await close();
  });

  it("falls back to undefined for negative Retry-After", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(429, { "Retry-After": "-5" }); res.end();
    });
    const r = await attemptUpload(minItem(), url, "tok");
    if (!r.ok) expect((r as { retryAfterMs?: number }).retryAfterMs).toBeUndefined();
    await close();
  });

  it("enforces 1s minimum for very small Retry-After", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(429, { "Retry-After": "0.0001" }); res.end();
    });
    const r = await attemptUpload(minItem(), url, "tok");
    if (!r.ok) expect((r as { retryAfterMs?: number }).retryAfterMs).toBe(1_000);
    await close();
  });
});


// ---------------------------------------------------------------------------
// syncLoopToHosted: queue + upload flow
// ---------------------------------------------------------------------------

describe("syncLoopToHosted", () => {
  it("enqueues and dequeues on success (200)", async () => {
    const { url, close } = await startServer((_req, res) => { res.writeHead(200); res.end("{}"); });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;
    process.env["MARTIN_API_TOKEN"] = "tok";
    await syncLoopToHosted(makeLoop(), { runtimeVersion: "0.1.0" });
    expect(await queueFiles()).toHaveLength(0);
    await close();
  });

  it("dequeues on duplicate 200", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200); res.end(JSON.stringify({ ok: true, duplicate: true }));
    });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;
    process.env["MARTIN_API_TOKEN"] = "tok";
    await syncLoopToHosted(makeLoop(), { runtimeVersion: "0.1.0" });
    expect(await queueFiles()).toHaveLength(0);
    await close();
  });

  it("leaves item in queue on transient failure (offline)", async () => {
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = "http://127.0.0.1:1";
    process.env["MARTIN_API_TOKEN"] = "tok";
    await syncLoopToHosted(makeLoop(), { runtimeVersion: "0.1.0" });
    expect(await queueFiles()).toHaveLength(1);
  });

  it("persists attempts:1 and nextRetryNotBefore after transient failure", async () => {
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = "http://127.0.0.1:1";
    process.env["MARTIN_API_TOKEN"] = "tok";
    const loop = makeLoop();
    await syncLoopToHosted(loop, { runtimeVersion: "0.1.0" });
    const files = await queueFiles();
    expect(files).toHaveLength(1);
    const saved = JSON.parse(await readFile(join(qDir(), files[0]!), "utf8"));
    expect(saved.attempts).toBe(1);
    expect(saved.nextRetryNotBefore).toBeTruthy();
    expect(saved.loopId).toBe(loop.loopId);
  });

  it("quarantines on permanent 401", async () => {
    const { url, close } = await startServer((_req, res) => { res.writeHead(401); res.end(); });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;
    process.env["MARTIN_API_TOKEN"] = "bad-tok";
    await syncLoopToHosted(makeLoop(), { runtimeVersion: "0.1.0" });
    expect(await queueFiles()).toHaveLength(0);
    expect(await quarantineFiles()).toHaveLength(1);
    await close();
  });

  it("quarantines on permanent 403", async () => {
    const { url, close } = await startServer((_req, res) => { res.writeHead(403); res.end(); });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;
    process.env["MARTIN_API_TOKEN"] = "tok";
    await syncLoopToHosted(makeLoop(), { runtimeVersion: "0.1.0" });
    expect(await queueFiles()).toHaveLength(0);
    expect(await quarantineFiles()).toHaveLength(1);
    await close();
  });

  it("never throws even when filesystem is broken (outer catch logs to stderr)", async () => {
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = "http://127.0.0.1:1";
    process.env["MARTIN_API_TOKEN"] = "tok";
    // Force MARTIN_SYNC_QUEUE_DIR to a path that cannot be created (file in the way)
    const blocker = join(tempDir, "blocker");
    await writeFile(blocker, "x", "utf8");
    process.env["MARTIN_SYNC_QUEUE_DIR"] = join(blocker, "q"); // parent is a file
    const errLines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s) => { errLines.push(String(s)); return true; });
    // Must not throw
    await expect(syncLoopToHosted(makeLoop(), { runtimeVersion: "0.1.0" })).resolves.toBeUndefined();
    // Must log the failure
    expect(errLines.join("")).toBeTruthy();
  });

  it("uploaded payload body contains loopId from the LoopRecord", async () => {
    let receivedBody: Record<string, unknown> = {};
    const { url, close } = await startServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try { receivedBody = JSON.parse(body) as Record<string, unknown>; } catch { /**/ }
        res.writeHead(202); res.end("{}");
      });
    });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;
    process.env["MARTIN_API_TOKEN"] = "tok";
    const loop = makeLoop({ loopId: "fixed-loop-id" });
    await syncLoopToHosted(loop, { runtimeVersion: "0.1.0" });
    expect(receivedBody["loopId"]).toBe("fixed-loop-id");
    await close();
  });
});

// ---------------------------------------------------------------------------
// A10 payload contract — HostedRunSyncDraft shape, event taxonomy, budget
// ---------------------------------------------------------------------------

describe("A10 payload contract", () => {
  it("payload contains loopId, task.title, task.objective, and events[]", async () => {
    let body: Record<string, unknown> = {};
    const { url, close } = await startServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /**/ }
        res.writeHead(202); res.end("{}");
      });
    });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;
    process.env["MARTIN_API_TOKEN"] = "tok";
    const loop = makeLoop({
      loopId: "loop-contract-test",
      task: { title: "Contract title", objective: "Contract objective", verificationPlan: [] } as never,
    });
    await syncLoopToHosted(loop, { runtimeVersion: "0.1.0" });
    expect(body["loopId"]).toBe("loop-contract-test");
    expect((body["task"] as Record<string, unknown>)["title"]).toBe("Contract title");
    expect((body["task"] as Record<string, unknown>)["objective"]).toBe("Contract objective");
    expect(Array.isArray(body["events"])).toBe(true);
    expect((body["events"] as unknown[]).length).toBeGreaterThanOrEqual(1);
    await close();
  });

  it("workspaceId is at the top level of the payload (not inside metadata)", async () => {
    let body: Record<string, unknown> = {};
    const { url, close } = await startServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /**/ }
        res.writeHead(202); res.end("{}");
      });
    });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;
    process.env["MARTIN_API_TOKEN"] = "tok";
    await syncLoopToHosted(makeLoop({ workspaceId: "ws-toplevel-check" }), { runtimeVersion: "0.1.0" });
    expect(body["workspaceId"]).toBe("ws-toplevel-check");
    expect(body["metadata"]).toBeUndefined();
    await close();
  });

  it("events[] always starts with run.synced at sequence 0", async () => {
    let events: unknown[] = [];
    const { url, close } = await startServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try { const b = JSON.parse(raw) as Record<string, unknown>; events = b["events"] as unknown[]; } catch { /**/ }
        res.writeHead(202); res.end("{}");
      });
    });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;
    process.env["MARTIN_API_TOKEN"] = "tok";
    await syncLoopToHosted(makeLoop(), { runtimeVersion: "0.1.0" });
    const first = events[0] as Record<string, unknown>;
    expect(first["eventType"]).toBe("run.synced");
    expect(first["sequence"]).toBe(0);
    expect(typeof first["eventId"]).toBe("string");
    expect(typeof first["occurredAt"]).toBe("string");
    await close();
  });

  it("attempt.completed event emitted for a successful attempt", async () => {
    let events: unknown[] = [];
    const { url, close } = await startServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try { const b = JSON.parse(raw) as Record<string, unknown>; events = b["events"] as unknown[]; } catch { /**/ }
        res.writeHead(202); res.end("{}");
      });
    });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;
    process.env["MARTIN_API_TOKEN"] = "tok";
    const loop = makeLoop({
      attempts: [
        {
          attemptId: "att-1",
          index: 0,
          adapterId: "claude",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          // no failureClass → completed
        },
      ] as never,
    });
    await syncLoopToHosted(loop, { runtimeVersion: "0.1.0" });
    const attempt = (events as Record<string, unknown>[]).find((e) => e["eventType"] === "attempt.completed");
    expect(attempt).toBeDefined();
    expect(attempt!["sequence"]).toBe(1);
    expect(attempt!["attemptId"]).toBe("att-1");
    await close();
  });

  it("attempt.failed event emitted for a failed attempt", async () => {
    let events: unknown[] = [];
    const { url, close } = await startServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try { const b = JSON.parse(raw) as Record<string, unknown>; events = b["events"] as unknown[]; } catch { /**/ }
        res.writeHead(202); res.end("{}");
      });
    });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;
    process.env["MARTIN_API_TOKEN"] = "tok";
    const loop = makeLoop({
      attempts: [
        {
          attemptId: "att-fail-1",
          index: 0,
          adapterId: "claude",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          failureClass: "max_iterations",
        },
      ] as never,
    });
    await syncLoopToHosted(loop, { runtimeVersion: "0.1.0" });
    const failed = (events as Record<string, unknown>[]).find((e) => e["eventType"] === "attempt.failed");
    expect(failed).toBeDefined();
    expect((failed!["payload"] as Record<string, unknown>)["failureClass"]).toBe("max_iterations");
    await close();
  });

  it("budget.spentUsd sent when actualUsd is available", async () => {
    let body: Record<string, unknown> = {};
    const { url, close } = await startServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /**/ }
        res.writeHead(202); res.end("{}");
      });
    });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;
    process.env["MARTIN_API_TOKEN"] = "tok";
    await syncLoopToHosted(
      makeLoop({ cost: { actualUsd: 0.042, avoidedUsd: 0, tokensIn: 100, tokensOut: 50 } as never }),
      { runtimeVersion: "0.1.0" }
    );
    expect(body["budget"]).toEqual({ spentUsd: 0.042, avoidedUsd: 0 });
    await close();
  });

  it("budget contains avoidedUsd only when actualUsd is unavailable", async () => {
    let body: Record<string, unknown> = {};
    const { url, close } = await startServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /**/ }
        res.writeHead(202); res.end("{}");
      });
    });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;
    process.env["MARTIN_API_TOKEN"] = "tok";
    await syncLoopToHosted(
      makeLoop({ cost: { estimatedUsd: 0.01, avoidedUsd: 0, tokensIn: 100, tokensOut: 50 } as never }),
      { runtimeVersion: "0.1.0" }
    );
    expect(body["budget"]).toEqual({ avoidedUsd: 0 });
    await close();
  });

  it("task title/objective fall back to '(untitled)' when both are falsy", async () => {
    let body: Record<string, unknown> = {};
    const { url, close } = await startServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /**/ }
        res.writeHead(202); res.end("{}");
      });
    });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;
    process.env["MARTIN_API_TOKEN"] = "tok";
    await syncLoopToHosted(
      makeLoop({ task: { title: "", objective: "", verificationPlan: [] } as never }),
      { runtimeVersion: "0.1.0" }
    );
    const task = body["task"] as Record<string, unknown>;
    expect(task["title"]).toBe("(untitled)");
    expect(task["objective"]).toBe("(untitled)");
    await close();
  });

  it("quarantines on 409 (backdated syncedAt — permanent, must not retry)", async () => {
    const { url, close } = await startServer((_req, res) => { res.writeHead(409); res.end(); });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;
    process.env["MARTIN_API_TOKEN"] = "tok";
    await syncLoopToHosted(makeLoop(), { runtimeVersion: "0.1.0" });
    expect(await queueFiles()).toHaveLength(0);
    expect(await quarantineFiles()).toHaveLength(1);
    await close();
  });

  it("syncedAt in queue payload is set at enqueue time and unchanged on flush retry", async () => {
    // 1. Enqueue via transient failure — syncedAt set at enqueue time
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = "http://127.0.0.1:1";
    process.env["MARTIN_API_TOKEN"] = "tok";
    const before = new Date().toISOString();
    await syncLoopToHosted(makeLoop(), { runtimeVersion: "0.1.0" });

    // 2. Capture syncedAt written at enqueue
    const filesAfterEnqueue = await queueFiles();
    expect(filesAfterEnqueue).toHaveLength(1);
    const afterEnqueue = JSON.parse(
      await readFile(join(qDir(), filesAfterEnqueue[0]!), "utf8")
    ) as { payload: { syncedAt?: string }; nextRetryNotBefore?: string };
    const syncedAtEnqueue = afterEnqueue.payload.syncedAt;
    expect(typeof syncedAtEnqueue).toBe("string");
    expect(syncedAtEnqueue! >= before).toBe(true);

    // 3. Bypass backoff so flush picks it up immediately
    const patched = { ...afterEnqueue, nextRetryNotBefore: new Date(Date.now() - 1000).toISOString(), attempts: 0 };
    await writeFile(join(qDir(), filesAfterEnqueue[0]!), JSON.stringify(patched), "utf8");

    // 4. Flush via 5xx (transient) — capture what was transmitted to the server
    let transmittedSyncedAt: string | undefined;
    const { url, close } = await startServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try { transmittedSyncedAt = (JSON.parse(raw) as { syncedAt?: string }).syncedAt; } catch { /**/ }
        res.writeHead(500); res.end();
      });
    });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;
    await flushSyncQueue();
    await close();

    // 5. syncedAt transmitted == enqueue-time value (not regenerated on retry)
    expect(transmittedSyncedAt).toBe(syncedAtEnqueue);

    // 6. persisted payload after flush also unchanged
    const filesAfterFlush = await queueFiles();
    expect(filesAfterFlush).toHaveLength(1);
    const afterFlush = JSON.parse(
      await readFile(join(qDir(), filesAfterFlush[0]!), "utf8")
    ) as { payload: { syncedAt?: string } };
    expect(afterFlush.payload.syncedAt).toBe(syncedAtEnqueue);
  });
});

// ---------------------------------------------------------------------------
// flushSyncQueue: retry, backoff, max attempts, quarantine
// ---------------------------------------------------------------------------

describe("flushSyncQueue", () => {
  it("reports empty when no files", async () => {
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = "http://127.0.0.1:1";
    process.env["MARTIN_API_TOKEN"] = "tok";
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => { out.push(String(s)); return true; });
    await flushSyncQueue();
    expect(out.join("")).toContain("empty");
  });

  it("requires env vars — reports missing and returns", async () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s) => { err.push(String(s)); return true; });
    await flushSyncQueue();
    expect(err.join("")).toContain("must be set");
  });

  it("uploads queued item and removes it on 200", async () => {
    // Write item directly — no prior upload attempt, so no backoff state
    await mkdir(qDir(), { recursive: true });
    const item = makeItem();
    await writeFile(join(qDir(), `${item.queueId}.json`), JSON.stringify(item), "utf8");
    expect(await queueFiles()).toHaveLength(1);

    const { url, close } = await startServer((_req, res) => { res.writeHead(200); res.end("{}"); });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;
    process.env["MARTIN_API_TOKEN"] = "tok";
    await flushSyncQueue();
    expect(await queueFiles()).toHaveLength(0);
    await close();
  });

  it("quarantines item on permanent 401 during flush", async () => {
    // Write item directly — no backoff state that would defer it
    await mkdir(qDir(), { recursive: true });
    const item = makeItem();
    await writeFile(join(qDir(), `${item.queueId}.json`), JSON.stringify(item), "utf8");
    expect(await queueFiles()).toHaveLength(1);

    const { url, close } = await startServer((_req, res) => { res.writeHead(401); res.end(); });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;
    process.env["MARTIN_API_TOKEN"] = "tok";
    await flushSyncQueue();
    expect(await queueFiles()).toHaveLength(0);
    expect(await quarantineFiles()).toHaveLength(1);
    await close();
  });

  it("increments attempts and sets backoff on 429 during flush", async () => {
    // Queue item with attempts:0, no backoff
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = "http://127.0.0.1:1";
    process.env["MARTIN_API_TOKEN"] = "tok";
    const loop = makeLoop();
    await syncLoopToHosted(loop, { runtimeVersion: "0.1.0" });
    // Override nextRetryNotBefore to past so flush picks it up
    const files = await queueFiles();
    const saved = JSON.parse(await readFile(join(qDir(), files[0]!), "utf8"));
    saved.nextRetryNotBefore = new Date(Date.now() - 1000).toISOString();
    saved.attempts = 0;
    await writeFile(join(qDir(), files[0]!), JSON.stringify(saved), "utf8");

    const { url, close } = await startServer((_req, res) => {
      res.writeHead(429, { "Retry-After": "1" }); res.end();
    });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;
    await flushSyncQueue();

    const remaining = await queueFiles();
    expect(remaining).toHaveLength(1);
    const updated = JSON.parse(await readFile(join(qDir(), remaining[0]!), "utf8"));
    expect(updated.attempts).toBeGreaterThanOrEqual(1);
    expect(updated.nextRetryNotBefore).toBeTruthy();
    await close();
  });

  it("skips item with future nextRetryNotBefore", async () => {
    await mkdir(qDir(), { recursive: true });
    const item = makeItem({
      nextRetryNotBefore: new Date(Date.now() + 60_000).toISOString(),
      attempts: 1,
    });
    await writeFile(join(qDir(), `${item.queueId}.json`), JSON.stringify(item), "utf8");

    let uploadCount = 0;
    const { url, close } = await startServer((_req, res) => { uploadCount++; res.writeHead(200); res.end("{}"); });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;
    process.env["MARTIN_API_TOKEN"] = "tok";
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => { out.push(String(s)); return true; });
    await flushSyncQueue();
    expect(uploadCount).toBe(0);
    expect(out.join("")).toContain("deferred by backoff");
    await close();
  });

  it("quarantines item after FLUSH_MAX_ATTEMPTS (5) attempts", async () => {
    await mkdir(qDir(), { recursive: true });
    const item = makeItem({
      attempts: 5, // at or above FLUSH_MAX_ATTEMPTS
      nextRetryNotBefore: new Date(Date.now() - 1000).toISOString(),
    });
    await writeFile(join(qDir(), `${item.queueId}.json`), JSON.stringify(item), "utf8");

    process.env["MARTIN_TELEMETRY_ENDPOINT"] = "http://127.0.0.1:1";
    process.env["MARTIN_API_TOKEN"] = "tok";
    await flushSyncQueue();
    expect(await queueFiles()).toHaveLength(0);
    expect(await quarantineFiles()).toHaveLength(1);
  });

  it("persists attempts across separate flush calls", async () => {
    // Queue via syncLoopToHosted (transient) → attempts:1
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = "http://127.0.0.1:1";
    process.env["MARTIN_API_TOKEN"] = "tok";
    await syncLoopToHosted(makeLoop(), { runtimeVersion: "0.1.0" });
    let files = await queueFiles();
    let saved = JSON.parse(await readFile(join(qDir(), files[0]!), "utf8"));
    expect(saved.attempts).toBe(1);

    // Reset backoff window so flush can pick it up
    saved.nextRetryNotBefore = new Date(Date.now() - 1000).toISOString();
    await writeFile(join(qDir(), files[0]!), JSON.stringify(saved), "utf8");

    // Second flush via 5xx → attempts:2
    const { url, close } = await startServer((_req, res) => { res.writeHead(500); res.end(); });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;
    await flushSyncQueue();

    files = await queueFiles();
    expect(files).toHaveLength(1);
    saved = JSON.parse(await readFile(join(qDir(), files[0]!), "utf8"));
    expect(saved.attempts).toBe(2);
    await close();
  });

  it("quarantines corrupt queue file and continues flushing others", async () => {
    await mkdir(qDir(), { recursive: true });
    await writeFile(join(qDir(), "corrupt.json"), "NOT JSON{{{", "utf8");
    // Add one valid item
    const item = makeItem();
    await writeFile(join(qDir(), `${item.queueId}.json`), JSON.stringify(item), "utf8");

    const { url, close } = await startServer((_req, res) => { res.writeHead(200); res.end("{}"); });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;
    process.env["MARTIN_API_TOKEN"] = "tok";
    await flushSyncQueue();

    expect(await queueFiles()).toHaveLength(0); // valid item uploaded
    expect(await quarantineFiles()).toHaveLength(1); // corrupt quarantined
    await close();
  });

  it("quarantine failure: source file requeued, not counted as quarantined", async () => {
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = "http://127.0.0.1:1";
    process.env["MARTIN_API_TOKEN"] = "tok";
    await syncLoopToHosted(makeLoop(), { runtimeVersion: "0.1.0" });
    expect(await queueFiles()).toHaveLength(1);

    // Block quarantine by making the quarantine dir path a file
    await writeFile(join(qDir(), ".quarantine"), "not a dir", "utf8");

    const { url, close } = await startServer((_req, res) => { res.writeHead(401); res.end(); });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;

    const outLines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => { outLines.push(String(s)); return true; });
    await flushSyncQueue();

    // Summary line must show 0 quarantined
    expect(outLines.join("")).toContain("0 quarantined");
    // Item must be back in the queue (requeued after quarantine failure)
    expect(await queueFiles()).toHaveLength(1);
    await close();
  });
});

// ---------------------------------------------------------------------------
// flushSyncQueue: stale inflight recovery
// ---------------------------------------------------------------------------

describe("stale inflight recovery", () => {
  it("old queue-file mtime does not cause freshly-claimed item to appear stale under concurrent flush", async () => {
    // Regression: before the atomic-filename claim protocol, claimItem renamed
    // queue/<id>.json → .inflight/<id>.json preserving the old mtime. A second
    // concurrent flush calling recoverStaleInflight would see the old mtime and
    // immediately recover the live claim back to the queue, causing a double-upload.
    await mkdir(qDir(), { recursive: true });
    const item = makeItem();
    const queuePath = join(qDir(), `${item.queueId}.json`);
    await writeFile(queuePath, JSON.stringify(item), "utf8");
    // Simulate a file that has sat in the queue for 10 minutes (well past CLAIM_STALE_MS).
    await setMtimeAgo(queuePath, 10 * 60 * 1000);

    const uploadedLoopIds: string[] = [];
    const { url, close } = await startServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try { const p = JSON.parse(body) as { loopId?: string }; if (p.loopId) uploadedLoopIds.push(p.loopId); } catch { /**/ }
        res.writeHead(200); res.end("{}");
      });
    });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;
    process.env["MARTIN_API_TOKEN"] = "tok";
    try {
      await Promise.all([flushSyncQueue(), flushSyncQueue()]);
      // The inflight filename encodes the claim time (now), not the queue-file mtime.
      // Neither flush should mistake the live claim for a stale one.
      expect(uploadedLoopIds).toHaveLength(1);
      expect(await queueFiles()).toHaveLength(0);
      expect(await inflightFiles()).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("new-format stale claim recovered using filename timestamp, not file mtime", async () => {
    // A new-format inflight file with a stale claim timestamp in its name must be
    // recovered even if its filesystem mtime is fresh (e.g. recently written content).
    await mkdir(inflightDir(), { recursive: true });
    const item = makeItem();
    const staleMs = Date.now() - 10 * 60 * 1000; // 10 min ago — beyond CLAIM_STALE_MS
    const inflightFile = `${staleMs}.${randomUUID()}.${item.queueId}.json`;
    // Write with current mtime — proves recovery uses filename timestamp, not mtime.
    await writeFile(join(inflightDir(), inflightFile), JSON.stringify(item), "utf8");

    process.env["MARTIN_TELEMETRY_ENDPOINT"] = "http://127.0.0.1:1";
    process.env["MARTIN_API_TOKEN"] = "tok";
    await flushSyncQueue();

    // Item must be recovered from .inflight back to queue (then deferred after failed upload).
    expect(await inflightFiles()).toHaveLength(0);
    expect(await queueFiles()).toHaveLength(1);
  });

  it("recovers item from .inflight after mtime exceeds threshold (5 min)", async () => {
    // Manually place a valid item in .inflight
    await mkdir(inflightDir(), { recursive: true });
    const item = makeItem();
    const inflightPath = join(inflightDir(), `${item.queueId}.json`);
    await writeFile(inflightPath, JSON.stringify(item), "utf8");
    // Set mtime to 6 minutes ago
    await setMtimeAgo(inflightPath, 6 * 60 * 1000);

    process.env["MARTIN_TELEMETRY_ENDPOINT"] = "http://127.0.0.1:1";
    process.env["MARTIN_API_TOKEN"] = "tok";
    await flushSyncQueue();

    // After recovery + failed upload, item should be in queue (not in inflight)
    expect(await inflightFiles()).toHaveLength(0);
    expect(await queueFiles()).toHaveLength(1);
  });

  it("does NOT recover item younger than 5 min threshold", async () => {
    await mkdir(inflightDir(), { recursive: true });
    const item = makeItem();
    const inflightPath = join(inflightDir(), `${item.queueId}.json`);
    await writeFile(inflightPath, JSON.stringify(item), "utf8");
    // Fresh file — mtime is now, well within threshold

    process.env["MARTIN_TELEMETRY_ENDPOINT"] = "http://127.0.0.1:1";
    process.env["MARTIN_API_TOKEN"] = "tok";
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => { out.push(String(s)); return true; });
    await flushSyncQueue();

    // Item stays in .inflight — not touched
    expect(await inflightFiles()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Queue cap behavior
// ---------------------------------------------------------------------------

describe("queue cap", () => {
  it("quarantines oldest when cap reached, then enqueues new item", async () => {
    // Fill to exactly QUEUE_MAX_SIZE (200)
    await fillQueue(qDir(), 200);
    expect(await queueFiles()).toHaveLength(200);

    // syncLoopToHosted should quarantine oldest and enqueue new one
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = "http://127.0.0.1:1";
    process.env["MARTIN_API_TOKEN"] = "tok";
    await syncLoopToHosted(makeLoop(), { runtimeVersion: "0.1.0" });

    // Queue should still be 200 (oldest removed, new added)
    expect(await queueFiles()).toHaveLength(200);
    // One item quarantined
    expect(await quarantineFiles()).toHaveLength(1);
  }, 15_000);

  it("does not enqueue when cap reached AND quarantine fails", async () => {
    await fillQueue(qDir(), 200);
    // Block quarantine by making quarantine dir a file
    await writeFile(join(qDir(), ".quarantine"), "not a dir", "utf8");

    process.env["MARTIN_TELEMETRY_ENDPOINT"] = "http://127.0.0.1:1";
    process.env["MARTIN_API_TOKEN"] = "tok";
    const errLines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s) => { errLines.push(String(s)); return true; });
    await syncLoopToHosted(makeLoop(), { runtimeVersion: "0.1.0" });

    // Queue must not exceed cap
    expect(await queueFiles()).toHaveLength(200);
    expect(errLines.join("")).toContain("dropped");
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Concurrent flush race: each item uploaded exactly once
// ---------------------------------------------------------------------------

describe("concurrent flush race", () => {
  it("two concurrent flushSyncQueue calls upload each item exactly once", async () => {
    // Write 3 items directly — no backoff state so both flushes can attempt them
    await mkdir(qDir(), { recursive: true });
    const items = [makeItem(), makeItem(), makeItem()];
    await Promise.all(
      items.map((item) =>
        writeFile(join(qDir(), `${item.queueId}.json`), JSON.stringify(item), "utf8")
      )
    );
    expect(await queueFiles()).toHaveLength(3);

    const uploadedLoopIds: string[] = [];
    const { url, close } = await startServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body) as { loopId?: string };
          if (parsed.loopId) uploadedLoopIds.push(parsed.loopId);
        } catch { /* ignore */ }
        res.writeHead(200); res.end("{}");
      });
    });
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = url;
    process.env["MARTIN_API_TOKEN"] = "tok";

    try {
      // Run two concurrent flushes
      await Promise.all([flushSyncQueue(), flushSyncQueue()]);

      expect(await queueFiles()).toHaveLength(0);
      // Each item must be claimed by exactly one flush via atomic rename.
      // The eligible list is built before claiming, so both flushes see the same items.
      // The OS-level rename ensures only one flush wins the claim for each item.
      expect(uploadedLoopIds).toHaveLength(3);
      expect(new Set(uploadedLoopIds).size).toBe(3);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// Multi-process concurrency: atomic claim prevents duplicate uploads
// ---------------------------------------------------------------------------

describe("multi-process concurrent flush", () => {
  it("two separate Node processes upload each queue item exactly once", async () => {
    const ITEM_COUNT = 4;

    // Pre-seed queue with ITEM_COUNT eligible items (no backoff state)
    await mkdir(qDir(), { recursive: true });
    const items = Array.from({ length: ITEM_COUNT }, () => makeItem());
    await Promise.all(
      items.map((item) =>
        writeFile(join(qDir(), `${item.queueId}.json`), JSON.stringify(item), "utf8")
      )
    );

    // Server tracks every upload body received
    const uploadedLoopIds: string[] = [];
    let serverReady: () => void;
    const ready = new Promise<void>((r) => { serverReady = r; });
    const { url, close } = await startServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body) as { loopId?: string };
          if (parsed.loopId) uploadedLoopIds.push(parsed.loopId);
        } catch { /* ignore */ }
        res.writeHead(200); res.end("{}");
      });
    });
    serverReady!();
    await ready;

    const sourceUrl = new URL("../src/sync-client.ts", import.meta.url).href;

    const workerScript = [
      `import { flushSyncQueue } from ${JSON.stringify(sourceUrl)};`,
      `await flushSyncQueue();`,
    ].join("\n");

    const spawnFlush = () =>
      new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module"],
          {
            env: {
              ...process.env,
              MARTIN_SYNC_QUEUE_DIR: qDir(),
              MARTIN_TELEMETRY_ENDPOINT: url,
              MARTIN_API_TOKEN: "tok",
            },
            stdio: ["pipe", "pipe", "pipe"],
          }
        );
        let stdout = "", stderr = "";
        child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
        child.stdin?.write(workerScript);
        child.stdin?.end();

        // Bounded watchdog — kill stuck child rather than hanging the suite
        const watchdog = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`Child process timed out after 15s.\nstdout: ${stdout}\nstderr: ${stderr}`));
        }, 15_000);

        child.on("error", (err) => {
          clearTimeout(watchdog);
          reject(new Error(`Child process error: ${err.message}\nstdout: ${stdout}\nstderr: ${stderr}`));
        });

        child.on("close", (code, signal) => {
          clearTimeout(watchdog);
          if (signal) {
            reject(new Error(`Child killed by signal ${signal}\nstdout: ${stdout}\nstderr: ${stderr}`));
          } else {
            resolve({ stdout, stderr, code });
          }
        });
      });

    try {
      // Launch both processes simultaneously
      const [r1, r2] = await Promise.all([spawnFlush(), spawnFlush()]);

      // Both processes must exit 0
      expect(r1.code, `Process 1 exit code ${r1.code}\nstdout: ${r1.stdout}\nstderr: ${r1.stderr}`).toBe(0);
      expect(r2.code, `Process 2 exit code ${r2.code}\nstdout: ${r2.stdout}\nstderr: ${r2.stderr}`).toBe(0);

      // Queue must be empty
      expect(await queueFiles()).toHaveLength(0);

      // .inflight must be empty — no stranded items
      expect(await inflightFiles()).toHaveLength(0);

      // Each item uploaded exactly once (atomic rename prevents double-upload)
      expect(uploadedLoopIds, `uploadedLoopIds: ${JSON.stringify(uploadedLoopIds)}`).toHaveLength(ITEM_COUNT);
      expect(new Set(uploadedLoopIds).size).toBe(ITEM_COUNT);
    } finally {
      await close();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// syncQueueStatus output
// ---------------------------------------------------------------------------

describe("syncQueueStatus", () => {
  it("reports empty queue", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => { out.push(String(s)); return true; });
    await syncQueueStatus();
    expect(out.join("")).toContain("empty");
  });

  it("lists items sorted by enqueuedAt and shows attempts", async () => {
    await mkdir(qDir(), { recursive: true });
    // Insert items out of chronological order
    const now = Date.now();
    const older = makeItem({ enqueuedAt: new Date(now - 5000).toISOString(), attempts: 2, loopId: "loop-older" });
    const newer = makeItem({ enqueuedAt: new Date(now).toISOString(), attempts: 0, loopId: "loop-newer" });
    await writeFile(join(qDir(), `${older.queueId}.json`), JSON.stringify(older), "utf8");
    await writeFile(join(qDir(), `${newer.queueId}.json`), JSON.stringify(newer), "utf8");

    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => { out.push(String(s)); return true; });
    await syncQueueStatus();
    const combined = out.join("");

    // Both loop IDs appear
    expect(combined).toContain("loop-older");
    expect(combined).toContain("loop-newer");
    // older appears before newer in output
    expect(combined.indexOf("loop-older")).toBeLessThan(combined.indexOf("loop-newer"));
    // attempts shown
    expect(combined).toContain("attempts: 2");
  });

  it("shows quarantine count when present", async () => {
    await mkdir(quarDir(), { recursive: true });
    await writeFile(join(quarDir(), "old.json"), "{}", "utf8");

    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => { out.push(String(s)); return true; });
    await syncQueueStatus();
    expect(out.join("")).toContain("quarantine");
  });
});

// ---------------------------------------------------------------------------
// enqueueLoopForHostedSync: durable local write before any network attempt
// ---------------------------------------------------------------------------

describe("enqueueLoopForHostedSync", () => {
  it("writes item to queue before returning — durability guarantee", async () => {
    process.env["MARTIN_TELEMETRY_ENDPOINT"] = "http://127.0.0.1:1"; // unreachable
    process.env["MARTIN_API_TOKEN"] = "tok";
    await enqueueLoopForHostedSync(makeLoop(), { runtimeVersion: "0.1.0" });
    // Queue file must exist immediately after the await — no network attempt has been made
    expect(await queueFiles()).toHaveLength(1);
  });

  it("is a no-op when env vars are not set", async () => {
    await enqueueLoopForHostedSync(makeLoop(), { runtimeVersion: "0.1.0" });
    expect(await queueFiles()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// martin sync command parsing
// ---------------------------------------------------------------------------

describe("martin sync command parsing", () => {
  it("martin sync → status", () => {
    const p = parseCliArguments(["sync"]);
    expect(p.command).toBe("sync");
    if (p.command === "sync") expect(p.sub).toBe("status");
  });

  it("martin sync status → status", () => {
    const p = parseCliArguments(["sync", "status"]);
    expect(p.command).toBe("sync");
    if (p.command === "sync") expect(p.sub).toBe("status");
  });

  it("martin sync flush → flush", () => {
    const p = parseCliArguments(["sync", "flush"]);
    expect(p.command).toBe("sync");
    if (p.command === "sync") expect(p.sub).toBe("flush");
  });

  it("martin sync <unknown> → throws usage error", () => {
    expect(() => parseCliArguments(["sync", "garbage"])).toThrow();
  });

  it("martin sync status extra → throws too-many-arguments error", () => {
    expect(() => parseCliArguments(["sync", "status", "extra"])).toThrow();
  });
});
