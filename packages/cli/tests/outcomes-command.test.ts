import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executeCli, parseCliArguments } from "../src/index.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function startServer(saved: boolean): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      records: saved
        ? [{ requestNonce: "nonce-1", tenantId: "tenant-test", status: "confirmed" }]
        : [],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function contractFile(origin: string, root: string): Promise<string> {
  const path = join(root, "outcome-contract.json");
  await writeFile(path, JSON.stringify({
    schemaVersion: "external-outcome/1",
    contractId: "booking-save",
    allowedOrigins: [origin],
    deadlineMs: 150,
    pollIntervalMs: 25,
    requestTimeoutMs: 75,
    actions: [{
      actionId: "booking-001",
      claimedDone: true,
      source: { url: `${origin}/api/bookings/nonce-1` },
      recordPointer: "/records",
      identity: { pointer: "/requestNonce", equals: "nonce-1" },
      expectedCount: 1,
      assertions: [
        { pointer: "/tenantId", equals: "tenant-test" },
        { pointer: "/status", equals: "confirmed" },
      ],
    }],
  }, null, 2));
  return path;
}

describe("outcomes verify CLI", () => {
  it("parses governed staging network policy for external side-effect runs", () => {
    const parsed = parseCliArguments([
      "run",
      "Submit the staging form",
      "--verify",
      "martin outcomes verify --contract outcome-contract.json --json",
      "--execution-profile",
      "staging_controlled",
      "--allow-network-domain",
      "staging.example.com",
      "--approve-external-writes",
      "--max-iterations",
      "1",
    ]);
    expect(parsed).toMatchObject({
      command: "run",
      request: {
        executionProfile: "staging_controlled",
        allowedNetworkDomains: ["staging.example.com"],
        approvalPolicy: { externalWrites: true },
        budget: { maxIterations: 1 },
      },
    });
  });

  it("parses the strict command surface", () => {
    expect(parseCliArguments(["outcomes", "verify", "--contract", "contract.json", "--allow-local", "--runs-dir", "runs"])).toEqual({
      command: "outcomes_verify",
      request: { contractPath: "contract.json", runsDir: "runs", allowLocal: true },
    });
    expect(() => parseCliArguments(["outcomes", "verify", "--contract", "a", "--contract", "b"])).toThrow(/duplicate --contract/iu);
    expect(() => parseCliArguments(["outcomes", "verify"])).toThrow(/requires --contract/iu);
  });

  it("prints structured action results and never claims governed VERIFIED", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-outcomes-cli-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const origin = await startServer(true);
    const contract = await contractFile(origin, root);
    const runsRoot = join(root, "runs");

    const result = await executeCli([
      "outcomes", "verify", "--contract", contract, "--allow-local", "--runs-dir", runsRoot, "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      command: "outcomes verify",
      status: "passed",
      aggregate: { claimedDone: 1, passed: 1, failed: 0, unknown: 0 },
      actions: [{ actionId: "booking-001", status: "passed" }],
      evidence: { kind: "external_outcome", contractId: "booking-save" },
    });
    expect(result.stdout).not.toContain("VERIFIED");
    expect(await readFile(payload.evidencePath, "utf8")).toContain('"schemaVersion": "external-outcome-result/1"');
  });

  it("fails closed when a bound governed verifier is not staging-controlled", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-outcomes-cli-policy-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const origin = await startServer(true);
    const contract = await contractFile(origin, root);
    const previous = {
      runId: process.env.MARTIN_RUN_ID,
      profile: process.env.MARTIN_EXECUTION_PROFILE,
      domains: process.env.MARTIN_ALLOWED_NETWORK_DOMAINS,
    };
    process.env.MARTIN_RUN_ID = "loop-bound";
    process.env.MARTIN_EXECUTION_PROFILE = "strict_local";
    process.env.MARTIN_ALLOWED_NETWORK_DOMAINS = JSON.stringify(["127.0.0.1"]);
    cleanup.push(() => {
      if (previous.runId === undefined) delete process.env.MARTIN_RUN_ID; else process.env.MARTIN_RUN_ID = previous.runId;
      if (previous.profile === undefined) delete process.env.MARTIN_EXECUTION_PROFILE; else process.env.MARTIN_EXECUTION_PROFILE = previous.profile;
      if (previous.domains === undefined) delete process.env.MARTIN_ALLOWED_NETWORK_DOMAINS; else process.env.MARTIN_ALLOWED_NETWORK_DOMAINS = previous.domains;
    });

    const result = await executeCli([
      "outcomes", "verify", "--contract", contract, "--allow-local", "--runs-dir", join(root, "runs"), "--json",
    ]);
    expect(result.exitCode).toBe(8);
    expect(JSON.parse(result.stdout)).toMatchObject({ category: "policy_blocked" });
  });

  it("blocks a contract changed after the trusted pre-execution snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-outcomes-cli-hash-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const origin = await startServer(true);
    const contract = await contractFile(origin, root);

    const result = await executeCli([
      "outcomes", "verify", "--contract", contract, "--allow-local",
      "--expected-contract-sha256", "a".repeat(64),
      "--runs-dir", join(root, "runs"), "--json",
    ]);
    expect(result.exitCode).toBe(8);
    expect(JSON.parse(result.stdout)).toMatchObject({
      category: "policy_blocked",
      message: expect.stringMatching(/changed after the trusted pre-execution snapshot/iu),
    });
  });

  it("uses exit 7 when required persisted state is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-outcomes-cli-missing-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const origin = await startServer(false);
    const contract = await contractFile(origin, root);

    const result = await executeCli([
      "outcomes", "verify", "--contract", contract, "--allow-local", "--runs-dir", join(root, "runs"), "--json",
    ]);

    expect(result.exitCode).toBe(7);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "failed",
      aggregate: { claimedDone: 1, passed: 0, failed: 1, unknown: 0 },
      actions: [{ reasonCode: "record_missing" }],
    });
  });
});
