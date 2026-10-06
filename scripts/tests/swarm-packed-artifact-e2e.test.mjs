import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertCleanPackedSurface,
  createSafeArtifactReader,
  validatePackedArtifactReport,
  validateSwarmDemoPayload,
} from "../swarm-packed-artifact-e2e.mjs";

const SHA = "a".repeat(40);
const TARBALL = Buffer.from("canonical-packed-tarball");
const HASH = createHash("sha256").update(TARBALL).digest("hex");
const READ_TARBALL = (path) => {
  if (path !== "martin-loop-0.7.1.tgz") throw new Error(`missing ${path}`);
  return TARBALL;
};

function validDemo() {
  return {
    agents: 15,
    agentStatuses: Array.from({ length: 15 }, (_, index) => ({
      agentId: `agent-${String(index + 1).padStart(2, "0")}`,
      role: `Role ${index + 1}`,
      status: index === 5 ? "stopped" : "completed",
    })),
    events: [
      { type: "CHILD_PATCH_REJECTED", agentId: "agent-06", payload: { reason: "scope_creep", bytesAdmitted: 0 } },
      { type: "TASK_REASSIGNED", agentId: "agent-10", taskId: "task-06" },
      { type: "GLOBAL_VERIFIER_PASSED" },
      { type: "SWARM_VERIFIED" },
    ],
    providerMode: "deterministic_local",
    providerSpendUsd: 0,
    deniedChangesAdmitted: 0,
    reassignedTasks: 1,
    globalVerifier: { launched: true, completed: true, crashed: false, exitCode: 0, passed: true },
    parentOutcome: { state: "verified" },
  };
}

function validReport() {
  return {
    schemaVersion: "martin.swarm-packed-artifact.v1",
    status: "PASS",
    repository: { head: SHA, branch: "main" },
    package: {
      version: "0.7.1",
      tarballName: "martin-loop-0.7.1.tgz",
      tarball: { path: "martin-loop-0.7.1.tgz", sha256: HASH, bytes: TARBALL.byteLength },
    },
    providerPosture: { NEW_PROVIDER_RUNS: 0, NEW_PROVIDER_SPEND_USD: 0 },
    contamination: { status: "PASS", findings: [], inventoryCount: 10 },
    swarm: { status: "PASS", agentCount: 15, deniedScope: true, reassigned: true, parentAuthority: true, spendUsd: 0 },
    cleanup: { status: "PASS" },
    commands: ["legacy-help", "legacy-demo", "swarm-demo", "single-agent-e2e", "package-entrypoint", "mcp-pack-smoke"].map((id) => ({ id, status: "PASS", exitCode: 0 })),
  };
}

test("packed surface rejects planning, evidence, VCS, secrets, paths, and private language", () => {
  assert.doesNotThrow(() => assertCleanPackedSurface(["package/package.json"], [{ path: "package/README.md", text: "Public package" }]));
  for (const fixture of [
    { entries: ["package/.planning/STATE.md"], texts: [] },
    { entries: ["package/.release/evidence.json"], texts: [] },
    { entries: ["package/.git/config"], texts: [] },
    { entries: ["package/package.json"], texts: [{ path: "package/a.txt", text: "npm_token=secret-value" }] },
    { entries: ["package/package.json"], texts: [{ path: "package/a.txt", text: "C:\\Users\\operator\\repo" }] },
    { entries: ["package/package.json"], texts: [{ path: "package/a.txt", text: "/Users/operator/repo" }] },
    { entries: ["package/package.json"], texts: [{ path: "package/a.txt", text: `${["ML", "Core", "OSS", "Internal"].join("_")} internal planning` }] },
  ]) {
    assert.throws(() => assertCleanPackedSurface(fixture.entries, fixture.texts), /contamination/iu);
  }
});

test("swarm payload fails closed without fifteen agents or parent verifier authority", () => {
  assert.doesNotThrow(() => validateSwarmDemoPayload(validDemo()));
  assert.throws(() => validateSwarmDemoPayload({ ...validDemo(), agents: 14, agentStatuses: validDemo().agentStatuses.slice(0, 14) }), /15/iu);
  assert.throws(() => validateSwarmDemoPayload({ ...validDemo(), parentOutcome: { state: "verified" }, globalVerifier: { exitCode: 1 } }), /authority|verifier/iu);
});

test("packed report binds exact SHA, tarball, commands, swarm intervention, spend, and cleanup", () => {
  assert.deepEqual(validatePackedArtifactReport(validReport(), { expectedHead: SHA, readFile: READ_TARBALL }), { ok: true, errors: [] });
  for (const mutate of [
    (report) => { report.repository.head = "c".repeat(40); },
    (report) => { report.package.tarball.sha256 = "bad"; },
    (report) => { report.package.tarball.bytes += 1; },
    (report) => { report.package.tarball.path = "../escape.tgz"; },
    (report) => { report.swarm.agentCount = 14; },
    (report) => { report.swarm.deniedScope = false; },
    (report) => { report.swarm.reassigned = false; },
    (report) => { report.swarm.parentAuthority = false; },
    (report) => { report.providerPosture.NEW_PROVIDER_SPEND_USD = 1; },
    (report) => { report.cleanup.status = "UNKNOWN"; },
  ]) {
    const report = structuredClone(validReport());
    mutate(report);
    assert.equal(validatePackedArtifactReport(report, { expectedHead: SHA, readFile: READ_TARBALL }).ok, false);
  }
});

test("packed report rejects a hash-shaped claim when retained tarball bytes are absent or changed", () => {
  assert.equal(validatePackedArtifactReport(validReport(), { expectedHead: SHA }).ok, false);
  assert.equal(validatePackedArtifactReport(validReport(), { expectedHead: SHA, readFile: () => Buffer.from("tampered") }).ok, false);
});

test("retained tarball reader rejects a junction escape", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "packed-root-"));
  const outside = await mkdtemp(join(tmpdir(), "packed-outside-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeFile(join(outside, "martin-loop-0.7.1.tgz"), TARBALL);
  await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => createSafeArtifactReader(root)("linked/martin-loop-0.7.1.tgz"), /canonical|artifact/iu);
});
