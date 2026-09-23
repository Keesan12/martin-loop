// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { INTERNAL_HEALTH_COMMANDS, internalHealthCommandSetSha256, renderHealthCommand } from "./lib/internal-health-commands.mjs";

const ROOT = process.cwd();
const EXPECTED_PRIVATE_REPOSITORY_FINGERPRINT = "04aac733f3b08513fddcc72a9013b9f59cf7919f9a0a3893d0b3d953929826ec";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}
function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function repositorySlug(remote) {
  const normalized = remote.trim().replaceAll("\\", "/");
  const scpLike = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/iu.exec(normalized);
  if (scpLike) return scpLike[1];
  const parsed = new URL(normalized);
  if (parsed.hostname.toLowerCase() !== "github.com") throw new Error("origin must use github.com");
  return parsed.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/iu, "");
}

const head = git(["rev-parse", "HEAD"]).toLowerCase();
const origin = git(["config", "--get", "remote.origin.url"]);
const repositoryFingerprint = sha256(repositorySlug(origin));
if (repositoryFingerprint !== EXPECTED_PRIVATE_REPOSITORY_FINGERPRINT) {
  throw new Error("internal health evidence must be generated from the private release authority repository");
}
const packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const output = resolve(ROOT, arg("--output", `.martin/generated/health-evidence-${packageJson.version}-${head.slice(0, 12)}.json`));
const startedAt = new Date().toISOString();
const results = [];

for (const [command, args] of INTERNAL_HEALTH_COMMANDS) {
  const before = git(["rev-parse", "HEAD"]).toLowerCase();
  if (before !== head) throw new Error(`release authority changed before ${renderHealthCommand([command, args])}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  results.push({ command: renderHealthCommand([command, args]), exitCode: result.status });
  if (result.status !== 0) {
    console.error(`[internal-health] BLOCKED command=${renderHealthCommand([command, args])} exit=${result.status}`);
    process.exit(result.status ?? 1);
  }
  const after = git(["rev-parse", "HEAD"]).toLowerCase();
  if (after !== head) throw new Error("release authority SHA changed during internal health validation");
}

const evidence = {
  schemaVersion: "martin.internal-health.v2",
  generator: "scripts/generate-internal-health-evidence.mjs",
  repositoryFingerprint,
  version: packageJson.version,
  status: "PASS",
  validatedReleaseSha: head,
  commandSetSha256: internalHealthCommandSetSha256(),
  startedAt,
  validatedAt: new Date().toISOString(),
  commands: results,
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`[internal-health] PASS sha=${head} evidence=${output}`);
