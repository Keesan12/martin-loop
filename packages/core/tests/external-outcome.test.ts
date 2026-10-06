import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ExternalOutcomePolicyError,
  verifyExternalOutcomes,
  writeExternalOutcomeEvidence,
} from "../src/external-outcome.js";
import type { ExternalOutcomeContract } from "@martin/contracts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function server(handler: Handler): Promise<{ origin: string }> {
  const instance = createServer(handler);
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => instance.close(() => resolve())));
  const { port } = instance.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}` };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function oneAction(origin: string, path: string, overrides: Partial<ExternalOutcomeContract["actions"][number]> = {}): ExternalOutcomeContract {
  return {
    schemaVersion: "external-outcome/1",
    contractId: "booking-save",
    allowedOrigins: [origin],
    deadlineMs: 400,
    pollIntervalMs: 25,
    requestTimeoutMs: 100,
    actions: [{
      actionId: "booking-001",
      claimedDone: true,
      source: { url: `${origin}${path}` },
      recordPointer: "/records",
      identity: { pointer: "/requestNonce", equals: "nonce-1" },
      expectedCount: 1,
      assertions: [
        { pointer: "/tenantId", equals: "tenant-test" },
        { pointer: "/status", equals: "confirmed" },
        { pointer: "/guests", equals: 2 },
      ],
      ...overrides,
    }],
  };
}

describe("external outcome verification", () => {
  it("detects exactly seven dropped writes out of 27 claimed completions", async () => {
    const dropped = new Set(Array.from({ length: 7 }, (_, index) => `nonce-${21 + index}`));
    const methods: string[] = [];
    const { origin } = await server((req, res) => {
      methods.push(req.method ?? "");
      const nonce = decodeURIComponent((req.url ?? "").split("/").at(-1) ?? "");
      const records = dropped.has(nonce)
        ? []
        : [{ requestNonce: nonce, tenantId: "tenant-test", status: "confirmed", guests: 2 }];
      json(res, 200, { records });
    });

    const actions = Array.from({ length: 27 }, (_, index) => {
      const nonce = `nonce-${index + 1}`;
      return {
        actionId: `booking-${String(index + 1).padStart(2, "0")}`,
        claimedDone: true,
        source: { url: `${origin}/api/bookings/${nonce}` },
        recordPointer: "/records",
        identity: { pointer: "/requestNonce", equals: nonce },
        expectedCount: 1,
        assertions: [
          { pointer: "/tenantId", equals: "tenant-test" },
          { pointer: "/status", equals: "confirmed" },
          { pointer: "/guests", equals: 2 },
        ],
      };
    }) satisfies ExternalOutcomeContract["actions"];

    const result = await verifyExternalOutcomes({
      schemaVersion: "external-outcome/1",
      contractId: "batch-27",
      allowedOrigins: [origin],
      deadlineMs: 700,
      pollIntervalMs: 25,
      requestTimeoutMs: 100,
      actions,
    }, { allowLocal: true });

    expect(result.aggregate).toEqual({ claimedDone: 27, checked: 27, passed: 20, failed: 7, unknown: 0, rejectedClaimRate: 7 / 27, unknownClaimRate: 0, coverage: 1 });
    expect(result.actions.filter((item) => item.reasonCode === "record_missing")).toHaveLength(7);
    expect(result.actions.every((item) => item.observationCount >= 1)).toBe(true);
    expect(new Set(methods)).toEqual(new Set(["GET"]));
  }, 5_000);

  it("supports a single-object read-back endpoint when expectedCount is one", async () => {
    const { origin } = await server((_req, res) => json(res, 200, {
      id: "brand-1",
      description: "MartinLoop outcome verification staging marker",
      category: "staging-test",
    }));

    const result = await verifyExternalOutcomes(oneAction(origin, "/brand", {
      recordPointer: "",
      identity: { pointer: "/id", equals: "brand-1" },
      expectedCount: 1,
      assertions: [
        { pointer: "/description", equals: "MartinLoop outcome verification staging marker" },
        { pointer: "/category", equals: "staging-test" },
      ],
    }), { allowLocal: true });

    expect(result.actions[0]).toMatchObject({ status: "passed", reasonCode: "passed" });
  });

  it("passes correct state and rejects wrong values, duplicate records, wrong identity, and stale versions", async () => {
    const scenarios: Record<string, unknown[]> = {
      "/pass": [{ requestNonce: "nonce-1", tenantId: "tenant-test", status: "confirmed", guests: 2, version: 2 }],
      "/wrong-value": [{ requestNonce: "nonce-1", tenantId: "tenant-test", status: "cancelled", guests: 2, version: 2 }],
      "/duplicate": [
        { requestNonce: "nonce-1", tenantId: "tenant-test", status: "confirmed", guests: 2, version: 2 },
        { requestNonce: "nonce-1", tenantId: "tenant-test", status: "confirmed", guests: 2, version: 3 },
      ],
      "/wrong-identity": [{ requestNonce: "previous-run", tenantId: "tenant-test", status: "confirmed", guests: 2, version: 2 }],
      "/stale": [{ requestNonce: "nonce-1", tenantId: "tenant-test", status: "confirmed", guests: 2, version: 1 }],
    };
    const { origin } = await server((req, res) => json(res, 200, { records: scenarios[req.url ?? ""] ?? [] }));

    const pass = await verifyExternalOutcomes(oneAction(origin, "/pass", {
      freshness: { pointer: "/version", notEquals: 1 },
    }), { allowLocal: true });
    expect(pass.actions[0]).toMatchObject({ status: "passed", reasonCode: "passed" });

    for (const [path, reason] of [
      ["/wrong-value", "value_mismatch"],
      ["/duplicate", "duplicate_record"],
      ["/wrong-identity", "wrong_identity"],
      ["/stale", "stale_record"],
    ] as const) {
      const result = await verifyExternalOutcomes(oneAction(origin, path, {
        freshness: { pointer: "/version", notEquals: 1 },
      }), { allowLocal: true });
      expect(result.actions[0]).toMatchObject({ status: "failed", reasonCode: reason });
    }
  }, 5_000);

  it("polls delayed persistence without resubmitting anything", async () => {
    const started = Date.now();
    let reads = 0;
    const { origin } = await server((_req, res) => {
      reads += 1;
      const records = Date.now() - started >= 100
        ? [{ requestNonce: "nonce-1", tenantId: "tenant-test", status: "confirmed", guests: 2 }]
        : [];
      json(res, 200, { records });
    });

    const result = await verifyExternalOutcomes(oneAction(origin, "/delayed"), { allowLocal: true });
    expect(result.actions[0]).toMatchObject({ status: "passed" });
    expect(reads).toBeGreaterThan(1);
  });

  it("keeps auth, source, malformed JSON, redirect, and oversized responses unknown rather than passing", async () => {
    const huge = "x".repeat(1024 * 1024 + 100);
    const { origin } = await server((req, res) => {
      if (req.url === "/auth") return json(res, 401, { error: "denied" });
      if (req.url === "/unavailable") return json(res, 503, { error: "down" });
      if (req.url === "/malformed") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end("{broken");
      }
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "https://evil.example/" });
        return res.end();
      }
      if (req.url === "/huge") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ records: [{ requestNonce: "nonce-1", payload: huge }] }));
      }
      if (req.url === "/missing-field") {
        return json(res, 200, { records: [{ requestNonce: "nonce-1", tenantId: "tenant-test", guests: 2 }] });
      }
      return json(res, 404, {});
    });

    for (const [path, reason] of [
      ["/auth", "auth_denied"],
      ["/unavailable", "source_unavailable"],
      ["/malformed", "invalid_response"],
      ["/redirect", "redirect_blocked"],
      ["/huge", "response_too_large"],
      ["/missing-field", "invalid_response"],
    ] as const) {
      const result = await verifyExternalOutcomes(oneAction(origin, path), { allowLocal: true });
      expect(result.actions[0]).toMatchObject({ status: "unknown", reasonCode: reason });
    }
  }, 5_000);

  it("aborts outstanding reads on cancellation", async () => {
    const { origin } = await server((_req, res) => {
      setTimeout(() => json(res, 200, { records: [] }), 250);
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    const result = await verifyExternalOutcomes(oneAction(origin, "/slow"), {
      allowLocal: true,
      signal: controller.signal,
    });

    expect(result.actions[0]).toMatchObject({ status: "unknown", reasonCode: "cancelled" });
  });

  it("reports partial coverage when the global deadline expires before every claim is observed", async () => {
    const { origin } = await server((_req, res) => {
      setTimeout(() => json(res, 200, { records: [] }), 100);
    });
    const actions = Array.from({ length: 8 }, (_, index) => {
      const nonce = `nonce-${index + 1}`;
      return {
        actionId: `claim-${index + 1}`,
        claimedDone: true,
        source: { url: `${origin}/slow/${nonce}` },
        recordPointer: "/records",
        identity: { pointer: "/requestNonce", equals: nonce },
        expectedCount: 1,
        assertions: [{ pointer: "/status", equals: "confirmed" }],
      };
    }) satisfies ExternalOutcomeContract["actions"];

    const result = await verifyExternalOutcomes({
      schemaVersion: "external-outcome/1",
      contractId: "coverage-deadline",
      allowedOrigins: [origin],
      deadlineMs: 25,
      pollIntervalMs: 25,
      requestTimeoutMs: 25,
      actions,
    }, { allowLocal: true });

    expect(result.aggregate.claimedDone).toBe(8);
    expect(result.aggregate.checked).toBeLessThan(8);
    expect(result.aggregate.coverage).toBe(result.aggregate.checked / 8);
    expect(result.actions.filter((item) => item.observationCount === 0)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "unknown", reasonCode: "deadline_exceeded" }),
    ]));
  });

  it("blocks private/local targets unless explicitly opted in", async () => {
    const { origin } = await server((_req, res) => json(res, 200, { records: [] }));
    await expect(verifyExternalOutcomes(oneAction(origin, "/private"))).rejects.toBeInstanceOf(ExternalOutcomePolicyError);
  });

  it("blocks IPv4-mapped IPv6 private targets without local opt-in", async () => {
    const contract = oneAction("https://[::ffff:7f00:1]", "/private");
    await expect(verifyExternalOutcomes(contract)).rejects.toBeInstanceOf(ExternalOutcomePolicyError);
  });

  it("writes a redacted atomic evidence artifact bound to active run identity", async () => {
    let observedAuthorization = "";
    const { origin } = await server((req, res) => {
      observedAuthorization = String(req.headers.authorization ?? "");
      json(res, 200, { records: [{ requestNonce: "nonce-1", tenantId: "tenant-test", status: "confirmed", guests: 2 }] });
    });
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-outcome-evidence-"));
    cleanup.push(() => rm(runsRoot, { recursive: true, force: true }));

    const contract = oneAction(origin, "/secure", {
      source: { url: `${origin}/secure`, authEnv: "BOOKING_READ_TOKEN" },
    });
    const result = await verifyExternalOutcomes(contract, {
      allowLocal: true,
      env: {
        BOOKING_READ_TOKEN: "super-secret-token",
        MARTIN_RUN_ID: "loop-outcome-1",
        MARTIN_WORKSPACE_ID: "workspace-outcome-1",
      },
    });
    const written = await writeExternalOutcomeEvidence(result, { runsRoot, runId: "loop-outcome-1" });
    const bytes = await readFile(written.path, "utf8");

    expect(observedAuthorization).toBe("Bearer super-secret-token");
    expect(bytes).not.toContain("super-secret-token");
    expect(bytes).not.toContain("/secure");
    expect(result.binding).toEqual({ runId: "loop-outcome-1", workspaceId: "workspace-outcome-1" });
    expect(written.reference.path).toMatch(/^external-outcomes\//u);
    expect(written.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});
