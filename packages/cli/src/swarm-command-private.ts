// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { createSwarmVerifierExecutor } from "@martin/adapters";
import {
  assertSwarmPathIdentifier,
  buildSwarmShareProjection,
  evaluateSecretLeash,
  readSwarmDossier,
  redactSecretsFromText,
  verifySwarmEvidence,
  validateSwarmTaskGraph,
  type SwarmDossierProjection,
  type SwarmEvidenceSelector,
  type SwarmEvidenceVerification,
  type SwarmShareProjection,
} from "@martin/core";
import {
  isAuthoritativeLiveSwarmVerified,
  runProductionLiveSwarm,
  type RunProductionLiveSwarmInput,
  type RunLiveSwarmResult,
} from "../../core/dist/swarm/live-runtime.js";
import {
  readSwarmOperationalState,
  requestSwarmOperationalCancellation,
  waitForSwarmOperationalRevision,
} from "../../core/dist/swarm/operations.js";
import {
  validateSwarmLivePlan,
  type MartinOutputMode,
  type SwarmLivePlan,
} from "@martin/contracts";

import { resolveCliEnvironment } from "./run-store.js";
import { enqueueCommittedSwarmForHostedSync } from "./swarm-sync-client.js";
import {
  assertConcreteSwarmEngineProfile,
  createExplicitSwarmAdapterFactory,
  resolveCodexSwarmLaunchBinding,
  type CodexLaunchBinding,
} from "./swarm-engine.js";
import { CliCommandError, renderCliSuccess } from "./ux.js";
import {
  renderSwarmInspectHuman,
  renderSwarmCancelHuman,
  renderSwarmDossierHuman,
  renderSwarmStatusHuman,
  renderSwarmVerifyHuman,
  toSwarmInspectData,
  toSwarmCancelData,
  toSwarmDossierData,
  toSwarmStatusData,
  toSwarmVerifyData,
} from "./swarm-renderer.js";
import {
  evaluateSwarmPlanGate,
  recordSwarmPlanReadiness,
  type SwarmPlanGateInput,
} from "./swarm-workflow-state.js";

const execFileAsync = promisify(execFile);
const MAX_PLAN_BYTES = 1024 * 1024;

export interface SwarmPlanCommandRequest {
  file: string;
  cwd?: string;
  runsDir?: string;
}

export interface SwarmRunCommandRequest extends SwarmPlanCommandRequest {}

export type SwarmOperationalCommandRequest = {
  runsDir?: string;
  watch?: boolean;
  reason?: string;
} & ({ swarmId: string; latest?: never } | { latest: true; swarmId?: never });

export type SwarmEvidenceCommandRequest = {
  runsDir?: string;
} & ({ swarmId: string; latest?: never } | { latest: true; swarmId?: never });

export type SwarmShareCommandRequest = SwarmEvidenceCommandRequest & { outputDir: string };

export type ParsedSwarmCommand =
  | { command: "swarm_plan"; request: SwarmPlanCommandRequest }
  | { command: "swarm_run"; request: SwarmRunCommandRequest }
  | { command: "swarm_status"; request: SwarmOperationalCommandRequest }
  | { command: "swarm_inspect"; request: SwarmOperationalCommandRequest }
  | { command: "swarm_cancel"; request: SwarmOperationalCommandRequest }
  | { command: "swarm_dossier"; request: SwarmEvidenceCommandRequest }
  | { command: "swarm_verify"; request: SwarmEvidenceCommandRequest }
  | { command: "swarm_share"; request: SwarmShareCommandRequest };

export interface SwarmCommandDependencies {
  readRepositoryRoot?(cwd: string): Promise<string>;
  readBaselineCommit(cwd: string): Promise<string>;
  readWorktreeClean(cwd: string): Promise<boolean>;
  runLiveSwarm(input: RunProductionLiveSwarmInput): Promise<RunLiveSwarmResult>;
  resolveCodexLaunch(input: { workingDirectory: string; model: string }): CodexLaunchBinding;
  enqueueCommittedSwarmForHostedSync?(input: {
    runsRoot: string;
    swarmId: string;
    runtimeVersion: string;
  }): Promise<unknown>;
}

const productionDependencies: SwarmCommandDependencies = {
  async readRepositoryRoot(cwd) {
    const result = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  },
  async readBaselineCommit(cwd) {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  },
  async readWorktreeClean(cwd) {
    const result = await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
      cwd,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout.trim().length === 0;
  },
  runLiveSwarm: runProductionLiveSwarm,
  resolveCodexLaunch: resolveCodexSwarmLaunchBinding,
  enqueueCommittedSwarmForHostedSync,
};

/** @internal Keeps optional hosted sync strictly downstream from immutable local truth. */
export async function runBestEffortPostSealSwarmSync<T>(
  localResult: T,
  enqueue?: () => Promise<unknown>,
): Promise<T> {
  if (!enqueue) return localResult;
  try {
    await enqueue();
  } catch {
    // Local terminal evidence is authoritative; optional hosted sync cannot reinterpret it.
  }
  return localResult;
}

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

export function parseSwarmCommandArguments(args: string[]): ParsedSwarmCommand {
  const [subcommand, ...rest] = args;
  if (subcommand === "--help" || subcommand === "-h") {
    throw new CliCommandError("invalid_input", "Swarm help requested.");
  }
  if (subcommand === "status" || subcommand === "inspect" || subcommand === "cancel") {
    return parseOperationalCommand(subcommand, rest);
  }
  if (subcommand === "dossier" || subcommand === "verify") {
    const request = parseEvidenceSelector(subcommand, rest);
    return subcommand === "dossier"
      ? { command: "swarm_dossier", request }
      : { command: "swarm_verify", request };
  }
  if (subcommand === "share") {
    return { command: "swarm_share", request: parseShareCommand(rest) };
  }
  if (subcommand !== "plan" && subcommand !== "run") {
    throw new CliCommandError("invalid_input", `Unknown swarm subcommand: ${subcommand ?? "<missing>"}.`, {
      suggestion: "Use `martin swarm plan --file <plan.json>` or `martin swarm run --file <plan.json>`.",
    });
  }

  const allowed = new Set(["--file", "--cwd", "--runs-dir"]);
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!;
    if (!allowed.has(flag)) {
      throw new CliCommandError("invalid_input", `Unsupported swarm ${subcommand} argument: ${flag}.`);
    }
    if (values.has(flag)) {
      throw new CliCommandError("invalid_input", `Duplicate swarm ${subcommand} option: ${flag}.`);
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CliCommandError("invalid_input", `${flag} requires a value.`);
    }
    values.set(flag, value);
    index += 1;
  }
  const file = values.get("--file");
  if (!file) {
    throw new CliCommandError("invalid_input", `swarm ${subcommand} requires --file <plan.json>.`);
  }
  const request = {
    file,
    ...(values.get("--cwd") ? { cwd: values.get("--cwd") } : {}),
    ...(values.get("--runs-dir") ? { runsDir: values.get("--runs-dir") } : {}),
  };
  return subcommand === "plan"
    ? { command: "swarm_plan", request }
    : { command: "swarm_run", request };
}

function parseShareCommand(args: string[]): SwarmShareCommandRequest {
  const allowed = new Set(["--id", "--latest", "--runs-dir", "--out-dir"]);
  const values = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!allowed.has(flag)) throw new CliCommandError("invalid_input", `Unsupported swarm share argument: ${flag}.`);
    if (values.has(flag)) throw new CliCommandError("invalid_input", `Duplicate swarm share option: ${flag}.`);
    if (flag === "--latest") {
      values.set(flag, true);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new CliCommandError("invalid_input", `${flag} requires a value.`);
    values.set(flag, value);
    index += 1;
  }
  const swarmId = values.get("--id");
  const latest = values.get("--latest") === true;
  if ((typeof swarmId === "string") === latest) {
    throw new CliCommandError("invalid_input", "swarm share requires exactly one selector: --id <id> or --latest.");
  }
  const outputDir = values.get("--out-dir");
  if (typeof outputDir !== "string") {
    throw new CliCommandError("invalid_input", "swarm share requires --out-dir <directory>.");
  }
  return {
    ...(typeof swarmId === "string" ? { swarmId } : { latest: true as const }),
    ...(typeof values.get("--runs-dir") === "string" ? { runsDir: values.get("--runs-dir") as string } : {}),
    outputDir,
  };
}

function parseEvidenceSelector(
  subcommand: "dossier" | "verify" | "share",
  args: string[],
): SwarmEvidenceCommandRequest {
  const allowed = new Set(["--id", "--latest", "--runs-dir"]);
  const values = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!allowed.has(flag)) {
      throw new CliCommandError("invalid_input", `Unsupported swarm ${subcommand} argument: ${flag}.`);
    }
    if (values.has(flag)) {
      throw new CliCommandError("invalid_input", `Duplicate swarm ${subcommand} option: ${flag}.`);
    }
    if (flag === "--latest") {
      values.set(flag, true);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CliCommandError("invalid_input", `${flag} requires a value.`);
    }
    values.set(flag, value);
    index += 1;
  }
  const swarmId = values.get("--id");
  const latest = values.get("--latest") === true;
  if ((typeof swarmId === "string") === latest) {
    throw new CliCommandError(
      "invalid_input",
      `swarm ${subcommand} requires exactly one selector: --id <id> or --latest.`,
    );
  }
  return {
    ...(typeof swarmId === "string" ? { swarmId } : { latest: true as const }),
    ...(typeof values.get("--runs-dir") === "string" ? { runsDir: values.get("--runs-dir") as string } : {}),
  };
}

function parseOperationalCommand(
  subcommand: "status" | "inspect" | "cancel",
  args: string[],
): ParsedSwarmCommand {
  const allowed = new Set([
    "--swarm-id", "--latest", "--runs-dir",
    ...(subcommand === "status" ? ["--watch"] : []),
    ...(subcommand === "cancel" ? ["--reason"] : []),
  ]);
  const values = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!allowed.has(flag)) throw new CliCommandError("invalid_input", `Unsupported swarm ${subcommand} argument: ${flag}.`);
    if (values.has(flag)) throw new CliCommandError("invalid_input", `Duplicate swarm ${subcommand} option: ${flag}.`);
    if (flag === "--latest" || flag === "--watch") {
      values.set(flag, true);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new CliCommandError("invalid_input", `${flag} requires a value.`);
    values.set(flag, value);
    index += 1;
  }
  const swarmId = values.get("--swarm-id");
  const latest = values.get("--latest") === true;
  if ((typeof swarmId === "string") === latest) {
    throw new CliCommandError("invalid_input", `swarm ${subcommand} requires exactly one selector: --swarm-id <id> or --latest.`);
  }
  const request: SwarmOperationalCommandRequest = {
    ...(typeof swarmId === "string" ? { swarmId } : { latest: true as const }),
    ...(typeof values.get("--runs-dir") === "string" ? { runsDir: values.get("--runs-dir") as string } : {}),
    ...(values.get("--watch") === true ? { watch: true } : {}),
    ...(typeof values.get("--reason") === "string" ? { reason: values.get("--reason") as string } : {}),
  };
  if (subcommand === "status") return { command: "swarm_status", request };
  if (subcommand === "inspect") return { command: "swarm_inspect", request };
  return { command: "swarm_cancel", request };
}

export async function executeSwarmStatusCommand(
  request: SwarmOperationalCommandRequest,
  outputMode: MartinOutputMode,
  presentation: {
    interactive?: boolean;
    writeFrame?: (frame: string) => void;
  } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const runsRoot = resolveCliEnvironment({ runsDir: request.runsDir }).runsRoot;
  const interactive = presentation.interactive
    ?? (outputMode === "human" && process.stdout.isTTY === true);
  const writeFrame = presentation.writeFrame
    ?? ((frame: string): void => { process.stdout.write(`\u001B[2J\u001B[H${frame}\n`); });
  const selector = "swarmId" in request && request.swarmId !== undefined
    ? { runsRoot, swarmId: request.swarmId }
    : { runsRoot, latest: true as const };
  let state;
  let pinnedSelector: { runsRoot: string; swarmId: string } | undefined;
  try {
    state = await readSwarmOperationalState(selector);
    pinnedSelector = { runsRoot, swarmId: state.snapshot.swarmId };
    if (request.watch && outputMode === "human" && interactive) {
      const controller = new AbortController();
      const abort = (): void => controller.abort("operator stopped watch");
      process.once("SIGINT", abort);
      process.once("SIGTERM", abort);
      try {
        writeFrame(renderSwarmStatusHuman(toSwarmStatusData(state, true)).join("\n"));
        while (state.snapshot.outcome.state === "running" && !controller.signal.aborted) {
          state = await waitForSwarmOperationalRevision({
            ...pinnedSelector, afterRevision: state.snapshot.revision, signal: controller.signal,
          });
          writeFrame(renderSwarmStatusHuman(toSwarmStatusData(state, true)).join("\n"));
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        process.removeListener("SIGINT", abort);
        process.removeListener("SIGTERM", abort);
      }
    }
  } catch (error) {
    throw mapOperationalError(error);
  }
  const interactiveWatch = Boolean(request.watch && outputMode === "human" && interactive);
  const data = toSwarmStatusData(state, interactiveWatch);
  const rendered = renderCliSuccess(outputMode, { data, human: renderSwarmStatusHuman(data), quiet: data.state });
  return interactiveWatch ? { ...rendered, stdout: "" } : rendered;
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

export async function executeSwarmCancelCommand(
  request: SwarmOperationalCommandRequest,
  outputMode: MartinOutputMode,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const runsRoot = resolveCliEnvironment({ runsDir: request.runsDir }).runsRoot;
  try {
    const selector = "swarmId" in request && request.swarmId !== undefined
      ? { runsRoot, swarmId: request.swarmId }
      : { runsRoot, latest: true as const };
    const result = await requestSwarmOperationalCancellation({
      ...selector,
      reason: request.reason?.trim() || "operator_requested",
      requestedBy: "martin_cli",
    });
    const data = toSwarmCancelData(result);
    return renderCliSuccess(outputMode, { data, human: renderSwarmCancelHuman(data), quiet: data.outcome });
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

export async function executeSwarmPlanCommand(
  request: SwarmPlanCommandRequest,
  outputMode: MartinOutputMode,
  dependencies: SwarmCommandDependencies = productionDependencies,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const prepared = await preparePlan(request, dependencies);
  const gateInput = toGateInput(prepared.plan, prepared.cwd, prepared.runsRoot);
  const gate = await evaluateSwarmPlanGate(gateInput);
  const missing = gate.missingSteps.filter((step) => step !== "swarm-plan");
  if (missing.length > 0) {
    throw new CliCommandError("policy_blocked", `Swarm plan requires fresh ${missing.join(", ")} readiness.`, {
      suggestion: gate.nextCommand,
      details: { missingSteps: missing },
    });
  }

  await assertUnchangedPlanAndRepository(prepared, dependencies);
  const planPath = await persistApprovedPlan(prepared.plan, prepared.runsRoot);
  await recordSwarmPlanReadiness(gateInput);
  const data = describePlan(prepared.plan, planPath);
  return renderCliSuccess(outputMode, {
    data,
    human: renderPlanHuman(data),
    quiet: prepared.plan.planHash,
  });
}

export async function executeSwarmRunCommand(
  request: SwarmRunCommandRequest,
  outputMode: MartinOutputMode,
  dependencies: SwarmCommandDependencies = productionDependencies,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const prepared = await preparePlan(request, dependencies);
  const gateInput = toGateInput(prepared.plan, prepared.cwd, prepared.runsRoot);
  const gate = await evaluateSwarmPlanGate(gateInput);
  if (!gate.allowed) {
    throw new CliCommandError("policy_blocked", gate.message, {
      suggestion: gate.nextCommand,
      details: { missingSteps: gate.missingSteps },
    });
  }
  await assertUnchangedPlanAndRepository(prepared, dependencies);
  await assertApprovedPlan(prepared.plan, prepared.runsRoot);

  const controller = new AbortController();
  const abort = (signal: NodeJS.Signals): void => {
    if (!controller.signal.aborted) controller.abort(new Error(`Parent received ${signal}.`));
  };
  const onSigint = (): void => abort("SIGINT");
  const onSigterm = (): void => abort("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  let result: RunLiveSwarmResult;
  try {
    try {
      result = await dependencies.runLiveSwarm({
        plan: prepared.plan,
        canonicalRoot: prepared.cwd,
        ownedRoot: join(prepared.runsRoot, "_swarms", prepared.plan.swarmId, "worktrees"),
        storeRoot: prepared.runsRoot,
        runsRoot: prepared.runsRoot,
        workspaceIsolationMode:
          process.platform === "win32" && prepared.plan.engine.engine === "codex"
            ? "independent_clone"
            : "worktree",
        adapterFactory: createExplicitSwarmAdapterFactory(
          prepared.plan.engine,
          undefined,
          prepared.plan.engine.engine === "codex"
            ? dependencies.resolveCodexLaunch
            : undefined,
        ),
        verifierExecutor: createSwarmVerifierExecutor(),
        signal: controller.signal,
      });
    } catch (error) {
      throw mapKnownSwarmError(error, "runtime");
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }

  result = await runBestEffortPostSealSwarmSync(result, dependencies.enqueueCommittedSwarmForHostedSync
    ? () => dependencies.enqueueCommittedSwarmForHostedSync!({
        runsRoot: prepared.runsRoot,
        swarmId: prepared.plan.swarmId,
        runtimeVersion: process.env["npm_package_version"] ?? "unknown",
      })
    : undefined);

  const outcome = result.outcome.state === "verified"
    && !isAuthoritativeLiveSwarmVerified(result)
    ? { state: "needs_review" as const, reason: "Parent/global verifier authority was not present." }
    : result.outcome;
  const data = {
    command: "swarm run",
    swarmId: prepared.plan.swarmId,
    planHash: prepared.plan.planHash,
    engine: { ...prepared.plan.engine },
    outcome: { ...outcome },
    ...(result.parent
      ? {
          parentDisposition: result.parent.disposition,
          blockingInvariants: [...result.parent.blockingInvariants],
        }
      : {}),
  };
  const exitCode = outcome.state === "verified" ? 0 : outcome.state === "stopped" ? 9 : 7;
  return renderCliSuccess(outputMode, {
    data,
    human: [
      `Swarm ${prepared.plan.swarmId}: ${outcome.state.toUpperCase()}`,
      outcome.reason,
      `Plan hash: ${prepared.plan.planHash}`,
      `Engine: ${prepared.plan.engine.engine}/${prepared.plan.engine.model}`,
    ],
    quiet: prepared.plan.swarmId,
    exitCode,
  });
}

interface PreparedPlan {
  plan: SwarmLivePlan;
  sourceBytes: string;
  file: string;
  cwd: string;
  runsRoot: string;
  baselineCommit: string;
}

async function preparePlan(
  request: SwarmPlanCommandRequest,
  dependencies: SwarmCommandDependencies,
): Promise<PreparedPlan> {
  const environment = resolveCliEnvironment({ cwd: request.cwd, runsDir: request.runsDir });
  let selectedCwd: string;
  try {
    selectedCwd = await realpath(environment.workingDirectory);
  } catch (error) {
    throw mapKnownSwarmError(error, "working_directory");
  }
  let file: string;
  try {
    file = await realpath(resolve(selectedCwd, request.file));
  } catch (error) {
    throw mapKnownSwarmError(error, "manifest");
  }
  assertContained(selectedCwd, file);
  let fileStat;
  try {
    fileStat = await stat(file);
  } catch (error) {
    throw mapKnownSwarmError(error, "manifest");
  }
  if (!fileStat.isFile() || fileStat.size === 0 || fileStat.size > MAX_PLAN_BYTES) {
    throw new CliCommandError("invalid_input", `Swarm plan must be a non-empty JSON file no larger than ${MAX_PLAN_BYTES} bytes.`);
  }
  let sourceBytes: string;
  try {
    sourceBytes = await readFile(file, "utf8");
  } catch (error) {
    throw mapKnownSwarmError(error, "manifest");
  }
  const plan = parseStrictPlan(sourceBytes);
  assertSwarmPathIdentifier(plan.swarmId, "swarm ID");
  let cwd = selectedCwd;
  try {
    if (dependencies.readRepositoryRoot) cwd = await realpath(await dependencies.readRepositoryRoot(selectedCwd));
  } catch (error) {
    throw mapKnownSwarmError(error, "repository");
  }
  let baselineCommit: string;
  try {
    baselineCommit = (await dependencies.readBaselineCommit(cwd)).trim().toLowerCase();
  } catch (error) {
    throw mapKnownSwarmError(error, "repository");
  }
  if (baselineCommit !== plan.baselineCommit.toLowerCase()) {
    throw new CliCommandError("policy_blocked", "Swarm plan baseline does not match the current repository HEAD.", {
      details: { planned: plan.baselineCommit, actual: baselineCommit },
    });
  }
  let clean: boolean;
  try {
    clean = await dependencies.readWorktreeClean(cwd);
  } catch (error) {
    throw mapKnownSwarmError(error, "repository");
  }
  if (!clean) {
    throw new CliCommandError("policy_blocked", "Swarm plan requires a clean repository before readiness can be approved.");
  }
  let runsRoot: string;
  try {
    await mkdir(environment.runsRoot, { recursive: true });
    runsRoot = await realpath(environment.runsRoot);
  } catch (error) {
    throw mapKnownSwarmError(error, "store");
  }
  return { plan, sourceBytes, file, cwd, runsRoot, baselineCommit };
}

function parseStrictPlan(source: string): SwarmLivePlan {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new CliCommandError("invalid_input", "Swarm plan is not valid JSON.");
  }
  assertStrictPlanShape(value);
  assertNoSecretMaterial(value);
  const plan = value as SwarmLivePlan;
  assertConcreteSwarmEngineProfile(plan.engine);
  const validation = validateSwarmLivePlan(plan);
  if (!validation.ok) {
    const firstError = validation.errors[0];
    const reason = firstError === undefined
      ? "invalid plan"
      : `${firstError.path}: ${firstError.message}`;
    throw new CliCommandError("invalid_input", `Swarm plan validation failed: ${reason}.`, {
      details: { errors: validation.errors },
    });
  }
  const graph = validateSwarmTaskGraph(plan.tasks);
  if (!graph.ok) {
    throw new CliCommandError("invalid_input", "Swarm task graph validation failed.", {
      details: { errors: graph.errors },
    });
  }
  const reservedUsd = plan.agents.reduce((total, agent) => total + agent.contract.budget.maxUsd, 0);
  const reservedTokens = plan.agents.reduce((total, agent) => total + (agent.contract.budget.maxTokens ?? 0), 0);
  if (reservedUsd > plan.parentContract.budget.maxUsd + Number.EPSILON) {
    throw new CliCommandError("budget_exit", "Aggregate child dollar budgets exceed the parent budget cap.");
  }
  if (
    plan.parentContract.budget.maxTokens !== undefined
    && reservedTokens > plan.parentContract.budget.maxTokens
  ) {
    throw new CliCommandError("budget_exit", "Aggregate child token budgets exceed the parent token cap.");
  }
  return plan;
}

async function assertUnchangedPlanAndRepository(
  prepared: PreparedPlan,
  dependencies: SwarmCommandDependencies,
): Promise<void> {
  let latestBytes: string;
  try {
    latestBytes = await readFile(prepared.file, "utf8");
  } catch (error) {
    throw mapKnownSwarmError(error, "manifest");
  }
  if (latestBytes !== prepared.sourceBytes) {
    throw new CliCommandError("policy_blocked", "Swarm plan changed during admission; rerun plan validation.");
  }
  const latestPlan = parseStrictPlan(latestBytes);
  if (latestPlan.planHash !== prepared.plan.planHash) {
    throw new CliCommandError("policy_blocked", "Swarm plan hash changed during admission.");
  }
  let latestBaseline: string;
  let clean: boolean;
  try {
    latestBaseline = (await dependencies.readBaselineCommit(prepared.cwd)).trim().toLowerCase();
    clean = await dependencies.readWorktreeClean(prepared.cwd);
  } catch (error) {
    throw mapKnownSwarmError(error, "repository");
  }
  if (latestBaseline !== prepared.baselineCommit || latestBaseline !== prepared.plan.baselineCommit.toLowerCase()) {
    throw new CliCommandError("policy_blocked", "Repository baseline changed during swarm admission.");
  }
  if (!clean) {
    throw new CliCommandError("policy_blocked", "Repository became dirty during swarm admission.");
  }
}

async function persistApprovedPlan(plan: SwarmLivePlan, runsRoot: string): Promise<string> {
  const { directory, destination } = await resolveApprovedPlanPath(plan, runsRoot, true);
  const serialized = serializeApprovedPlan(plan);
  try {
    const existing = await readFile(destination, "utf8");
    if (existing !== serialized) {
      throw new CliCommandError("store_unreadable", "An approved swarm plan path already contains different bytes.");
    }
    return destination;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw mapKnownSwarmError(error, "store");
  }
  const temporary = `${destination}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(serialized, "utf8");
    } finally {
      await handle.close();
    }
    await link(temporary, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw mapKnownSwarmError(error, "store");
    }
    if (await readFile(destination, "utf8") !== serialized) {
      throw new CliCommandError("store_unreadable", "Approved swarm plan identity already contains different bytes.");
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  void directory;
  return destination;
}

async function assertApprovedPlan(plan: SwarmLivePlan, runsRoot: string): Promise<void> {
  const { destination: path } = await resolveApprovedPlanPath(plan, runsRoot, false);
  let approved: string;
  try {
    approved = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliCommandError("policy_blocked", "Approved swarm plan artifact is missing; rerun swarm plan.");
    }
    throw mapKnownSwarmError(error, "store");
  }
  if (approved !== serializeApprovedPlan(plan)) {
    throw new CliCommandError("policy_blocked", "Approved swarm plan artifact does not match the requested plan hash.");
  }
}

async function resolveApprovedPlanPath(
  plan: SwarmLivePlan,
  runsRoot: string,
  create: boolean,
): Promise<{ directory: string; destination: string }> {
  assertSwarmPathIdentifier(plan.swarmId, "swarm ID");
  const root = await realpath(runsRoot);
  const approvalRoot = join(root, "_martin", "swarm-plans");
  if (create) await mkdir(approvalRoot, { recursive: true });
  let realApprovalRoot: string;
  try {
    realApprovalRoot = await realpath(approvalRoot);
  } catch (error) {
    throw mapKnownSwarmError(error, create ? "store" : "approved_plan");
  }
  assertStrictlyContained(root, realApprovalRoot, "Approved-plan root must remain inside the real runs root.");
  const requestedDirectory = join(realApprovalRoot, plan.swarmId);
  if (create) await mkdir(requestedDirectory, { recursive: true });
  let directory: string;
  try {
    directory = await realpath(requestedDirectory);
  } catch (error) {
    throw mapKnownSwarmError(error, create ? "store" : "approved_plan");
  }
  assertStrictlyContained(realApprovalRoot, directory, "Approved-plan directory escaped its real ancestor.");
  const destination = join(directory, `${plan.planHash}.json`);
  try {
    const existing = await lstat(destination);
    if (existing.isSymbolicLink()) {
      throw new CliCommandError("policy_blocked", "Approved-plan artifact may not be a symbolic link.");
    }
    const realDestination = await realpath(destination);
    assertStrictlyContained(directory, realDestination, "Approved-plan artifact escaped its real ancestor.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { directory, destination };
}

function toGateInput(plan: SwarmLivePlan, cwd: string, runsRoot: string): SwarmPlanGateInput {
  return {
    runsRoot,
    workingDirectory: cwd,
    objective: plan.parentContract.objective,
    engine: plan.engine.engine,
    verificationPlan: plan.parentContract.globalVerifierStack.map((step) => step.command),
    receiptScope: { invocationRoot: cwd, workingDirectory: cwd, repoRoot: cwd, runsRoot },
    allowedPaths: plan.parentContract.scope.allowedPaths,
    deniedPaths: plan.parentContract.scope.deniedPaths,
    budget: plan.parentContract.budget,
    planHash: plan.planHash,
    baselineCommit: plan.baselineCommit,
  };
}

function describePlan(plan: SwarmLivePlan, planPath: string) {
  return {
    command: "swarm plan",
    objective: plan.parentContract.objective,
    planHash: plan.planHash,
    planPath,
    baselineCommit: plan.baselineCommit,
    engine: { ...plan.engine },
    budget: {
      capUsd: plan.parentContract.budget.maxUsd,
      reservedUsd: plan.agents.reduce((total, agent) => total + agent.contract.budget.maxUsd, 0),
      ...(plan.parentContract.budget.maxTokens === undefined
        ? {}
        : { capTokens: plan.parentContract.budget.maxTokens }),
      reservedTokens: plan.agents.reduce((total, agent) => total + (agent.contract.budget.maxTokens ?? 0), 0),
      maxConcurrency: plan.parentContract.maxConcurrency,
      childMaxIterations: plan.childMaxIterations,
    },
    verifier: plan.parentContract.globalVerifierStack.map((step) => step.command),
    scope: {
      allowedPaths: [...plan.parentContract.scope.allowedPaths],
      deniedPaths: [...plan.parentContract.scope.deniedPaths],
    },
    tasks: plan.tasks.map((task) => ({
      taskId: task.taskId,
      dependsOn: [...task.dependsOn],
      assignedAgentId: task.assignedAgentId,
    })),
  };
}

function renderPlanHuman(data: ReturnType<typeof describePlan>): string[] {
  return [
    "Live swarm plan approved before spend.",
    `Objective: ${data.objective}`,
    `Plan hash: ${data.planHash}`,
    `Baseline: ${data.baselineCommit}`,
    `Engine: ${data.engine.engine}/${data.engine.model}`,
    `Budget: $${data.budget.reservedUsd.toFixed(2)} reserved of $${data.budget.capUsd.toFixed(2)}`,
    `Tokens: ${data.budget.reservedTokens.toLocaleString("en-US")} tokens reserved of ${data.budget.capTokens?.toLocaleString("en-US") ?? "unbounded"}`,
    `Concurrency: ${data.budget.maxConcurrency}; child iterations: ${data.budget.childMaxIterations}`,
    "Task DAG:",
    ...data.tasks.map((task) => `  ${task.taskId} <- ${task.dependsOn.join(", ") || "none"} -> ${task.assignedAgentId ?? "unassigned"}`),
    `Allowed scope: ${data.scope.allowedPaths.join(", ")}`,
    `Denied scope: ${data.scope.deniedPaths.join(", ") || "none"}`,
    ...data.verifier.map((command) => `Verifier: ${command}`),
    `Persisted: ${data.planPath}`,
  ];
}

function assertContained(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new CliCommandError("invalid_input", "Swarm plan file must resolve inside the selected working directory.");
}

function assertStrictlyContained(root: string, target: string, message: string): void {
  const rel = relative(root, target);
  if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) return;
  throw new CliCommandError("policy_blocked", message);
}

function assertStrictPlanShape(value: unknown): asserts value is SwarmLivePlan {
  assertPlainObject(value, "plan");
  assertExactKeys(value, [
    "schemaVersion", "planId", "swarmId", "workspaceId", "projectId", "baselineCommit",
    "parentContract", "tasks", "agents", "engine", "childMaxIterations", "createdAt", "planHash",
  ], "plan");
  assertPlainObject(value.parentContract, "parentContract");
  assertExactKeys(value.parentContract, [
    "policyVersion", "objective", "definitionOfDone", "budget", "maxWallClockMs", "maxConcurrency",
    "scope", "permissions", "integrationStrategy", "globalVerifierStack", "stopPolicy", "recoveryPolicy",
    "approvalPolicy", "orchestrationStrategy",
  ], "parentContract");
  assertBudget(value.parentContract.budget, "parentContract.budget");
  assertScope(value.parentContract.scope, "parentContract.scope");
  assertPermissions(value.parentContract.permissions, "parentContract.permissions");
  assertExactKeys(asObject(value.parentContract.stopPolicy, "parentContract.stopPolicy"), ["budgetExhausted", "blockingFailure", "verifierFailure"], "parentContract.stopPolicy");
  assertExactKeys(asObject(value.parentContract.recoveryPolicy, "parentContract.recoveryPolicy"), ["maxReassignmentsPerTask", "dependencyWaiversAllowed"], "parentContract.recoveryPolicy");
  assertApproval(value.parentContract.approvalPolicy, "parentContract.approvalPolicy");
  assertArray(value.parentContract.globalVerifierStack, "parentContract.globalVerifierStack").forEach((step, index) => {
    assertExactKeys(asObject(step, `globalVerifierStack[${index}]`), ["command", "type", "fastFail", "weight"], `globalVerifierStack[${index}]`);
  });
  assertArray(value.tasks, "tasks").forEach((task, index) => {
    assertExactKeys(asObject(task, `tasks[${index}]`), ["taskId", "title", "objective", "required", "dependsOn", "assignedAgentId", "status", "mutationMode", "writeScope"], `tasks[${index}]`);
  });
  assertArray(value.agents, "agents").forEach((agent, index) => {
    const agentObject = asObject(agent, `agents[${index}]`);
    assertExactKeys(agentObject, ["agentId", "role", "status", "childRunId", "contract", "failureClass"], `agents[${index}]`);
    const contract = asObject(agentObject.contract, `agents[${index}].contract`);
    assertExactKeys(contract, ["agentId", "taskIds", "scope", "budget", "maxWallClockMs", "permissions", "approvalPolicy", "verifierAuthority"], `agents[${index}].contract`);
    assertScope(contract.scope, `agents[${index}].contract.scope`);
    assertBudget(contract.budget, `agents[${index}].contract.budget`);
    assertPermissions(contract.permissions, `agents[${index}].contract.permissions`);
    assertApproval(contract.approvalPolicy, `agents[${index}].contract.approvalPolicy`);
  });
  assertExactKeys(asObject(value.engine, "engine"), ["engine", "model"], "engine");
}

function assertScope(value: unknown, path: string): void {
  assertExactKeys(asObject(value, path), ["allowedPaths", "deniedPaths"], path);
}

function assertPermissions(value: unknown, path: string): void {
  assertExactKeys(asObject(value, path), ["networkDomains", "commands"], path);
}

function assertApproval(value: unknown, path: string): void {
  assertExactKeys(asObject(value, path), ["dependencyAdds", "migrations", "configChanges", "externalWrites"], path);
}

function assertBudget(value: unknown, path: string): void {
  assertExactKeys(asObject(value, path), ["maxUsd", "softLimitUsd", "maxIterations", "maxTokens"], path);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (extra.length > 0) {
    throw new CliCommandError("invalid_input", `Unknown swarm plan field at ${path}: ${extra.join(", ")}.`);
  }
}

function assertPlainObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new CliCommandError("invalid_input", `Swarm plan ${path} must be a JSON object.`);
  }
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  assertPlainObject(value, path);
  return value;
}

function assertArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new CliCommandError("invalid_input", `Swarm plan ${path} must be an array.`);
  return value;
}

function assertNoSecretMaterial(value: unknown, path = "plan"): void {
  const decision = evaluateSecretLeash({ values: [JSON.stringify(value)] });
  if (!decision.allowed) {
    throw new CliCommandError("policy_blocked", `Potential secret material is forbidden in swarm plans (${path}).`);
  }
}

function serializeApprovedPlan(plan: SwarmLivePlan): string {
  return `${JSON.stringify(sortJsonValue(plan), null, 2)}\n`;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJsonValue(item)]),
    );
  }
  return value;
}

function mapKnownSwarmError(error: unknown, operation: string): unknown {
  if (error instanceof CliCommandError) {
    const message = redactSecretsFromText(error.message);
    if (message === error.message) return error;
    return new CliCommandError(error.category, message, {
      ...(error.suggestion ? { suggestion: redactSecretsFromText(error.suggestion) } : {}),
    });
  }
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  if (operation === "manifest" && (code === "ENOENT" || code === "ENOTDIR")) {
    return new CliCommandError("not_found", "Swarm plan manifest was not found.");
  }
  if (operation === "approved_plan" && (code === "ENOENT" || code === "ENOTDIR")) {
    return new CliCommandError("policy_blocked", "Approved swarm plan artifact is missing; rerun swarm plan.");
  }
  if (
    [
      "EACCES",
      "EPERM",
      "EROFS",
      "ENOSPC",
      "EIO",
      "MALFORMED_JSON",
      "MALFORMED_EVENT_LOG",
      "EVENT_CLAIM_GAP",
      "MISSING_EVENT_CLAIM",
      "MISSING_PLAN",
      "MISSING_EVENTS",
      "MISSING_START_CLAIM",
    ].includes(code)
    || operation === "store"
  ) {
    return new CliCommandError("store_unreadable", "Swarm plan state could not be read or persisted.");
  }
  if ([
    "CANONICAL_ROOT_UNAVAILABLE",
    "CANONICAL_ROOT_NOT_TOP_LEVEL",
    "NOT_A_GIT_REPOSITORY",
    "BASELINE_UNAVAILABLE",
  ].includes(code) || operation === "repository" || operation === "working_directory") {
    return new CliCommandError("environment", "Swarm execution requires an available canonical Git repository.");
  }
  if ([
    "LIVE_SWARM_ALREADY_STARTED",
    "LIVE_PLAN_BASELINE_MISMATCH",
    "LIVE_BASELINE_MISMATCH",
    "CANONICAL_BASELINE_CHANGED",
    "CANONICAL_WORKTREE_DIRTY",
    "UNSAFE_OWNED_ROOT",
    "WORKSPACE_PATH_ESCAPE",
    "WORKSPACE_REALPATH_ESCAPE",
    "LIVE_SWARM_PATH_ESCAPE",
    "START_CLAIM_CONFLICT",
    "UNSAFE_FILENAME_ID",
    "PLAN_CONFLICT",
    "INVALID_SWARM_ID",
    "CANONICAL_CHECKOUT_DIRTY",
  ].includes(code)) {
    return new CliCommandError(
      "policy_blocked",
      redactSecretsFromText(error instanceof Error ? error.message : "Swarm policy blocked execution."),
    );
  }
  if (["INVALID_PLAN", "INVALID_LIVE_PLAN", "INVALID_LIVE_SWARM_PLAN", "LIVE_PLAN_STORE_MISMATCH"].includes(code)) {
    return new CliCommandError("invalid_input", "Core rejected the live swarm plan binding.");
  }
  if (error instanceof Error) {
    const message = redactSecretsFromText(error.message);
    if (message !== error.message) {
      const sanitized = Object.assign(new Error(message), {
        ...(code ? { code } : {}),
      });
      sanitized.name = error.name;
      return sanitized;
    }
  }
  return error;
}
