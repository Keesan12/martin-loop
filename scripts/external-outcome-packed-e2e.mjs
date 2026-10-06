#!/usr/bin/env node

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { packRootRelease } from "./pack-root-release.mjs";
import { resolvePublishedArtifactCommandExecution } from "./published-artifact-e2e.mjs";

function runCommand(command, options = {}) {
  const execution = resolvePublishedArtifactCommandExecution(command, process.platform);
  return new Promise((resolve, reject) => {
    const child = spawn(execution.command, execution.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: execution.shell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
  });
}

function requireExit(result, expected, label) {
  if (result.exitCode !== expected) {
    throw new Error(`${label} expected exit ${expected}, got ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function createBatchContract(origin) {
  return {
    schemaVersion: "external-outcome/1",
    contractId: "packed-batch-27",
    allowedOrigins: [origin],
    deadlineMs: 500,
    pollIntervalMs: 25,
    requestTimeoutMs: 100,
    actions: Array.from({ length: 27 }, (_, index) => {
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
    }),
  };
}

function createPassContract(origin) {
  return {
    schemaVersion: "external-outcome/1",
    contractId: "packed-single-pass",
    allowedOrigins: [origin],
    deadlineMs: 250,
    pollIntervalMs: 25,
    requestTimeoutMs: 100,
    actions: [{
      actionId: "booking-pass",
      claimedDone: true,
      source: { url: `${origin}/api/bookings/pass` },
      recordPointer: "/records",
      identity: { pointer: "/requestNonce", equals: "pass" },
      expectedCount: 1,
      assertions: [
        { pointer: "/tenantId", equals: "tenant-test" },
        { pointer: "/status", equals: "confirmed" },
      ],
    }],
  };
}

export async function runExternalOutcomePackedE2e(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const tempRoot = await mkdtemp(path.join(tmpdir(), "martin-outcomes-pack-"));
  let server;
  try {
    const pack = await packRootRelease({ rootDir, outputDir: path.join(tempRoot, "pack") });
    const consumer = path.join(tempRoot, "consumer");
    const runsRoot = path.join(tempRoot, "runs");
    await mkdir(consumer, { recursive: true });
    await mkdir(runsRoot, { recursive: true });
    await writeFile(path.join(consumer, "package.json"), JSON.stringify({
      name: "martin-outcomes-packed-e2e",
      private: true,
      type: "module",
    }, null, 2));

    requireExit(
      await runCommand(["npm", "install", "--save-exact", "--no-audit", "--no-fund", pack.tarballPath], { cwd: consumer }),
      0,
      "packed install",
    );

    const dropped = new Set(Array.from({ length: 7 }, (_, index) => `nonce-${21 + index}`));
    server = createServer((req, res) => {
      const nonce = decodeURIComponent((req.url ?? "").split("/").at(-1) ?? "");
      const records = dropped.has(nonce)
        ? []
        : [{ requestNonce: nonce, tenantId: "tenant-test", status: "confirmed", guests: 2 }];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ records }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server did not expose a port");
    const origin = `http://127.0.0.1:${address.port}`;

    const bin = path.join(consumer, "node_modules", ".bin", process.platform === "win32" ? "martin.cmd" : "martin");
    const batchContractPath = path.join(consumer, "batch-contract.json");
    await writeFile(batchContractPath, `${JSON.stringify(createBatchContract(origin), null, 2)}\n`, "utf8");

    const batch = requireExit(await runCommand([
      bin, "outcomes", "verify",
      "--contract", batchContractPath,
      "--allow-local",
      "--runs-dir", runsRoot,
      "--json",
    ], { cwd: consumer, env: { ...process.env, CI: "1" } }), 7, "27-action packed outcome check");

    const batchPayload = JSON.parse(batch.stdout);
    const expectedAggregate = { claimedDone: 27, checked: 27, passed: 20, failed: 7, unknown: 0 };
    for (const [key, value] of Object.entries(expectedAggregate)) {
      if (batchPayload.aggregate?.[key] !== value) {
        throw new Error(`packed batch aggregate ${key} expected ${value}, got ${String(batchPayload.aggregate?.[key])}`);
      }
    }
    if (batchPayload.aggregate?.rejectedClaimRate !== 7 / 27 || batchPayload.aggregate?.coverage !== 1) {
      throw new Error("packed batch claim-rate metrics are incorrect");
    }
    if (String(batch.stdout).includes("VERIFIED")) throw new Error("standalone packed outcome checker must not claim governed VERIFIED");
    const batchEvidence = await readFile(batchPayload.evidencePath, "utf8");
    if (!batchEvidence.includes('"schemaVersion": "external-outcome-result/1"')) {
      throw new Error("packed batch evidence artifact missing expected schema");
    }

    const passContractPath = path.join(consumer, "pass-contract.json");
    await writeFile(passContractPath, `${JSON.stringify(createPassContract(origin), null, 2)}\n`, "utf8");
    const pass = requireExit(await runCommand([
      bin, "outcomes", "verify",
      "--contract", passContractPath,
      "--allow-local",
      "--runs-dir", runsRoot,
      "--json",
    ], { cwd: consumer, env: { ...process.env, CI: "1" } }), 0, "packed single-pass outcome check");
    const passPayload = JSON.parse(pass.stdout);
    if (passPayload.status !== "passed" || passPayload.aggregate?.passed !== 1) {
      throw new Error("packed pass outcome did not report the expected pass");
    }

    return {
      status: "PASS",
      packageVersion: JSON.parse(await readFile(path.join(consumer, "node_modules", "martin-loop", "package.json"), "utf8")).version,
      batch: {
        exitCode: batch.exitCode,
        aggregate: batchPayload.aggregate,
        evidenceSha256: batchPayload.evidence?.sha256,
      },
      pass: {
        exitCode: pass.exitCode,
        aggregate: passPayload.aggregate,
        evidenceSha256: passPayload.evidence?.sha256,
      },
    };
  } finally {
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function main() {
  const result = await runExternalOutcomePackedE2e({ rootDir: process.cwd() });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === path.resolve(modulePath)) {
  main().catch((error) => {
    process.stderr.write(`[external-outcome-packed-e2e] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
