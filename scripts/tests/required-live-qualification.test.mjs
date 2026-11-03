import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test, { after, before } from "node:test";

import {
  buildLiveSwarmProductionFixture,
  qualificationReceipt,
  writeLiveSwarmTrustedDocuments,
} from "./helpers/production-swarm-fixture.mjs";
import {
  captureImmutableFileSnapshot,
  EXPECTED_RUNS,
  validateQualificationStructure,
  verifyImmutableFileSnapshots,
} from "../lib/required-live-authority.mjs";

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..", "..");
const VALIDATOR = join(ROOT, "scripts", "verify-live-swarm-qualification.mjs");
const TEST_TMPDIR = await realpath(tmpdir());
let fixture;

before(async () => {
  const root = await mkdtemp(join(TEST_TMPDIR, "martin-live-swarm-required-live-"));
  const submittedBase = join(ROOT, ".release");
  await mkdir(submittedBase, { recursive: true });
  const submittedRoot = await mkdtemp(join(submittedBase, "live-swarm-production-proof-"));
  const priorIntegrityRoot = process.env.MARTIN_INTEGRITY_KEY_DIR;
  const canary = await buildLiveSwarmProductionFixture({
    root,
    submittedRoot,
    name: "canary",
    workers: 3,
    maxConcurrency: 3,
    budgetUsd: 3,
    usageUsdByIndex: [0.09, 0.07, 0.08],
    delayMsByIndex: [2_000, 1_000, 0],
  });
  const full = await buildLiveSwarmProductionFixture({ root, submittedRoot, name: "full", workers: 15, maxConcurrency: 5, budgetUsd: 12 });
  const failedCanary = await buildLiveSwarmProductionFixture({ root, submittedRoot, name: "canary-failed", workers: 3, maxConcurrency: 3, budgetUsd: 3, verifierPass: false });
  failedCanary.name = "canary";
  if (priorIntegrityRoot === undefined) delete process.env.MARTIN_INTEGRITY_KEY_DIR; else process.env.MARTIN_INTEGRITY_KEY_DIR = priorIntegrityRoot;
  const sourceSha = (await git(["rev-parse", "HEAD"])).trim();
  const sourceTree = (await git(["rev-parse", "HEAD^{tree}"])).trim();
  const trusted = await writeLiveSwarmTrustedDocuments({ root, runs: [canary, full], sourceSha, sourceTree });
  const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const cliPath = join(ROOT, "dist", "bin", "martin-loop.js");
  const cliSha256 = digest(await readFile(cliPath));
  const receipt = qualificationReceipt({ runs: [canary, full], sourceSha, cliPath, cliSha256, version: packageJson.version });
  const receiptPath = join(submittedRoot, "qualification.json");
  await writeJson(receiptPath, receipt);
  fixture = { root, submittedRoot, trustRoot: trusted.trustRoot, receipt, receiptPath, sourceSha, sourceTree, canary, failedCanary, full };
});

after(async () => {
  if (!fixture) return;
  await rm(fixture.root, { recursive: true, force: true });
  await rm(fixture.submittedRoot, { recursive: true, force: true });
});

test("synthetic production-store fixture accepts cent-identical accounting regardless of child completion order", async () => {
  const result = await runRequiredLive();
  assert.equal(result.exitCode, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, "LIVE_QUALIFIED");
  assert.equal(output.structureValid, true);
  assert.equal(output.artifactIntegrityValid, true);
  assert.equal(output.executionReconciled, true);
  assert.equal(output.liveQualified, true);
});

test("required-live timing authority derives the canary and full deadlines from their execution waves", () => {
  assert.deepEqual(
    EXPECTED_RUNS.map(({ name, maxWallClockMs }) => ({ name, maxWallClockMs })),
    [
      { name: "canary", maxWallClockMs: 360_000 },
      { name: "full", maxWallClockMs: 840_000 },
    ],
  );
});

test("required-live rejects the obsolete fixed five-minute full deadline", () => {
  const receipt = structuredClone(fixture.receipt);
  receipt.runs.find((run) => run.name === "full").maxWallClockMs = 300_000;
  assert.match(
    validateQualificationStructure(receipt, fixture.sourceSha).join("\n"),
    /full\.maxWallClockMs must be 840000/u,
  );
});

test("required-live rejects a persisted child deadline outside the shared timing contract", async () => {
  const planPath = join(
    fixture.full.runsRoot,
    "_swarms",
    fixture.full.swarmId,
    "plan.json",
  );
  const original = await readFile(planPath);
  const plan = JSON.parse(original);
  plan.agents[0].contract.maxWallClockMs = 60_000;
  await writeJson(planPath, plan);
  try {
    const result = await runRequiredLive();
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /child wall-clock limits.*shared Swarm timing contract/iu);
  } finally {
    await writeFile(planPath, original);
  }
});

test("ARTIFACT_INTEGRITY_VALID remains machine-distinct from LIVE_QUALIFIED", async () => {
  const result = await runValidator(["--decision", "artifact-integrity", fixture.receiptPath]);
  assert.equal(result.exitCode, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, "ARTIFACT_INTEGRITY_VALID");
  assert.equal(output.artifactIntegrityValid, true);
  assert.equal(output.liveQualified, false);
});

test("Q-01 self-authored binary cannot replace the externally approved package build", async () => {
  const original = await readFile(fixture.receiptPath); const value = JSON.parse(original);
  const fakeBinary = join(fixture.submittedRoot, "fake-martin.js"); await writeFile(fakeBinary, "console.log('fake')\n");
  value.binary = { path: fakeBinary, sha256: digest(await readFile(fakeBinary)), version: value.binary.version };
  await writeJson(fixture.receiptPath, value);
  try {
    const result = await runRequiredLive();
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /approved package build|binary|version/iu);
  } finally { await writeFile(fixture.receiptPath, original); }
});

test("Q-04 self-declared receipt version cannot replace approved package version", async () => {
  const original = await readFile(fixture.receiptPath); const value = JSON.parse(original);
  value.binary.version = "unapproved-version"; await writeJson(fixture.receiptPath, value);
  try {
    const result = await runRequiredLive();
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /approved package build|version/iu);
  } finally { await writeFile(fixture.receiptPath, original); }
});

for (const status of ["BLOCKED", "UNKNOWN", "FAIL", "BLOCKED_PENDING_APPROVAL"]) {
  test(`Q-05 ${status} can never qualify required-live evidence`, async () => {
    const original = await readFile(fixture.receiptPath);
    const value = JSON.parse(original); value.status = status; await writeJson(fixture.receiptPath, value);
    try {
      const result = await runRequiredLive();
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, new RegExp(status.replace("_", "."), "iu"));
      assert.doesNotMatch(result.stderr, /"decision"\s*:\s*"LIVE_QUALIFIED"/u);
    } finally { await writeFile(fixture.receiptPath, original); }
  });
}

const trustedCaptureCases = [
  ["Q-04 rejects an unsupported package version", "live-swarm-canary-capture.json", (value) => { value.executable.version = "unsupported"; }, /version|package build/iu],
  ["Q-06 rejects a cross-attempt child observation", "live-swarm-canary-capture.json", (value) => { value.children[0].attemptId = "attempt-from-another-run"; }, /attempt|identity/iu],
  ["Q-06 rejects a cross-workspace child observation", "live-swarm-canary-capture.json", (value) => { value.children[0].workspaceId = "workspace-from-another-run"; }, /workspace/iu],
  ["Q-06 rejects a cross-source child observation", "live-swarm-canary-capture.json", (value) => { value.children[0].workspaceSourceSha = "f".repeat(40); }, /source/iu],
  ["Q-08 rejects a simulated trusted execution claim", "live-swarm-canary-capture.json", (value) => { value.executionMode = "simulated"; }, /executionMode|governed/iu],
  ["Q-10 rejects ledger/dossier/budget observation inconsistency", "live-swarm-full-capture.json", (value) => { value.accounting.settledUsd += 1; }, /accounting/iu],
];

for (const [name, trustedName, mutate, expected] of trustedCaptureCases) {
  test(name, async () => {
    const path = join(fixture.trustRoot, trustedName);
    const original = await readFile(path);
    const value = JSON.parse(original);
    mutate(value);
    await writeJson(path, value);
    try {
      const result = await runRequiredLive();
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, expected);
      assert.doesNotMatch(result.stderr, /"decision"\s*:\s*"LIVE_QUALIFIED"/u);
    } finally { await writeFile(path, original); }
  });
}

test("Q-07 rejects forged terminal success and failed verifier authority", async () => {
  const path = join(fixture.canary.runsRoot, "_swarms", fixture.canary.swarmId, "evidence", "parent-receipt.json");
  const original = await readFile(path);
  const value = JSON.parse(original);
  value.parentOutcome.state = "verified";
  value.taskVerificationState = "passed";
  value.events.at(-1).type = "SWARM_STOPPED";
  await writeJson(path, value);
  try {
    const result = await runRequiredLive();
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /canonical|integrity|terminal|verify/iu);
  } finally { await writeFile(path, original); }
});

test("Q-07 rejects a genuine integrity-verified run whose authoritative verifier failed", async () => {
  const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const cliPath = join(ROOT, "dist", "bin", "martin-loop.js");
  const failedReceipt = qualificationReceipt({ runs: [fixture.failedCanary, fixture.full], sourceSha: fixture.sourceSha, cliPath, cliSha256: digest(await readFile(cliPath)), version: packageJson.version });
  await writeLiveSwarmTrustedDocuments({ root: fixture.root, runs: [fixture.failedCanary, fixture.full], sourceSha: fixture.sourceSha, sourceTree: fixture.sourceTree });
  await writeJson(fixture.receiptPath, failedReceipt);
  try {
    const result = await runRequiredLive();
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /verifier|task|parent|verified/iu);
  } finally {
    await writeLiveSwarmTrustedDocuments({ root: fixture.root, runs: [fixture.canary, fixture.full], sourceSha: fixture.sourceSha, sourceTree: fixture.sourceTree });
    await writeJson(fixture.receiptPath, fixture.receipt);
  }
});

test("Q-08 rejects missing explicit governed execution mode and provider event", async () => {
  const childId = fixture.canary.parent.childReceipts[0].childRunId;
  const path = join(fixture.canary.runsRoot, childId, "loop-record.json");
  const original = await readFile(path);
  const value = JSON.parse(original);
  delete value.metadata.executionMode;
  value.events = value.events.filter((event) => event.type !== "run.started");
  await writeJson(path, value);
  try {
    const result = await runRequiredLive();
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /canonical|integrity|executionMode|provider/iu);
  } finally { await writeFile(path, original); }
});

test("Q-09 rejects truncated or tampered receipt-integrity material", async () => {
  const childId = fixture.canary.parent.childReceipts[0].childRunId;
  const path = join(fixture.canary.runsRoot, childId, "receipt-integrity.json");
  const original = await readFile(path);
  await writeFile(path, original.subarray(0, Math.max(1, Math.floor(original.length / 2))));
  try {
    const result = await runRequiredLive();
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /canonical|integrity|receipt/iu);
  } finally { await writeFile(path, original); }
});

for (const mutation of ["duplicate", "reorder"]) {
  test(`Q-09 rejects ${mutation}d child ledger events`, async () => {
    const childId = fixture.canary.parent.childReceipts[0].childRunId;
    const path = join(fixture.canary.runsRoot, childId, "ledger.jsonl");
    const original = await readFile(path);
    const lines = original.toString("utf8").trimEnd().split("\n");
    const changed = mutation === "duplicate" ? [...lines, lines[0]] : [...lines].reverse();
    await writeFile(path, `${changed.join("\n")}\n`);
    try {
      const result = await runRequiredLive();
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /canonical|integrity|ledger/iu);
    } finally { await writeFile(path, original); }
  });
}

test("Q-09 rejects an integrity chain verified with the wrong external key", async () => {
  const path = join(
    fixture.trustRoot,
    "integrity-keys",
    digest(Buffer.from(fixture.canary.runsRoot)).slice(0, 16),
    `swarm-${fixture.canary.swarmId}.key`,
  );
  const original = await readFile(path);
  await writeFile(path, "wrong-external-key\n");
  try {
    const result = await runRequiredLive();
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /canonical|integrity|key/iu);
  } finally { await writeFile(path, original); }
});

for (const [name, mutate] of [
  ["missing accounting", (value) => { delete value.accounting.settledUsd; }],
  ["NaN accounting", (value) => { value.accounting.settledUsd = null; }],
  ["negative accounting", (value) => { value.accounting.settledUsd = -1; }],
  ["over-cap accounting", (value) => { value.accounting.settledUsd = 13; }],
]) {
  test(`Q-10 rejects ${name}`, async () => {
    const path = join(fixture.trustRoot, "live-swarm-full-capture.json");
    const original = await readFile(path); const value = JSON.parse(original); mutate(value); await writeJson(path, value);
    try {
      const result = await runRequiredLive();
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /accounting|budget|spend/iu);
    } finally { await writeFile(path, original); }
  });
}

test("Q-10 rejects duplicate canonical settlement material", async () => {
  const path = join(fixture.canary.runsRoot, "_swarms", fixture.canary.swarmId, "evidence", "parent-receipt.json");
  const original = await readFile(path); const value = JSON.parse(original);
  value.budgetLedger.leases.push(structuredClone(value.budgetLedger.leases[0]));
  await writeJson(path, value);
  try {
    const result = await runRequiredLive();
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /canonical|integrity|lease|settlement/iu);
  } finally { await writeFile(path, original); }
});

test("Q-11 rejects a hard-link alias in the external trust root", async () => {
  const path = join(fixture.trustRoot, "live-swarm-canary-capture.json");
  const backup = `${path}.original`;
  await rename(path, backup);
  await link(backup, path);
  try {
    const result = await runRequiredLive();
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /hard-link|alias/iu);
  } finally {
    await unlink(path);
    await rename(backup, path);
  }
});

test("Q-11 rejects an artifact path escape before consulting live authority", async () => {
  const original = await readFile(fixture.receiptPath); const value = JSON.parse(original);
  const escaped = join(fixture.root, "escaped-receipt.json"); await writeFile(escaped, "{}\n");
  value.runs[0].evidence.artifacts[0].path = escaped;
  value.runs[0].evidence.artifacts[0].sha256 = digest(await readFile(escaped));
  await writeJson(fixture.receiptPath, value);
  try {
    const result = await runRequiredLive();
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /escapes.*authorized root|artifact/iu);
  } finally { await writeFile(fixture.receiptPath, original); }
});

test("Q-11 immutable snapshot detects post-validation byte mutation", async () => {
  const root = await mkdtemp(join(TEST_TMPDIR, "live-swarm-post-validation-mutation-"));
  const path = join(root, "evidence.json"); await writeFile(path, "{}\n");
  const snapshots = [];
  await captureImmutableFileSnapshot(path, { root, label: "mutation fixture", snapshots });
  await writeFile(path, "{\"mutated\":true}\n");
  await assert.rejects(() => verifyImmutableFileSnapshots(snapshots), /post-validation/iu);
  await rm(root, { recursive: true, force: true });
});

test("Q-12 rejects correct persisted artifacts when external authorization is absent", async () => {
  const path = join(fixture.trustRoot, "live-swarm-authorization.json");
  const moved = `${path}.absent`;
  await rename(path, moved);
  try {
    const result = await runRequiredLive();
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /authorization|UNKNOWN|ENOENT/iu);
  } finally { await rename(moved, path); }
});

async function runRequiredLive() {
  return runValidator(["--decision", "required-live", "--trust-root", fixture.trustRoot, fixture.receiptPath]);
}
async function runValidator(args) {
  try {
    const result = await execFileAsync(process.execPath, [VALIDATOR, ...args], { cwd: ROOT });
    return { ...result, exitCode: 0 };
  } catch (error) { return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", exitCode: error.code }; }
}
async function writeJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
async function git(args) { return (await execFileAsync("git", args, { cwd: ROOT })).stdout; }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
