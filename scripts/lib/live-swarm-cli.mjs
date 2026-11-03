// SPDX-FileCopyrightText: MartinLoop contributors
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import {
  validateArtifactIntegrity,
  validateQualificationStructure,
  validateRequiredLiveQualification,
} from "./required-live-authority.mjs";

const execFileAsync = promisify(execFile);
const MODES = new Map([
  ["structure", "STRUCTURE_VALID"],
  ["artifact-integrity", "ARTIFACT_INTEGRITY_VALID"],
  ["required-live", "LIVE_QUALIFIED"],
]);

export async function runLiveSwarmQualificationValidator(argv, options = {}) {
  let parsed;
  try { parsed = parseArguments(argv); }
  catch (error) { return failure("FAIL", [message(error)], 2); }
  const repositoryRoot = await realpath(resolve(options.repositoryRoot ?? process.cwd()));
  let receipt;
  try { receipt = JSON.parse(await readFile(resolve(parsed.receiptPath), "utf8")); }
  catch (error) { return failure("FAIL", [`qualification receipt is unreadable JSON: ${message(error)}`], 1); }
  let head = "";
  try { ({ stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })); head = head.trim().toLowerCase(); }
  catch { return failure("UNKNOWN", ["candidate repository HEAD is unavailable"], 1); }

  const structureErrors = validateQualificationStructure(receipt, head);
  if (structureErrors.length > 0) return failure("FAIL", structureErrors, 1);
  if (parsed.decision === "structure") {
    return success("STRUCTURE_VALID", { structureValid: true, artifactIntegrityValid: false, executionReconciled: false, liveQualified: false });
  }

  const artifactErrors = await validateArtifactIntegrity(receipt, { repositoryRoot });
  if (artifactErrors.length > 0) return failure("FAIL", artifactErrors, 1, { structureValid: true });
  if (parsed.decision === "artifact-integrity") {
    return success("ARTIFACT_INTEGRITY_VALID", { structureValid: true, artifactIntegrityValid: true, executionReconciled: false, liveQualified: false });
  }

  const consistencyErrors = [];
  if (receipt.status !== "PASS") consistencyErrors.push(`submitted status ${String(receipt.status)} cannot qualify required-live evidence`);
  if (receipt.capability?.authStatus !== "PASS" || receipt.capability?.preflightStatus !== "PASS") consistencyErrors.push("submitted capability state is not live-ready");
  if (receipt.approval?.approved !== true) consistencyErrors.push("submitted approval state is not approved");
  if (consistencyErrors.length > 0) return failure("BLOCKED", consistencyErrors, 1, { structureValid: true, artifactIntegrityValid: true });
  if (!parsed.trustRoot) return failure("UNKNOWN", ["required-live mode requires --trust-root with external authorization and review evidence"], 1, { structureValid: true, artifactIntegrityValid: true });
  let result;
  try { result = await validateRequiredLiveQualification(receipt, { repositoryRoot, trustRoot: resolve(parsed.trustRoot) }); }
  catch (error) { return failure("UNKNOWN", [`external authoritative validation could not complete: ${message(error)}`], 1, { structureValid: true, artifactIntegrityValid: true }); }
  if (result.errors.length > 0) return failure(result.decision, result.errors, 1, { structureValid: true, artifactIntegrityValid: true });
  return success("LIVE_QUALIFIED", { structureValid: true, artifactIntegrityValid: true, executionReconciled: true, liveQualified: true });
}

export async function main(argv = process.argv.slice(2)) {
  const result = await runLiveSwarmQualificationValidator(argv);
  const stream = result.exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`${JSON.stringify(result.output, null, 2)}\n`);
  process.exitCode = result.exitCode;
  return result.exitCode;
}

function parseArguments(argv) {
  let decision; let trustRoot; let receiptPath;
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--decision" || token === "--trust-root") {
      if (seen.has(token)) throw new Error(`duplicate option is forbidden: ${token}`);
      seen.add(token);
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${token}`);
      if (token === "--decision") decision = value; else trustRoot = value;
      continue;
    }
    if (token.startsWith("--")) throw new Error(`unknown option: ${token}`);
    if (receiptPath) throw new Error("exactly one qualification receipt path is allowed");
    receiptPath = token;
  }
  if (!decision || !MODES.has(decision)) throw new Error("--decision must be exactly structure, artifact-integrity, or required-live");
  if (!receiptPath) throw new Error("qualification receipt path is required");
  if (decision !== "required-live" && trustRoot) throw new Error("--trust-root is accepted only for required-live mode");
  return { decision, trustRoot, receiptPath };
}

function success(decision, fields) { return { exitCode: 0, output: { decision, ...fields, errors: [] } }; }
function failure(decision, errors, exitCode, fields = {}) { return { exitCode, output: { decision, structureValid: false, artifactIntegrityValid: false, executionReconciled: false, liveQualified: false, ...fields, errors } }; }
function message(error) { return error instanceof Error ? error.message : String(error); }
