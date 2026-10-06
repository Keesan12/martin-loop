#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { packRootRelease } from "./pack-root-release.mjs";
import { runPublishedArtifactE2e } from "./published-artifact-e2e.mjs";
import { resolvePublishedArtifactCommandExecution } from "./published-artifact-e2e.mjs";

const SCHEMA_VERSION = "martin.swarm-packed-artifact.v1";
const REQUIRED_COMMANDS = ["legacy-help", "legacy-demo", "swarm-demo", "single-agent-e2e", "package-entrypoint", "mcp-pack-smoke"];
const TEXT_EXTENSIONS = new Set([".cjs", ".css", ".d.ts", ".html", ".js", ".json", ".md", ".mjs", ".txt", ".yml", ".yaml"]);
const MAX_TEXT_BYTES = 1_000_000;
const PRIVATE_REPOSITORY_PATTERN = new RegExp(`\\b(?:${[
  ["ML", "Core", "OSS", "Internal"],
  ["ML", "Main", "Repo", "Internal"],
  ["ML", "Control", "Plane", "Internal"],
].map((parts) => parts.join("_")).join("|")})\\b`, "iu");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizedArtifactPath(value) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) return null;
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").includes("..") || normalized.startsWith("/")) return null;
  return normalized;
}

export function createSafeArtifactReader(root) {
  const lexicalRoot = path.resolve(root);
  const rootMetadata = lstatSync(lexicalRoot);
  const canonicalRoot = realpathSync(lexicalRoot);
  const samePath = (left, right) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || !samePath(canonicalRoot, lexicalRoot)) throw new Error("artifact root must be an exact canonical directory");
  return (relativePath) => {
    const normalized = normalizedArtifactPath(relativePath);
    if (!normalized) throw new Error("artifact path must be safe and relative");
    const lexical = path.resolve(canonicalRoot, normalized);
    const relative = path.relative(canonicalRoot, lexical);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("artifact path escapes artifact root");
    const metadata = lstatSync(lexical);
    const canonical = realpathSync(lexical);
    if (!metadata.isFile() || metadata.isSymbolicLink() || !samePath(canonical, lexical)) throw new Error("artifact path is not an exact canonical file");
    return readFileSync(canonical);
  };
}

export function assertCleanPackedSurface(entries, textFiles) {
  const findings = [];
  for (const entry of entries) {
    const normalized = String(entry).replaceAll("\\", "/");
    if (/(?:^|\/)\.(?:planning|release|git)(?:\/|$)/u.test(normalized)) findings.push(`${entry}: forbidden package path`);
  }
  const patterns = [
    [PRIVATE_REPOSITORY_PATTERN, "private repository identifier"],
    [/\b[A-Za-z]:\\Users\\[^\\\s]+\\/u, "absolute Windows workstation path"],
    [/(?:^|[\s"'(])\/(?:Users|home)\/[^/\s]+\//u, "absolute workstation path"],
    [/\b(?:npm_token|github_token|api_key|secret_key)\s*[:=]\s*["']?(?!example|placeholder|redacted)[A-Za-z0-9_\-]{8,}/iu, "credential material"],
    [/\b(?:internal planning|private planning|private workstream)\b/iu, "internal planning language"],
  ];
  for (const file of textFiles) {
    for (const [pattern, label] of patterns) if (pattern.test(file.text)) findings.push(`${file.path}: ${label}`);
  }
  if (findings.length > 0) throw new Error(`Packed artifact contamination detected:\n- ${findings.join("\n- ")}`);
  return { status: "PASS", findings: [], inventoryCount: entries.length, textFileCount: textFiles.length };
}

export function validateSwarmDemoPayload(payload) {
  const errors = [];
  const agentStatuses = Array.isArray(payload?.agentStatuses) ? payload.agentStatuses : [];
  const namedAgents = agentStatuses.filter((agent) => typeof agent?.agentId === "string" && typeof agent?.role === "string" && agent.role.length > 0);
  if (payload?.agents !== 15 || namedAgents.length !== 15 || new Set(namedAgents.map((agent) => agent.agentId)).size !== 15) errors.push("deterministic swarm must contain exactly 15 named agents");
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const deniedScope = events.some((event) => event?.type === "CHILD_PATCH_REJECTED" && event?.payload?.reason === "scope_creep" && event?.payload?.bytesAdmitted === 0) && payload?.deniedChangesAdmitted === 0;
  const reassigned = events.some((event) => event?.type === "TASK_REASSIGNED") && payload?.reassignedTasks === 1;
  const verifier = payload?.globalVerifier;
  const parentAuthority = verifier?.launched === true && verifier?.completed === true && verifier?.crashed === false && verifier?.exitCode === 0 && verifier?.passed === true && payload?.parentOutcome?.state === "verified" && events.at(-1)?.type === "SWARM_VERIFIED";
  if (!deniedScope) errors.push("denied-scope intervention evidence is missing");
  if (!reassigned) errors.push("task reassignment evidence is missing");
  if (!parentAuthority) errors.push("parent/global verifier authority is missing");
  if (payload?.providerMode !== "deterministic_local" || payload?.providerSpendUsd !== 0) errors.push("provider posture is not deterministic local with zero spend");
  if (errors.length > 0) throw new Error(errors.join("; "));
  return { agentCount: 15, deniedScope, reassigned, parentAuthority, spendUsd: 0 };
}

export function validatePackedArtifactReport(report, options = {}) {
  const errors = [];
  if (!report || typeof report !== "object" || Array.isArray(report)) return { ok: false, errors: ["report must be an object"] };
  if (report.schemaVersion !== SCHEMA_VERSION) errors.push("schemaVersion mismatch");
  if (report.status !== "PASS") errors.push("report status is not PASS");
  if (options.expectedHead && report.repository?.head !== options.expectedHead) errors.push("repository HEAD mismatch");
  if (report.repository?.branch !== "main") errors.push("repository branch mismatch");
  if (typeof report.package?.version !== "string" || report.package.version.length === 0) errors.push("installed package version missing");
  const tarball = report.package?.tarball;
  const tarballPath = normalizedArtifactPath(tarball?.path);
  if (!tarballPath || tarballPath !== report.package?.tarballName || !/^[a-f0-9]{64}$/u.test(tarball?.sha256 ?? "") || !Number.isSafeInteger(tarball?.bytes) || tarball.bytes <= 0) {
    errors.push("retained tarball reference invalid");
  } else if (typeof options.readFile !== "function") {
    errors.push("retained tarball bytes unavailable");
  } else {
    try {
      const bytes = Buffer.from(options.readFile(tarballPath));
      if (bytes.byteLength !== tarball.bytes) errors.push("retained tarball byte count mismatch");
      if (sha256(bytes) !== tarball.sha256) errors.push("retained tarball SHA-256 mismatch");
    } catch (error) {
      errors.push(`retained tarball unreadable (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (report.providerPosture?.NEW_PROVIDER_RUNS !== 0 || report.providerPosture?.NEW_PROVIDER_SPEND_USD !== 0) errors.push("provider posture is not zero");
  if (report.contamination?.status !== "PASS" || !Array.isArray(report.contamination?.findings) || report.contamination.findings.length !== 0) errors.push("contamination gate is not clean");
  if (report.swarm?.status !== "PASS" || report.swarm?.agentCount !== 15 || report.swarm?.deniedScope !== true || report.swarm?.reassigned !== true || report.swarm?.parentAuthority !== true || report.swarm?.spendUsd !== 0) errors.push("swarm proof is incomplete");
  if (report.cleanup?.status !== "PASS") errors.push("cleanup is not PASS");
  const commands = Array.isArray(report.commands) ? report.commands : [];
  for (const id of REQUIRED_COMMANDS) {
    const matches = commands.filter((command) => command?.id === id);
    if (matches.length !== 1 || matches[0]?.status !== "PASS" || matches[0]?.exitCode !== 0) errors.push(`${id}: required command is not uniquely PASS with exit 0`);
  }
  return { ok: errors.length === 0, errors };
}

async function runCommand(command, options = {}) {
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
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
  });
}

function requirePass(id, result) {
  if (result.exitCode !== 0) throw new Error(`${id} failed (${String(result.exitCode)}):\n${result.stdout}${result.stderr}`);
  return { id, status: "PASS", exitCode: 0, stdout: result.stdout, stderr: result.stderr };
}

async function collectTextFiles(root) {
  const results = [];
  async function visit(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) await visit(absolute);
      else if (item.isFile() && TEXT_EXTENSIONS.has(path.extname(item.name).toLowerCase()) && (await stat(absolute)).size <= MAX_TEXT_BYTES) {
        results.push({ path: path.relative(root, absolute).replaceAll("\\", "/"), text: await readFile(absolute, "utf8") });
      }
    }
  }
  await visit(root);
  return results;
}

async function gitValue(rootDir, args) {
  const result = await runCommand(["git", ...args], { cwd: rootDir });
  requirePass(`git ${args.join(" ")}`, result);
  return result.stdout.trim();
}

export async function runSwarmPackedArtifactE2e(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const artifactRoot = path.resolve(options.artifactRoot ?? path.join(rootDir, ".release/swarm-mode-review"));
  await mkdir(artifactRoot, { recursive: true });
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "martin-swarm-pack-"));
  const commands = [];
  let cleanup = { status: "UNKNOWN" };
  let report;
  try {
    const pack = await packRootRelease({ rootDir, outputDir: path.join(tempRoot, "pack") });
    const tarballBytes = await readFile(pack.tarballPath);
    const retainedTarballPath = path.join(artifactRoot, pack.tarballName);
    await copyFile(pack.tarballPath, retainedTarballPath);
    const inventoryRun = requirePass("tar-inventory", await runCommand(["tar", "-tf", pack.tarballPath], { cwd: tempRoot }));
    const entries = inventoryRun.stdout.split(/\r?\n/u).filter(Boolean);
    const extractedRoot = path.join(tempRoot, "extracted");
    await mkdir(extractedRoot, { recursive: true });
    requirePass("tar-extract", await runCommand(["tar", "-xf", pack.tarballPath, "-C", extractedRoot], { cwd: tempRoot }));
    const contamination = assertCleanPackedSurface(entries, await collectTextFiles(extractedRoot));

    const consumer = path.join(tempRoot, "consumer");
    const legacyDemo = path.join(tempRoot, "legacy-demo");
    const swarmDemo = path.join(tempRoot, "swarm-demo");
    await mkdir(consumer, { recursive: true });
    await writeFile(path.join(consumer, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
    commands.push(requirePass("install-local-tarball", await runCommand(["npm", "install", "--save-exact", "--no-audit", "--no-fund", pack.tarballPath], { cwd: consumer })));
    const bin = path.join(consumer, "node_modules", ".bin", process.platform === "win32" ? "martin.cmd" : "martin");
    commands.push(requirePass("legacy-help", await runCommand([bin, "--help"], { cwd: consumer })));
    commands.push(requirePass("legacy-demo", await runCommand([bin, "demo", "--dir", legacyDemo], { cwd: consumer })));
    const swarmCommand = requirePass("swarm-demo", await runCommand([bin, "demo", "--swarm", "--scenario", "launch-board", "--dir", swarmDemo, "--json"], { cwd: consumer, env: { ...process.env, CI: "1" } }));
    commands.push(swarmCommand);
    const swarm = { status: "PASS", ...validateSwarmDemoPayload(JSON.parse(swarmCommand.stdout)) };
    const entrypoint = await runCommand(["node", "--input-type=module", "-e", "const p=(await import('martin-loop/package.json',{with:{type:'json'}})).default; await import('martin-loop'); await import('martin-loop/core'); console.log(JSON.stringify({version:p.version}));"], { cwd: consumer });
    commands.push(requirePass("package-entrypoint", entrypoint));
    const installedVersion = JSON.parse(entrypoint.stdout.trim()).version;
    const singleAgent = await runPublishedArtifactE2e({ rootDir, packageSpec: pack.tarballPath });
    commands.push({ id: "single-agent-e2e", status: "PASS", exitCode: 0, stdout: JSON.stringify(singleAgent.output), stderr: "" });
    commands.push(requirePass("mcp-pack-smoke", await runCommand(["pnpm", "mcp:published:smoke:pack"], { cwd: rootDir })));

    report = {
      schemaVersion: SCHEMA_VERSION,
      status: "PASS",
      generatedAt: new Date().toISOString(),
      repository: { head: await gitValue(rootDir, ["rev-parse", "HEAD"]), branch: await gitValue(rootDir, ["branch", "--show-current"]) },
      package: {
        version: installedVersion,
        tarballName: pack.tarballName,
        tarball: { path: pack.tarballName, sha256: sha256(tarballBytes), bytes: tarballBytes.byteLength },
      },
      providerPosture: { NEW_PROVIDER_RUNS: 0, NEW_PROVIDER_SPEND_USD: 0 },
      contamination,
      swarm,
      commands: commands.filter((command) => REQUIRED_COMMANDS.includes(command.id)),
    };
  } finally {
    try {
      await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      cleanup = { status: "PASS" };
    } catch (error) {
      cleanup = { status: "FAIL", error: error instanceof Error ? error.message : String(error) };
    }
  }
  report.cleanup = cleanup;
  report.status = validatePackedArtifactReport(report, { expectedHead: report.repository.head, readFile: createSafeArtifactReader(artifactRoot) }).ok ? "PASS" : "FAIL";
  return report;
}

function parseArgs(argv) {
  const value = (name) => {
    const equals = argv.find((arg) => arg.startsWith(`${name}=`));
    if (equals) return equals.slice(name.length + 1);
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  return { output: value("--output") };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputPath = path.resolve(args.output ?? ".release/swarm-mode-review/packed-artifact.json");
  const artifactRoot = path.dirname(outputPath);
  const report = await runSwarmPackedArtifactE2e({ rootDir: process.cwd(), artifactRoot });
  const validation = validatePackedArtifactReport(report, { expectedHead: report.repository.head, readFile: createSafeArtifactReader(artifactRoot) });
  if (args.output) {
    await mkdir(path.dirname(path.resolve(args.output)), { recursive: true });
    await writeFile(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`, { flag: "w" });
  }
  process.stdout.write(`${JSON.stringify({ status: validation.ok ? "PASS" : "FAIL", head: report.repository.head, output: args.output ?? null, tarballSha256: report.package.tarball.sha256 })}\n`);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`[swarm-packed-artifact-e2e] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
