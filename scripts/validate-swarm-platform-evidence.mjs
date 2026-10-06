#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSafeArtifactReader, validatePackedArtifactReport } from "./swarm-packed-artifact-e2e.mjs";

const EXPECTED_PAIRS = [
  ["ubuntu-latest", 20], ["ubuntu-latest", 24],
  ["macos-latest", 20], ["macos-latest", 24],
  ["windows-latest", 20], ["windows-latest", 24],
];
const EXPECTED_KEYS = EXPECTED_PAIRS.map(([os, node]) => `${os}@${node}`).sort();

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function currentHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim().toLowerCase();
}

function validateLocal(local, expectedHead, errors) {
  if (local?.status !== "PASS") errors.push("local qualification status is not PASS");
  if (local?.repository?.head !== expectedHead || local?.repository?.remoteHead !== expectedHead || local?.repository?.branch !== "main" || local?.repository?.trackedTreeClean !== true) errors.push("local qualification is not exact-SHA synchronized and clean");
  if (!Array.isArray(local?.gates) || local.gates.length === 0 || local.gates.some((gate) => gate?.status !== "PASS" || gate?.exitCode !== 0)) errors.push("local qualification contains a non-PASS gate");
}

function parsePayload(bytes, label, errors) {
  try {
    return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes);
  } catch (error) {
    errors.push(`${label} is malformed (${error instanceof Error ? error.message : String(error)})`);
  }
}

function validateLaneQualification(payload, manifest, expectedHead, label, errors) {
  if (payload?.schemaVersion !== "martin.swarm-local-qualification.v1" || payload?.status !== "PASS") errors.push(`${label}: lane qualification is not PASS v1 evidence`);
  if (payload?.repository?.head !== expectedHead || payload?.repository?.remoteHead !== expectedHead || payload?.repository?.branch !== "main" || payload?.repository?.trackedTreeClean !== true) errors.push(`${label}: lane qualification repository identity mismatch`);
  if (payload?.providerPosture?.NEW_PROVIDER_RUNS !== 0 || payload?.providerPosture?.NEW_PROVIDER_SPEND_USD !== 0) errors.push(`${label}: lane qualification provider posture is not zero`);
  if (JSON.stringify(payload?.selectedLanes) !== JSON.stringify(["platform"])) errors.push(`${label}: lane qualification is not the platform lane`);
  const sourceGates = Array.isArray(payload?.gates) ? payload.gates : [];
  const gates = sourceGates.filter((gate) => ["platform-worktrees", "platform-process-tree"].includes(gate?.id)).map((gate) => ({ id: gate.id, status: gate.status, exitCode: gate.exitCode }));
  if (sourceGates.length !== 2 || JSON.stringify(gates) !== JSON.stringify(manifest?.qualification?.gates)) errors.push(`${label}: lane qualification gates do not match manifest`);
}

export function validateSwarmPlatformEvidence(value, options = {}) {
  const errors = [];
  const { matrix, local, packed, readFile, fileHash, packedReadFile } = value;
  const expectedHead = options.expectedHead;
  if (!expectedHead || !/^[a-f0-9]{40}$/u.test(expectedHead)) errors.push("expected current HEAD is invalid");
  if (matrix?.schemaVersion !== "martin.swarm-platform-matrix.v1" || matrix?.status !== "PASS") errors.push("platform matrix is not PASS v1 evidence");
  if (matrix?.repository?.head !== expectedHead || matrix?.repository?.branch !== "main") errors.push("platform matrix repository identity mismatch");
  if (matrix?.workflow?.conclusion !== "success" || matrix?.workflow?.headSha !== expectedHead || matrix?.workflow?.headBranch !== "main" || matrix?.workflow?.runId === undefined) errors.push("workflow identity is not terminal success at exact main SHA");
  const lanes = Array.isArray(matrix?.lanes) ? matrix.lanes : [];
  const keys = lanes.map((lane) => `${lane?.os}@${lane?.node}`).sort();
  if (JSON.stringify(keys) !== JSON.stringify(EXPECTED_KEYS)) errors.push("matrix must contain exactly six unique OS/Node lanes");
  validateLocal(local, expectedHead, errors);
  const packedValidation = validatePackedArtifactReport(packed, { expectedHead, readFile: packedReadFile });
  if (!packedValidation.ok) errors.push(...packedValidation.errors.map((error) => `packed: ${error}`));

  for (const lane of lanes) {
    const label = `${lane?.os}@${lane?.node}`;
    if (lane?.conclusion !== "success") errors.push(`${label}: conclusion must be success`);
    let bytes;
    let manifest;
    try {
      bytes = readFile(lane.manifestPath);
      if (fileHash(lane.manifestPath) !== lane.manifestSha256) errors.push(`${label}: lane manifest hash mismatch`);
      manifest = parsePayload(bytes, `${label} lane manifest`, errors);
      if (!manifest) continue;
    } catch (error) {
      errors.push(`${label}: lane manifest missing or unreadable (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    if (manifest?.schemaVersion !== "martin.swarm-platform-lane.v1" || manifest?.status !== "PASS") errors.push(`${label}: lane manifest is not PASS v1 evidence`);
    if (manifest?.repository?.head !== expectedHead || manifest?.repository?.ref !== "main") errors.push(`${label}: lane repository identity mismatch`);
    if (String(manifest?.workflow?.runId) !== String(matrix?.workflow?.runId)) errors.push(`${label}: workflow run mismatch`);
    if (manifest?.runtime?.os !== lane.os || Number(manifest?.runtime?.node) !== Number(lane.node)) errors.push(`${label}: runtime identity mismatch`);
    const gates = Array.isArray(manifest?.qualification?.gates) ? manifest.qualification.gates : [];
    for (const gateId of ["platform-worktrees", "platform-process-tree"]) {
      const matching = gates.filter((gate) => gate?.id === gateId);
      if (matching.length !== 1 || matching[0].status !== "PASS" || matching[0].exitCode !== 0) errors.push(`${label}: ${gateId} is not uniquely PASS with exit 0`);
    }
    if (manifest?.qualification?.status !== "PASS" || manifest?.packed?.status !== "PASS") errors.push(`${label}: platform qualification or packed gate is not PASS`);
    if (manifest?.assertions?.realWorktree !== true || manifest?.assertions?.ownedChildGrandchildCleanup !== true || manifest?.assertions?.packedArtifact !== true) errors.push(`${label}: required real platform assertions are missing`);
    const qualificationPath = `${lane.artifactDir}/qualification.json`.replaceAll("\\", "/");
    const packedPath = `${lane.artifactDir}/packed-artifact.json`.replaceAll("\\", "/");
    try {
      const qualificationBytes = readFile(qualificationPath);
      if (hashBytes(qualificationBytes) !== manifest?.qualification?.sha256) errors.push(`${label}: lane qualification hash mismatch`);
      const qualification = parsePayload(qualificationBytes, `${label} lane qualification`, errors);
      if (qualification) validateLaneQualification(qualification, manifest, expectedHead, label, errors);
    } catch (error) {
      errors.push(`${label}: lane qualification missing or unreadable (${error instanceof Error ? error.message : String(error)})`);
    }
    try {
      const packedBytes = readFile(packedPath);
      if (hashBytes(packedBytes) !== manifest?.packed?.sha256) errors.push(`${label}: lane packed report hash mismatch`);
      const lanePacked = parsePayload(packedBytes, `${label} lane packed report`, errors);
      if (lanePacked) {
        const checked = validatePackedArtifactReport(lanePacked, {
          expectedHead,
          readFile: (relativePath) => readFile(`${lane.artifactDir}/${relativePath}`.replaceAll("\\", "/")),
        });
        if (!checked.ok) errors.push(...checked.errors.map((error) => `${label}: lane packed report: ${error}`));
      }
    } catch (error) {
      errors.push(`${label}: lane packed report missing or unreadable (${error instanceof Error ? error.message : String(error)})`);
    }
    for (const artifact of Array.isArray(manifest?.files) ? manifest.files : []) {
      const artifactPath = `${lane.artifactDir}/${artifact.path}`.replaceAll("\\", "/");
      try {
        if (fileHash(artifactPath) !== artifact.sha256) errors.push(`${label}: artifact hash mismatch for ${artifact.path}`);
      } catch {
        errors.push(`${label}: declared artifact missing for ${artifact.path}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function listFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll("\\", "/"));
  }
  return files;
}

function createLaneManifest(args) {
  const qualificationPath = path.resolve(args.qualification);
  const packedPath = path.resolve(args.packed);
  const outputPath = path.resolve(args.output);
  const root = path.dirname(outputPath);
  const qualification = JSON.parse(readFileSync(qualificationPath, "utf8"));
  const packed = JSON.parse(readFileSync(packedPath, "utf8"));
  const gates = qualification.gates?.filter((gate) => ["platform-worktrees", "platform-process-tree"].includes(gate.id)).map((gate) => ({ id: gate.id, status: gate.status, exitCode: gate.exitCode })) ?? [];
  if (qualification.status !== "PASS" || JSON.stringify(qualification.selectedLanes) !== JSON.stringify(["platform"]) || gates.length !== 2 || gates.some((gate) => gate.status !== "PASS" || gate.exitCode !== 0)) throw new Error("platform qualification is not exact PASS evidence");
  const packedValidation = validatePackedArtifactReport(packed, { expectedHead: args.head, readFile: createSafeArtifactReader(path.dirname(packedPath)) });
  if (!packedValidation.ok) throw new Error(`packed evidence invalid: ${packedValidation.errors.join("; ")}`);
  const manifest = {
    schemaVersion: "martin.swarm-platform-lane.v1",
    status: "PASS",
    repository: { head: args.head, ref: args.ref },
    workflow: { runId: args.run_id, runAttempt: Number(args.run_attempt) },
    runtime: { os: args.os, node: Number(args.node) },
    qualification: { status: "PASS", sha256: hashBytes(readFileSync(qualificationPath)), gates },
    packed: { status: "PASS", sha256: hashBytes(readFileSync(packedPath)) },
    assertions: { realWorktree: true, ownedChildGrandchildCleanup: true, packedArtifact: true },
    files: listFiles(root).filter((name) => name !== path.basename(outputPath)).map((name) => ({ path: name, sha256: hashBytes(readFileSync(path.join(root, name))) })),
  };
  mkdirSync(root, { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "w" });
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--create-lane" || token === "--require-current-head") result[token.slice(2).replaceAll("-", "_")] = true;
    else if (token.startsWith("--")) result[token.slice(2).replaceAll("-", "_")] = argv[++index];
  }
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.create_lane) {
    createLaneManifest(args);
    return;
  }
  const expectedHead = args.require_current_head ? currentHead() : JSON.parse(readFileSync(path.resolve(args.manifest), "utf8")).repository?.head;
  const artifactsDir = path.resolve(args.artifacts_dir);
  const readArtifactBytes = createSafeArtifactReader(artifactsDir);
  const packedRoot = path.dirname(path.resolve(args.packed));
  const result = validateSwarmPlatformEvidence({
    matrix: JSON.parse(readFileSync(path.resolve(args.manifest), "utf8")),
    local: JSON.parse(readFileSync(path.resolve(args.local), "utf8")),
    packed: JSON.parse(readFileSync(path.resolve(args.packed), "utf8")),
    readFile: readArtifactBytes,
    fileHash: (relative) => hashBytes(readArtifactBytes(relative)),
    packedReadFile: createSafeArtifactReader(packedRoot),
  }, { expectedHead });
  if (!result.ok) {
    for (const error of result.errors) process.stderr.write(`[swarm-platform-evidence] ${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({ status: "PASS", head: expectedHead, lanes: 6 })}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) {
    process.stderr.write(`[swarm-platform-evidence] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
