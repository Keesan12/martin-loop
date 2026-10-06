import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { validateSwarmPlatformEvidence } from "../validate-swarm-platform-evidence.mjs";

const HEAD = "a".repeat(40);
const HASH = (value) => createHash("sha256").update(value).digest("hex");
const TARBALL = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0x80, 0x7f, 0x42]);
const PAIRS = [
  ["ubuntu-latest", 20], ["ubuntu-latest", 24],
  ["macos-latest", 20], ["macos-latest", 24],
  ["windows-latest", 20], ["windows-latest", 24],
];

function packedReport() {
  return {
    schemaVersion: "martin.swarm-packed-artifact.v1",
    status: "PASS",
    repository: { head: HEAD, branch: "main" },
    package: {
      version: "0.7.1",
      tarballName: "martin-loop-0.7.1.tgz",
      tarball: { path: "martin-loop-0.7.1.tgz", sha256: HASH(TARBALL), bytes: TARBALL.byteLength },
    },
    providerPosture: { NEW_PROVIDER_RUNS: 0, NEW_PROVIDER_SPEND_USD: 0 },
    contamination: { status: "PASS", findings: [], inventoryCount: 1 },
    swarm: { status: "PASS", agentCount: 15, deniedScope: true, reassigned: true, parentAuthority: true, spendUsd: 0 },
    commands: ["legacy-help", "legacy-demo", "swarm-demo", "single-agent-e2e", "package-entrypoint", "mcp-pack-smoke"].map((id) => ({ id, status: "PASS", exitCode: 0 })),
    cleanup: { status: "PASS" },
  };
}

function platformQualification() {
  return {
    schemaVersion: "martin.swarm-local-qualification.v1",
    status: "PASS",
    repository: { head: HEAD, branch: "main", remoteHead: HEAD, trackedTreeClean: true },
    providerPosture: { NEW_PROVIDER_RUNS: 0, NEW_PROVIDER_SPEND_USD: 0 },
    selectedLanes: ["platform"],
    gates: [
      { id: "platform-worktrees", status: "PASS", exitCode: 0 },
      { id: "platform-process-tree", status: "PASS", exitCode: 0 },
    ],
  };
}

function fixture() {
  const files = new Map();
  const lanes = PAIRS.map(([os, node]) => {
    const artifactDir = `${os}-node-${node}`;
    const manifestPath = `${artifactDir}/lane-manifest.json`;
    const qualification = platformQualification();
    const packed = packedReport();
    const qualificationBytes = JSON.stringify(qualification);
    const packedBytes = JSON.stringify(packed);
    const manifest = {
      schemaVersion: "martin.swarm-platform-lane.v1",
      status: "PASS",
      repository: { head: HEAD, ref: "main" },
      workflow: { runId: 123, runAttempt: 1 },
      runtime: { os, node },
      qualification: { status: "PASS", sha256: HASH(qualificationBytes), gates: [
        { id: "platform-worktrees", status: "PASS", exitCode: 0 },
        { id: "platform-process-tree", status: "PASS", exitCode: 0 },
      ] },
      packed: { status: "PASS", sha256: HASH(packedBytes) },
      assertions: { realWorktree: true, ownedChildGrandchildCleanup: true, packedArtifact: true },
      files: [
        { path: "qualification.json", sha256: HASH(qualificationBytes) },
        { path: "packed-artifact.json", sha256: HASH(packedBytes) },
        { path: "martin-loop-0.7.1.tgz", sha256: HASH(TARBALL) },
      ],
    };
    const bytes = JSON.stringify(manifest);
    files.set(manifestPath, bytes);
    files.set(`${artifactDir}/qualification.json`, qualificationBytes);
    files.set(`${artifactDir}/packed-artifact.json`, packedBytes);
    files.set(`${artifactDir}/martin-loop-0.7.1.tgz`, TARBALL);
    return { os, node, conclusion: "success", artifactDir, manifestPath, manifestSha256: HASH(bytes) };
  });
  const matrix = {
    schemaVersion: "martin.swarm-platform-matrix.v1",
    status: "PASS",
    repository: { head: HEAD, branch: "main" },
    workflow: { runId: 123, conclusion: "success", headSha: HEAD, headBranch: "main" },
    lanes,
  };
  const local = { status: "PASS", repository: { head: HEAD, branch: "main", remoteHead: HEAD, trackedTreeClean: true }, gates: [{ status: "PASS", exitCode: 0 }] };
  const packed = packedReport();
  const readFile = (name) => {
    if (!files.has(name)) throw new Error(`missing ${name}`);
    return files.get(name);
  };
  const fileHash = (name) => HASH(readFile(name));
  return { matrix, local, packed, readFile, fileHash, packedReadFile: (name) => name === packed.package.tarball.path ? TARBALL : readFile(name), files };
}

function resealLanePayload(value, laneIndex, fileName, mutate) {
  const lane = value.matrix.lanes[laneIndex];
  const payloadPath = `${lane.artifactDir}/${fileName}`;
  const payload = JSON.parse(value.readFile(payloadPath));
  mutate(payload);
  const payloadBytes = JSON.stringify(payload);
  value.files.set(payloadPath, payloadBytes);
  const manifest = JSON.parse(value.readFile(lane.manifestPath));
  const binding = fileName === "qualification.json" ? manifest.qualification : manifest.packed;
  binding.sha256 = HASH(payloadBytes);
  manifest.files.find((entry) => entry.path === fileName).sha256 = HASH(payloadBytes);
  const manifestBytes = JSON.stringify(manifest);
  value.files.set(lane.manifestPath, manifestBytes);
  lane.manifestSha256 = HASH(manifestBytes);
}

test("accepts exactly six terminal successful exact-SHA lanes with hashed artifacts", () => {
  assert.deepEqual(validateSwarmPlatformEvidence(fixture(), { expectedHead: HEAD }), { ok: true, errors: [] });
});

test("rejects missing and duplicate OS/Node lanes", () => {
  const missing = fixture();
  missing.matrix.lanes.pop();
  assert.equal(validateSwarmPlatformEvidence(missing, { expectedHead: HEAD }).ok, false);
  const duplicate = fixture();
  duplicate.matrix.lanes[5] = structuredClone(duplicate.matrix.lanes[0]);
  assert.equal(validateSwarmPlatformEvidence(duplicate, { expectedHead: HEAD }).ok, false);
});

test("rejects stale SHA, every non-success conclusion, missing cleanup assertions, and hash mismatch", () => {
  for (const mutate of [
    (value) => { value.matrix.repository.head = "d".repeat(40); },
    (value) => { value.matrix.lanes[0].conclusion = "queued"; },
    (value) => { value.matrix.lanes[0].conclusion = "cancelled"; },
    (value) => { value.matrix.lanes[0].conclusion = "timed_out"; },
    (value) => {
      const path = value.matrix.lanes[0].manifestPath;
      const manifest = JSON.parse(value.readFile(path));
      manifest.assertions.ownedChildGrandchildCleanup = false;
      const bytes = JSON.stringify(manifest);
      const previousRead = value.readFile;
      value.readFile = (name) => name === path ? bytes : previousRead(name);
      value.matrix.lanes[0].manifestSha256 = HASH(bytes);
    },
    (value) => { value.matrix.lanes[0].manifestSha256 = "f".repeat(64); },
  ]) {
    const value = fixture();
    mutate(value);
    assert.equal(validateSwarmPlatformEvidence(value, { expectedHead: HEAD }).ok, false);
  }
});

test("rejects tampered lane-native qualification and packed payloads even when the lane is resealed", () => {
  const qualification = fixture();
  resealLanePayload(qualification, 0, "qualification.json", (payload) => { payload.repository.head = "d".repeat(40); });
  assert.equal(validateSwarmPlatformEvidence(qualification, { expectedHead: HEAD }).ok, false);

  const packed = fixture();
  resealLanePayload(packed, 0, "packed-artifact.json", (payload) => { payload.swarm.deniedScope = false; });
  assert.equal(validateSwarmPlatformEvidence(packed, { expectedHead: HEAD }).ok, false);
});

test("rejects FAIL, BLOCKED, or UNKNOWN local and packed evidence", () => {
  for (const status of ["FAIL", "BLOCKED", "UNKNOWN"]) {
    const local = fixture();
    local.local.status = status;
    assert.equal(validateSwarmPlatformEvidence(local, { expectedHead: HEAD }).ok, false);
    const packed = fixture();
    packed.packed.status = status;
    assert.equal(validateSwarmPlatformEvidence(packed, { expectedHead: HEAD }).ok, false);
  }
});

test("shared release workflow preserves release validation without private Swarm qualification", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/platform-release-validation.yml", import.meta.url), "utf8");
  assert.match(workflow, /platform-release-validation:[\s\S]*node \.\/scripts\/release-matrix\.mjs/u);
  assert.doesNotMatch(workflow, /swarm-platform-validation|swarm-qualification\.mjs|swarm-packed-artifact-e2e\.mjs/u);
});
