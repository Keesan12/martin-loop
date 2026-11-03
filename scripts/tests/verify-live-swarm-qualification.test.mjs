import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { resolveSwarmDeadlineMs } from "../../packages/contracts/dist/index.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..", "..");
const validator = join(repoRoot, "scripts", "verify-live-swarm-qualification.mjs");

async function makeSubmittedRoot(prefix) {
  const base = join(repoRoot, ".release");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, prefix));
}

async function runValidator(receipt, ...args) {
  const root = await mkdtemp(join(tmpdir(), "martin-live-swarm-validator-"));
  const receiptPath = join(root, "qualification.json");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  try {
    return await execFileAsync(process.execPath, [validator, ...args, receiptPath], { cwd: repoRoot });
  } catch (error) {
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", exitCode: error.code };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runSpec(name, agents, maxConcurrency, budgetUsd) {
  return {
    name,
    agents,
    maxConcurrency,
    budgetUsd,
    maxWallClockMs: resolveSwarmDeadlineMs({ agents, maxConcurrency }),
    simulationFallbackCalls: 0,
    command: `martin demo --swarm --live --engine codex --agents ${agents} --max-concurrency ${maxConcurrency} --budget-usd ${budgetUsd}`,
    argv: ["demo", "--swarm", "--live", "--engine", "codex", "--agents", String(agents), "--max-concurrency", String(maxConcurrency), "--budget-usd", String(budgetUsd)],
    swarmId: null,
    exitCode: null,
    evidence: null,
  };
}

test("rejects a PASS-shaped receipt without bound execution evidence", async () => {
  const receipt = {
    schemaVersion: "martin.live-swarm.qualification.v1",
    status: "PASS",
    generatedAt: new Date().toISOString(),
    source: { sha: "a".repeat(40) },
    binary: { path: resolve(process.execPath), sha256: "b".repeat(64), version: "0.8.10" },
    capability: { authStatus: "BLOCKED", preflightStatus: "UNKNOWN" },
    approval: { approved: true, maxCombinedUsd: 15 },
    runs: [runSpec("canary", 3, 3, 3), runSpec("full", 15, 5, 12)],
    zeroFallbackPolicy: "live failures exit nonzero; simulation is never invoked",
  };
  const result = await runValidator(receipt, "--decision", "required-live");
  assert.notEqual(result.exitCode ?? 0, 0, "fabricated PASS must be rejected");
  assert.match(result.stderr, /PASS|auth|preflight|evidence|source|binary/iu);
});

test("rejects fabricated byte-matched PASS artifacts without canonical persisted Swarm evidence", async () => {
  const root = await makeSubmittedRoot("live-swarm-valid-proof-");
  try {
    const { stdout: sourceSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
    const binaryPath = join(root, "martin-cli.js");
    const binaryBytes = Buffer.from("live-swarm test binary\n", "utf8");
    await writeFile(binaryPath, binaryBytes);
    const binarySha256 = createHash("sha256").update(binaryBytes).digest("hex");
    const makeEvidence = async (name) => {
      const artifacts = [];
      for (const kind of ["receipt", "ledger", "dossier", "integrity", "verifier", "budget"]) {
        const path = join(root, `${name}-${kind}.json`);
        const bytes = Buffer.from(`${JSON.stringify({ name, kind, status: "PASS" })}\n`, "utf8");
        await writeFile(path, bytes);
        artifacts.push({ kind, path, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
      return {
        authoritative: true,
        providerExecuted: true,
        receiptIntegrity: "verified",
        verifierStatus: "PASS",
        dossierStatus: "PASS",
        budgetStatus: "within_cap",
        sourceSha: sourceSha.trim(),
        binarySha256,
        artifacts,
      };
    };
    const canary = runSpec("canary", 3, 3, 3);
    Object.assign(canary, { swarmId: "live-swarm-canary", exitCode: 0, evidence: await makeEvidence("canary") });
    const full = runSpec("full", 15, 5, 12);
    Object.assign(full, { swarmId: "live-swarm-full", exitCode: 0, evidence: await makeEvidence("full") });
    const receipt = {
      schemaVersion: "martin.live-swarm.qualification.v1",
      status: "PASS",
      generatedAt: new Date().toISOString(),
      source: { sha: sourceSha.trim() },
      binary: { path: binaryPath, sha256: binarySha256, version: "0.8.10" },
      capability: { authStatus: "PASS", preflightStatus: "PASS" },
      approval: { approved: true, maxCombinedUsd: 15 },
      runs: [canary, full],
      zeroFallbackPolicy: "live failures exit nonzero; simulation is never invoked",
    };
    const result = await runValidator(receipt, "--decision", "required-live");
    assert.notEqual(result.exitCode ?? 0, 0, "byte-matched synthetic PASS artifacts must not establish live provider proof");
    assert.match(result.stderr, /persisted|swarm|provider|receipt|evidence/iu);
    assert.doesNotMatch(result.stderr, /escapes its authorized root/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("STRUCTURE_VALID is machine-distinct from LIVE_QUALIFIED", async () => {
  const fixture = await createSubmittedQualification();
  try {
    const result = await runValidator(fixture.receipt, "--decision", "structure");
    assert.equal(result.exitCode ?? 0, 0, result.stderr);
    assert.match(result.stdout, /STRUCTURE_VALID/u);
    assert.doesNotMatch(result.stdout, /(?:^|[^_])PASS(?:$|[^_])/u);
    assert.match(result.stdout, /"liveQualified"\s*:\s*false/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

const requiredLiveCases = [
  ["Q-01", "fake binary and self-authored JSON", {}, /schema|artifact|candidate|package/iu],
  ["Q-02", "matching hashes over non-JSON artifacts", { nonJsonArtifacts: true }, /JSON|schema|artifact/iu],
];

for (const [id, name, options, expected] of requiredLiveCases) {
  test(`${id} required-live rejects ${name}`, async () => {
    const fixture = await createSubmittedQualification(options);
    try {
      const result = await runValidator(fixture.receipt, "--decision", "required-live");
      assert.equal(result.exitCode, 1, `${id}: submitted evidence must not self-qualify live execution`);
      assert.match(result.stderr, expected);
      assert.doesNotMatch(result.stdout, /LIVE_QUALIFIED/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("Q-03 required-live parses exact argv and rejects conflicting duplicate values", async () => {
  const fixture = await createSubmittedQualification();
  try {
    fixture.receipt.runs[0].argv.push("--agents", "30");
    fixture.receipt.runs[0].command = "martin demo --swarm --live --engine codex --agents 30 --max-concurrency 3 --budget-usd 3";
    fixture.receipt.runs[1].argv.push("--agents", "150");
    fixture.receipt.runs[1].command = "martin demo --swarm --live --engine codex --agents 150 --max-concurrency 5 --budget-usd 12";
    const result = await runValidator(fixture.receipt, "--decision", "required-live");
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /argv|duplicate|agents|conflict/iu);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createSubmittedQualification(options = {}) {
  const root = await makeSubmittedRoot("live-swarm-submitted-proof-");
  const { stdout: sourceSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  const binaryPath = join(root, "martin-cli.js");
  const binaryBytes = Buffer.from("live-swarm submitted binary\n", "utf8");
  await writeFile(binaryPath, binaryBytes);
  const binarySha256 = createHash("sha256").update(binaryBytes).digest("hex");
  const evidence = async (name) => {
    const artifacts = [];
    for (const kind of ["receipt", "ledger", "dossier", "integrity", "verifier", "budget"]) {
      const path = join(root, `${name}-${kind}.json`);
      const bytes = options.nonJsonArtifacts
        ? Buffer.from("THIS IS NOT JSON\n", "utf8")
        : Buffer.from(`${JSON.stringify({ name, kind, status: "PASS" })}\n`, "utf8");
      await writeFile(path, bytes);
      artifacts.push({ kind, path, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    return {
      runsRoot: root,
      swarmId: `live-swarm-${name}`,
      authoritative: true,
      providerExecuted: true,
      receiptIntegrity: "verified",
      verifierStatus: "PASS",
      dossierStatus: "PASS",
      budgetStatus: "within_cap",
      sourceSha: sourceSha.trim(),
      binarySha256,
      artifacts,
    };
  };
  const canary = runSpec("canary", 3, 3, 3);
  Object.assign(canary, { swarmId: "live-swarm-canary", exitCode: 0, evidence: await evidence("canary") });
  const full = runSpec("full", 15, 5, 12);
  Object.assign(full, { swarmId: "live-swarm-full", exitCode: 0, evidence: await evidence("full") });
  return {
    root,
    receipt: {
      schemaVersion: "martin.live-swarm.qualification.v1",
      status: options.status ?? "PASS",
      generatedAt: new Date().toISOString(),
      source: { sha: sourceSha.trim() },
      binary: { path: binaryPath, sha256: binarySha256, version: options.version ?? "0.8.10" },
      capability: { authStatus: "PASS", preflightStatus: "PASS" },
      approval: { approved: options.approved ?? true, maxCombinedUsd: 15 },
      runs: [canary, full],
      zeroFallbackPolicy: "live failures exit nonzero; simulation is never invoked",
    },
  };
}
