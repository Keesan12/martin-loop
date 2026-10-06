// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

import {
  buildSwarmShareProjection,
  readSwarmDossier,
  readSwarmOperationalState,
  redactSecretsFromText,
  verifySwarmEvidence,
  type SwarmDossierProjection,
  type SwarmEvidenceSelector,
  type SwarmEvidenceVerification,
  type SwarmShareProjection,
} from "@martin/core";
import type { MartinOutputMode } from "@martin/contracts";

import { resolveCliEnvironment } from "./run-store.js";
import { CliCommandError, renderCliSuccess } from "./ux.js";
import {
  renderSwarmInspectHuman,
  renderSwarmDossierHuman,
  renderSwarmVerifyHuman,
  toSwarmInspectData,
  toSwarmDossierData,
  toSwarmVerifyData,
} from "./swarm-evidence-renderer.js";

export type SwarmOperationalCommandRequest = {
  runsDir?: string;
} & ({ swarmId: string; latest?: never } | { latest: true; swarmId?: never });

export type SwarmEvidenceCommandRequest = {
  runsDir?: string;
} & ({ swarmId: string; latest?: never } | { latest: true; swarmId?: never });

export type SwarmShareCommandRequest = SwarmEvidenceCommandRequest & { outputDir: string };

export type ParsedPublicSwarmCommand =
  | { command: "swarm_inspect"; request: SwarmOperationalCommandRequest }
  | { command: "swarm_dossier"; request: SwarmEvidenceCommandRequest }
  | { command: "swarm_verify"; request: SwarmEvidenceCommandRequest }
  | { command: "swarm_share"; request: SwarmShareCommandRequest };

export interface SwarmEvidenceCommandDependencies {
  readSwarmDossier(input: SwarmEvidenceSelector): Promise<SwarmDossierProjection>;
  verifySwarmEvidence(input: SwarmEvidenceSelector): Promise<SwarmEvidenceVerification>;
  buildSwarmShareProjection(input: SwarmEvidenceSelector): Promise<SwarmShareProjection>;
}

export interface SwarmSharePublicationHooks {
  afterInitialValidation?(): Promise<void>;
  beforeCommit?(): Promise<void>;
  afterFinalValidation?(): Promise<void>;
  afterDestinationClaim?(): Promise<void>;
}

const productionEvidenceDependencies: SwarmEvidenceCommandDependencies = {
  readSwarmDossier,
  verifySwarmEvidence,
  buildSwarmShareProjection,
};

export function parsePublicSwarmCommandArguments(args: string[]): ParsedPublicSwarmCommand {
  const [subcommand, ...rest] = args;
  if (subcommand === "inspect") return { command: "swarm_inspect", request: parseInspectCommand(rest) };
  if (subcommand === "dossier" || subcommand === "verify") {
    const request = parseEvidenceSelector(subcommand, rest);
    return subcommand === "dossier" ? { command: "swarm_dossier", request } : { command: "swarm_verify", request };
  }
  if (subcommand === "share") return { command: "swarm_share", request: parseShareCommand(rest) };
  throw new CliCommandError("invalid_input", `Unknown swarm subcommand: ${subcommand ?? "<missing>"}.`, {
    suggestion: "Use `martin-loop demo --swarm` or a provider-free evidence command.",
  });
}

function parseInspectCommand(args: string[]): SwarmOperationalCommandRequest {
  const values = readOptions("inspect", args, new Set(["--swarm-id", "--latest", "--runs-dir"]), new Set(["--latest"]));
  const swarmId = values.get("--swarm-id");
  const latest = values.get("--latest") === true;
  if ((typeof swarmId === "string") === latest) throw new CliCommandError("invalid_input", "swarm inspect requires exactly one selector: --swarm-id <id> or --latest.");
  return {
    ...(typeof swarmId === "string" ? { swarmId } : { latest: true as const }),
    ...(typeof values.get("--runs-dir") === "string" ? { runsDir: values.get("--runs-dir") as string } : {}),
  };
}

function parseShareCommand(args: string[]): SwarmShareCommandRequest {
  const values = readOptions("share", args, new Set(["--id", "--latest", "--runs-dir", "--out-dir"]), new Set(["--latest"]));
  const request = parseEvidenceValues("share", values);
  const outputDir = values.get("--out-dir");
  if (typeof outputDir !== "string") throw new CliCommandError("invalid_input", "swarm share requires --out-dir <directory>.");
  return { ...request, outputDir };
}

function parseEvidenceSelector(subcommand: "dossier" | "verify", args: string[]): SwarmEvidenceCommandRequest {
  return parseEvidenceValues(subcommand, readOptions(subcommand, args, new Set(["--id", "--latest", "--runs-dir"]), new Set(["--latest"])));
}

function parseEvidenceValues(subcommand: "dossier" | "verify" | "share", values: Map<string, string | true>): SwarmEvidenceCommandRequest {
  const swarmId = values.get("--id");
  const latest = values.get("--latest") === true;
  if ((typeof swarmId === "string") === latest) throw new CliCommandError("invalid_input", `swarm ${subcommand} requires exactly one selector: --id <id> or --latest.`);
  return {
    ...(typeof swarmId === "string" ? { swarmId } : { latest: true as const }),
    ...(typeof values.get("--runs-dir") === "string" ? { runsDir: values.get("--runs-dir") as string } : {}),
  };
}

function readOptions(subcommand: string, args: string[], allowed: ReadonlySet<string>, booleans: ReadonlySet<string>): Map<string, string | true> {
  const values = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!allowed.has(flag)) throw new CliCommandError("invalid_input", `Unsupported swarm ${subcommand} argument: ${flag}.`);
    if (values.has(flag)) throw new CliCommandError("invalid_input", `Duplicate swarm ${subcommand} option: ${flag}.`);
    if (booleans.has(flag)) { values.set(flag, true); continue; }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new CliCommandError("invalid_input", `${flag} requires a value.`);
    values.set(flag, value);
    index += 1;
  }
  return values;
}

export async function executeSwarmInspectCommand(
  request: SwarmOperationalCommandRequest,
  outputMode: MartinOutputMode,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const runsRoot = resolveCliEnvironment({ runsDir: request.runsDir }).runsRoot;
  try {
    const state = await readSwarmOperationalState("swarmId" in request && request.swarmId !== undefined
      ? { runsRoot, swarmId: request.swarmId }
      : { runsRoot, latest: true });
    const data = toSwarmInspectData(state);
    return renderCliSuccess(outputMode, { data, human: renderSwarmInspectHuman(data), quiet: data.swarmId });
  } catch (error) {
    throw mapOperationalError(error);
  }
}


export async function executeSwarmDossierCommand(
  request: SwarmEvidenceCommandRequest,
  outputMode: MartinOutputMode,
  dependencies: SwarmEvidenceCommandDependencies = productionEvidenceDependencies,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const selector = toEvidenceSelector(request);
  try {
    const dossier = await dependencies.readSwarmDossier(selector);
    const data = toSwarmDossierData(dossier);
    return renderCliSuccess(outputMode, {
      data,
      human: renderSwarmDossierHuman(data),
      quiet: data.swarmId,
    });
  } catch (error) {
    throw mapEvidenceError(error);
  }
}

export async function executeSwarmVerifyCommand(
  request: SwarmEvidenceCommandRequest,
  outputMode: MartinOutputMode,
  dependencies: SwarmEvidenceCommandDependencies = productionEvidenceDependencies,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const selector = toEvidenceSelector(request);
  try {
    const verification = await dependencies.verifySwarmEvidence(selector);
    const data = toSwarmVerifyData(verification);
    return renderCliSuccess(outputMode, {
      data,
      human: renderSwarmVerifyHuman(data),
      quiet: data.verified ? "verified" : "not_verified",
      exitCode: data.verified ? 0 : 7,
    });
  } catch (error) {
    throw mapEvidenceError(error);
  }
}

export async function executeSwarmShareCommand(
  request: SwarmShareCommandRequest,
  outputMode: MartinOutputMode,
  dependencies: SwarmEvidenceCommandDependencies = productionEvidenceDependencies,
  publicationHooks: SwarmSharePublicationHooks = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    // Trust is established before any output path is inspected or created.
    const selector = toEvidenceSelector(request);
    const projection = await dependencies.buildSwarmShareProjection(selector);
    const published = await publishSwarmShareBundle(
      projection,
      request.outputDir,
      selector.runsRoot,
      publicationHooks,
    );
    return renderCliSuccess(outputMode, {
      data: {
        command: "swarm share",
        swarmId: projection.swarmId,
        outputDir: published.outputDir,
        files: published.files,
      },
      human: [
        `Verified swarm share bundle written for ${projection.swarmId}.`,
        `Output directory: ${published.outputDir}`,
        `Receipt JSON: ${published.files.receiptJson}`,
        `Proof Markdown: ${published.files.proofMarkdown}`,
        `Proof SVG: ${published.files.proofSvg}`,
      ],
      quiet: published.outputDir,
    });
  } catch (error) {
    throw mapEvidenceError(error);
  }
}

async function publishSwarmShareBundle(
  projection: SwarmShareProjection,
  requestedOutputDir: string,
  runsRoot: string,
  hooks: SwarmSharePublicationHooks,
): Promise<{
  outputDir: string;
  files: { receiptJson: string; proofMarkdown: string; proofSvg: string };
}> {
  const outputDir = resolve(requestedOutputDir);
  const requestedParent = dirname(outputDir);
  const parentIdentity = await readCanonicalShareParent(requestedParent);
  await assertShareOutsideRunsRoot(outputDir, runsRoot);
  await assertShareOutputAbsent(outputDir);
  await hooks.afterInitialValidation?.();
  await assertCanonicalShareParent(requestedParent, parentIdentity);
  const artifactNames = {
    receiptJson: "swarm-receipt.json",
    proofMarkdown: "swarm-proof.md",
    proofSvg: "swarm-proof.svg",
  } as const;
  const artifactBytes = {
    receiptJson: `${JSON.stringify(projection, null, 2)}\n`,
    proofMarkdown: renderSwarmShareMarkdown(projection),
    proofSvg: renderSwarmShareSvg(projection),
  };
  await assertCanonicalShareParent(requestedParent, parentIdentity);
  await assertShareOutputAbsent(outputDir);
  await hooks.beforeCommit?.();
  await assertCanonicalShareParent(requestedParent, parentIdentity);
  await assertShareOutputAbsent(outputDir);
  await hooks.afterFinalValidation?.();
  await assertCanonicalShareParent(requestedParent, parentIdentity);
  const outputIdentity = await publishShareInPinnedChild({
    parent: parentIdentity,
    outputName: basename(outputDir),
    artifacts: Object.fromEntries(
      (Object.keys(artifactNames) as Array<keyof typeof artifactNames>)
        .map((key) => [artifactNames[key], artifactBytes[key]]),
    ),
  }, hooks.afterDestinationClaim);
  await assertCanonicalShareOutput(outputDir, outputIdentity);
  return {
    outputDir,
    files: {
      receiptJson: join(outputDir, artifactNames.receiptJson),
      proofMarkdown: join(outputDir, artifactNames.proofMarkdown),
      proofSvg: join(outputDir, artifactNames.proofSvg),
    },
  };
}

const PINNED_SHARE_WRITER = String.raw`
const fs = require("node:fs");
(() => {
const expectedDevice = Number(process.argv[1]);
const expectedInode = Number(process.argv[2]);
const outputName = process.argv[3];
const respond = (value, code) => {
  process.stdout.write(JSON.stringify(value) + "\n");
  process.exitCode = code;
};
const parent = fs.statSync(".");
if (parent.dev !== expectedDevice || parent.ino !== expectedInode) {
  respond({ state: "failed", code: "PARENT_IDENTITY_MISMATCH" }, 2);
} else {
  try {
    fs.mkdirSync(outputName, { mode: 0o700 });
    process.chdir(outputName);
  } catch (error) {
    respond({ state: "failed", code: error && error.code === "EEXIST" ? "OUTPUT_EXISTS" : "CLAIM_FAILED" }, 2);
    return;
  }
  const output = fs.statSync(".");
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    let request;
    try {
      request = JSON.parse(input);
    } catch {
      respond({ state: "failed", code: "INVALID_INPUT" }, 2);
      return;
    }
    if (request.abort === true) {
      respond({ state: "failed", code: "ABORTED", device: output.dev, inode: output.ino }, 2);
      return;
    }
    const artifacts = request.artifacts;
  const created = [];
  const writeExclusive = (name, bytes) => {
    const descriptor = fs.openSync(name, "wx", 0o600);
    created.push(name);
    try {
      fs.writeFileSync(descriptor, bytes);
    } finally {
      fs.closeSync(descriptor);
    }
  };
  try {
    writeExclusive(".martin-share-incomplete", "");
    for (const [name, bytes] of Object.entries(artifacts)) {
      writeExclusive(name, bytes);
    }
    fs.unlinkSync(".martin-share-incomplete");
    respond({ state: "published", device: output.dev, inode: output.ino }, 0);
  } catch {
    for (const name of created.reverse()) {
      try { fs.unlinkSync(name); } catch {}
    }
    respond({ state: "failed", code: "WRITE_FAILED", device: output.dev, inode: output.ino }, 2);
  }
  });
  respond({ state: "claimed", device: output.dev, inode: output.ino }, 0);
}
})();
`;

async function publishShareInPinnedChild(input: {
  parent: CanonicalShareParent;
  outputName: string;
  artifacts: Record<string, string>;
}, afterDestinationClaim?: () => Promise<void>): Promise<CanonicalShareOutput> {
  if (!input.outputName || input.outputName === "." || input.outputName === "..") {
    throw codedShareError("SWARM_SHARE_OUTPUT_ALIAS", "Swarm share output name is unsafe.");
  }
  const child = spawn(process.execPath, [
    "-e",
    PINNED_SHARE_WRITER,
    String(input.parent.device),
    String(input.parent.inode),
    input.outputName,
  ], {
    cwd: input.parent.path,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.on("error", () => undefined);
  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  const iterator = lines[Symbol.asyncIterator]();
  const completion = new Promise<number>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code) => resolvePromise(code ?? 2));
  });
  const first = await iterator.next();
  if (first.done) {
    child.stdin.end();
    await completion;
    void stderr;
    throw codedShareError("SWARM_SHARE_PUBLICATION_FAILED", "Pinned swarm share writer did not claim a destination.");
  }
  stdout += first.value;
  let claimed: { state?: unknown; code?: unknown; device?: unknown; inode?: unknown };
  try {
    claimed = JSON.parse(first.value) as typeof claimed;
  } catch {
    child.stdin.end();
    await completion;
    void stderr;
    throw codedShareError("SWARM_SHARE_PUBLICATION_FAILED", "Pinned swarm share writer returned malformed output.");
  }
  if (claimed.state !== "claimed") {
    child.stdin.end();
    await completion;
    if (claimed.code === "OUTPUT_EXISTS") {
      throw codedShareError("SWARM_SHARE_PUBLICATION_CONFLICT", "Swarm share destination was claimed by another publisher.");
    }
    if (claimed.code === "PARENT_IDENTITY_MISMATCH") {
      throw codedShareError("SWARM_SHARE_OUTPUT_ALIAS", "Swarm share output parent changed before publication.");
    }
    throw codedShareError("SWARM_SHARE_PUBLICATION_FAILED", "Pinned swarm share writer failed closed.");
  }
  let hookError: unknown;
  try {
    await afterDestinationClaim?.();
  } catch (error) {
    hookError = error;
  }
  child.stdin.end(JSON.stringify(hookError ? { abort: true } : { artifacts: input.artifacts }));
  const final = await iterator.next();
  const exitCode = await completion;
  lines.close();
  if (hookError) {
    throw codedShareError("SWARM_SHARE_OUTPUT_ALIAS", "Swarm share destination could not remain pinned during publication.");
  }
  if (final.done) {
    throw codedShareError("SWARM_SHARE_PUBLICATION_FAILED", "Pinned swarm share writer omitted its final state.");
  }
  stdout += final.value;
  let result: { state?: unknown; code?: unknown; device?: unknown; inode?: unknown };
  try {
    result = JSON.parse(final.value) as typeof result;
  } catch {
    void stdout;
    void stderr;
    throw codedShareError("SWARM_SHARE_PUBLICATION_FAILED", "Pinned swarm share writer returned malformed output.");
  }
  if (exitCode !== 0 || result.state !== "published") {
    throw codedShareError("SWARM_SHARE_PUBLICATION_FAILED", "Pinned swarm share writer failed closed.");
  }
  if (!Number.isFinite(result.device) || !Number.isFinite(result.inode)) {
    throw codedShareError("SWARM_SHARE_PUBLICATION_FAILED", "Pinned swarm share writer omitted output identity.");
  }
  return {
    path: join(input.parent.path, input.outputName),
    device: Number(result.device),
    inode: Number(result.inode),
  };
}

interface CanonicalShareParent {
  path: string;
  device: number;
  inode: number;
}

interface CanonicalShareOutput {
  path: string;
  device: number;
  inode: number;
}

async function readCanonicalShareParent(requestedParent: string): Promise<CanonicalShareParent> {
  const metadata = await lstat(requestedParent);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw codedShareError("SWARM_SHARE_OUTPUT_ALIAS", "Swarm share output parent must be a canonical directory.");
  }
  const canonical = await realpath(requestedParent);
  if (!sameFilesystemPath(canonical, requestedParent)) {
    throw codedShareError("SWARM_SHARE_OUTPUT_ALIAS", "Swarm share output parent may not use a path alias.");
  }
  const canonicalMetadata = await stat(canonical);
  return { path: canonical, device: canonicalMetadata.dev, inode: canonicalMetadata.ino };
}

async function assertCanonicalShareParent(
  requestedParent: string,
  expected: CanonicalShareParent,
): Promise<void> {
  const current = await readCanonicalShareParent(requestedParent);
  if (
    !sameFilesystemPath(current.path, expected.path)
    || current.device !== expected.device
    || current.inode !== expected.inode
  ) {
    throw codedShareError("SWARM_SHARE_OUTPUT_ALIAS", "Swarm share output parent changed during publication.");
  }
}

async function readCanonicalShareOutput(
  outputDir: string,
  parent: CanonicalShareParent,
): Promise<CanonicalShareOutput> {
  const metadata = await lstat(outputDir);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw codedShareError("SWARM_SHARE_OUTPUT_ALIAS", "Swarm share output claim is not an exact directory.");
  }
  const canonical = await realpath(outputDir);
  const relation = relative(parent.path, canonical);
  if (
    !sameFilesystemPath(canonical, outputDir)
    || relation === ""
    || relation.startsWith("..")
    || isAbsolute(relation)
  ) {
    throw codedShareError("SWARM_SHARE_OUTPUT_ALIAS", "Swarm share output claim escaped its canonical parent.");
  }
  const canonicalMetadata = await stat(canonical);
  return { path: canonical, device: canonicalMetadata.dev, inode: canonicalMetadata.ino };
}

async function assertCanonicalShareOutput(
  outputDir: string,
  expected: CanonicalShareOutput,
): Promise<void> {
  const metadata = await lstat(outputDir);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw codedShareError("SWARM_SHARE_OUTPUT_ALIAS", "Swarm share output claim changed during publication.");
  }
  const canonical = await realpath(outputDir);
  const canonicalMetadata = await stat(canonical);
  if (
    !sameFilesystemPath(canonical, expected.path)
    || canonicalMetadata.dev !== expected.device
    || canonicalMetadata.ino !== expected.inode
  ) {
    throw codedShareError("SWARM_SHARE_OUTPUT_ALIAS", "Swarm share output claim changed during publication.");
  }
}

async function assertShareOutsideRunsRoot(outputDir: string, requestedRunsRoot: string): Promise<void> {
  let runsRoot = resolve(requestedRunsRoot);
  try {
    const metadata = await lstat(runsRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw codedShareError("SWARM_SHARE_OUTPUT_ALIAS", "Swarm runs root must be a canonical directory.");
    }
    runsRoot = await realpath(runsRoot);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  const relation = relative(runsRoot, outputDir);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
    throw codedShareError("SWARM_SHARE_OUTPUT_IN_STORE", "Swarm share output must be outside the canonical runs store.");
  }
}

async function assertShareOutputAbsent(outputDir: string): Promise<void> {
  if (await pathExists(outputDir)) {
    throw codedShareError("SWARM_SHARE_OUTPUT_EXISTS", "Swarm share output directory already exists and will not be overwritten.");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function renderSwarmShareMarkdown(projection: SwarmShareProjection): string {
  return [
    "# MartinLoop Swarm Proof",
    "",
    `- Swarm: \`${projection.swarmId}\``,
    `- Outcome: **${projection.parentOutcomeState.toUpperCase()}**`,
    `- Receipt integrity: **${projection.integrityState.toUpperCase()}**`,
    `- Task verification: **${projection.taskVerificationState.toUpperCase()}**`,
    `- Receipt: \`${projection.receiptId}\``,
    `- Plan hash: \`${projection.planHash}\``,
    `- Baseline: \`${projection.baselineCommit}\``,
    `- Tasks accepted: ${projection.taskCounts.accepted ?? 0}/${projection.taskCounts.total}`,
    `- Agents verified: ${projection.agentCounts.verified ?? 0}/${projection.agentCounts.total}`,
    `- Budget settled: $${projection.budget.settledUsd.toFixed(2)} of $${projection.budget.capUsd.toFixed(2)}`,
    `- Sealed: ${projection.generatedAt}`,
    "",
    "This local proof is derived from the independently verified parent receipt and its committed evidence seal.",
    "",
  ].join("\n");
}

function renderSwarmShareSvg(projection: SwarmShareProjection): string {
  const swarmId = escapeXml(projection.swarmId);
  const receiptId = escapeXml(projection.receiptId);
  const sealedAt = escapeXml(projection.generatedAt);
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="360" viewBox="0 0 960 360" role="img" aria-label="MartinLoop verified swarm proof">',
    '  <rect width="960" height="360" rx="24" fill="#10131a"/>',
    '  <text x="48" y="72" fill="#8ef0c8" font-family="ui-monospace, monospace" font-size="24">MARTINLOOP SWARM</text>',
    '  <text x="48" y="128" fill="#ffffff" font-family="ui-monospace, monospace" font-size="38" font-weight="700">VERIFIED</text>',
    `  <text x="48" y="178" fill="#d5d9e3" font-family="ui-monospace, monospace" font-size="18">${swarmId}</text>`,
    `  <text x="48" y="220" fill="#aab2c2" font-family="ui-monospace, monospace" font-size="16">Receipt ${receiptId}</text>`,
    `  <text x="48" y="260" fill="#aab2c2" font-family="ui-monospace, monospace" font-size="16">Integrity VERIFIED · Tasks PASSED · Parent VERIFIED</text>`,
    `  <text x="48" y="308" fill="#747f94" font-family="ui-monospace, monospace" font-size="14">Sealed ${sealedAt}</text>`,
    '</svg>',
    '',
  ].join("\n");
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function sameFilesystemPath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === resolve(right).toLowerCase() : left === resolve(right);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function codedShareError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function toEvidenceSelector(request: SwarmEvidenceCommandRequest): SwarmEvidenceSelector {
  const runsRoot = resolveCliEnvironment({ runsDir: request.runsDir }).runsRoot;
  return "swarmId" in request && request.swarmId !== undefined
    ? { runsRoot, swarmId: request.swarmId }
    : { runsRoot, latest: true };
}

function mapEvidenceError(error: unknown): unknown {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "") : "";
  if (code === "MISSING_SWARM_STORE") {
    return new CliCommandError("not_found", "No matching swarm evidence store was found.");
  }
  if ([
    "ENOENT", "ENOTDIR", "MALFORMED_JSON", "MALFORMED_EVENT_LOG", "EVENT_CLAIM_GAP",
    "MISSING_EVENT_CLAIM", "MISSING_PLAN", "MISSING_EVENTS", "MISSING_START_CLAIM",
  ].includes(code)) {
    return new CliCommandError("store_unreadable", "Swarm evidence is missing, malformed, or unreadable.");
  }
  if ([
    "SWARM_SHARE_OUTPUT_EXISTS", "SWARM_SHARE_OUTPUT_ALIAS", "SWARM_SHARE_OUTPUT_IN_STORE",
    "SWARM_SHARE_PUBLICATION_CONFLICT",
  ].includes(code)) {
    return new CliCommandError("policy_blocked", redactSecretsFromText(error instanceof Error ? error.message : "Unsafe share output path."));
  }
  if ([
    "SWARM_SEAL_COMMIT_MISMATCH", "SWARM_SEAL_INTEGRITY_FAILED", "SWARM_SEAL_KEY_UNAVAILABLE",
    "EVIDENCE_INDEX_CONFLICT", "SWARM_SHARE_NOT_VERIFIED",
  ].includes(code)) {
    return new CliCommandError("verification_failed", "Swarm evidence did not pass independent verification.");
  }
  if ([
    "SWARM_SEAL_PATH_ALIAS", "STORE_PATH_ESCAPE", "LIVE_SWARM_PATH_ESCAPE",
    "UNSAFE_FILENAME_ID", "INVALID_SWARM_ID",
  ].includes(code)) {
    return new CliCommandError("policy_blocked", "Unsafe swarm evidence path or selector was rejected.");
  }
  if (code === "SWARM_SHARE_PUBLICATION_FAILED") {
    return new CliCommandError("store_unreadable", "Swarm share publication failed closed.");
  }
  return mapKnownSwarmError(error, "evidence_read");
}

function mapOperationalError(error: unknown): unknown {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "") : "";
  if (code === "MISSING_SWARM_STORE") return new CliCommandError("not_found", "No matching live swarm store was found.");
  if (["UNSAFE_FILENAME_ID", "INVALID_SWARM_ID", "STORE_PATH_ESCAPE"].includes(code)) {
    return new CliCommandError("policy_blocked", redactSecretsFromText(error instanceof Error ? error.message : "Unsafe swarm selector."));
  }
  if (["MALFORMED_JSON", "MALFORMED_EVENT_LOG", "EVENT_CLAIM_GAP", "MISSING_EVENT_CLAIM", "MISSING_PLAN", "INVALID_PLAN"].includes(code)) {
    return new CliCommandError("store_unreadable", "Swarm operational state is malformed or unreadable.");
  }
  return mapKnownSwarmError(error, "operational_read");
}

function mapKnownSwarmError(error: unknown, operation: string): unknown {
  if (error instanceof CliCommandError) return error;
  const message = error instanceof Error ? redactSecretsFromText(error.message) : `Swarm ${operation} failed.`;
  return new CliCommandError("store_unreadable", message);
}
