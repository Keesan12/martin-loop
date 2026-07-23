import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PASS_VERIFIER = new Set(["pass", "passed", "success", "succeeded", "verified", "green"]);
const PASS_INTEGRITY = new Set(["verified", "signed"]);

function getPath(value, dottedPath) {
  return dottedPath.split(".").reduce((current, key) => {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    return current[key];
  }, value);
}

function firstDefined(value, paths) {
  for (const candidate of paths) {
    const found = getPath(value, candidate);
    if (found !== undefined && found !== null && found !== "") return { path: candidate, value: found };
  }
  return { path: null, value: undefined };
}

export function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

export function parseMoney(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/[$,]/g, "").replace(/\s*usd$/i, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeStatus(value) {
  if (typeof value === "boolean") return value ? "passed" : "failed";
  if (typeof value === "number") return value === 0 ? "passed" : "failed";
  if (typeof value !== "string") return null;
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function extractVerifier(receipt) {
  const booleanCandidate = firstDefined(receipt, [
    "verification.passed",
    "verification.success",
    "receipt.verification.passed",
    "receipt.verifier.passed",
  ]);
  if (typeof booleanCandidate.value === "boolean") {
    return { status: booleanCandidate.value ? "passed" : "failed", source: booleanCandidate.path };
  }

  const statusCandidate = firstDefined(receipt, [
    "verification.status",
    "verification.verdict",
    "verification.result",
    "verification.outcome",
    "receipt.verification.status",
    "receipt.verifier.status",
    "receipt.verifier",
    "loop.verifierStatus",
    "verifier",
  ]);

  return { status: normalizeStatus(statusCandidate.value), source: statusCandidate.path };
}

function extractIntegrity(receipt) {
  const candidate = firstDefined(receipt, [
    "receiptIntegrity.verdict",
    "receiptIntegrity.status",
    "receiptIntegrity",
    "integrity.verdict",
    "integrity.status",
    "integrity",
  ]);
  return { status: normalizeStatus(candidate.value), source: candidate.path };
}

function extractSpend(receipt) {
  const candidate = firstDefined(receipt, [
    "loop.spend.actualUsd",
    "loop.cost.actualUsd",
    "loop.totalActualUsd",
    "loop.actualUsd",
    "loop.spendUsd",
    "receipt.cost.actualUsd",
    "receipt.spend.actualUsd",
    "cost.actualUsd",
    "spend.actualUsd",
    "totalActualUsd",
    "actualUsd",
    "costSpend",
  ]);
  const provenanceCandidate = firstDefined(receipt, [
    "loop.spend.provenance",
    "loop.cost.provenance",
    "loop.costProvenance",
    "receipt.cost.provenance",
    "cost.provenance",
    "costProvenance",
  ]);

  let provenance = normalizeStatus(provenanceCandidate.value);
  if (!provenance && candidate.path?.toLowerCase().includes("actual")) provenance = "actual";

  return {
    amount: parseMoney(candidate.value),
    source: candidate.path,
    provenance,
  };
}

function extractReceiptBudget(receipt) {
  const candidate = firstDefined(receipt, [
    "loop.budget.maxUsd",
    "loop.budgetUsd",
    "loop.maxUsd",
    "receipt.budget.maxUsd",
    "budget.maxUsd",
    "maxUsd",
    "budget",
  ]);
  return { amount: parseMoney(candidate.value), source: candidate.path };
}

export function evaluateReceipt(receipt, options = {}) {
  const configuredMaxUsd = parseMoney(options.maxUsd ?? 3);
  if (configuredMaxUsd === null || configuredMaxUsd <= 0) {
    throw new Error(`max-usd must be a positive number; received ${options.maxUsd}`);
  }

  const requireVerifier = options.requireVerifier ?? true;
  const requireIntegrity = options.requireIntegrity ?? true;
  const allowUnknownCost = options.allowUnknownCost ?? false;

  const spend = extractSpend(receipt);
  const receiptBudget = extractReceiptBudget(receipt);
  const verifier = extractVerifier(receipt);
  const integrity = extractIntegrity(receipt);
  const errors = [];
  const warnings = [];

  const effectiveMaxUsd = receiptBudget.amount !== null
    ? Math.min(configuredMaxUsd, receiptBudget.amount)
    : configuredMaxUsd;

  const explicitNonActual = spend.provenance && spend.provenance !== "actual";
  if (spend.amount === null || explicitNonActual) {
    const reason = spend.amount === null
      ? "actual spend is missing"
      : `cost provenance is ${spend.provenance}, not actual`;
    if (allowUnknownCost) warnings.push(reason);
    else errors.push(reason);
  } else if (spend.amount > effectiveMaxUsd + Number.EPSILON) {
    errors.push(`actual spend $${spend.amount.toFixed(2)} exceeded the effective $${effectiveMaxUsd.toFixed(2)} limit`);
  }

  if (requireVerifier) {
    if (!verifier.status) errors.push("verifier result is missing");
    else if (!PASS_VERIFIER.has(verifier.status)) errors.push(`verifier status is ${verifier.status}`);
  }

  if (requireIntegrity) {
    if (!integrity.status) errors.push("receipt integrity verdict is missing");
    else if (!PASS_INTEGRITY.has(integrity.status)) errors.push(`receipt integrity is ${integrity.status}`);
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    configuredMaxUsd,
    receiptMaxUsd: receiptBudget.amount,
    effectiveMaxUsd,
    actualUsd: spend.amount,
    costProvenance: spend.provenance,
    verifierStatus: verifier.status,
    integrityStatus: integrity.status,
    sources: {
      spend: spend.source,
      budget: receiptBudget.source,
      verifier: verifier.source,
      integrity: integrity.source,
    },
  };
}

function walkForReceipts(root, depth = 0, found = []) {
  if (!existsSync(root) || depth > 7) return found;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) walkForReceipts(fullPath, depth + 1, found);
    else if (entry.isFile() && entry.name === "run-receipt.json") found.push(fullPath);
  }
  return found;
}

function newestExisting(paths) {
  return paths
    .filter((candidate) => existsSync(candidate))
    .map((candidate) => ({ candidate, mtimeMs: statSync(candidate).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.candidate ?? null;
}

function exportLatestReceipt(version) {
  const outputRoot = path.join(process.env.RUNNER_TEMP || tmpdir(), `martinloop-action-${Date.now()}`);
  mkdirSync(outputRoot, { recursive: true });
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(
    npx,
    ["-y", `martin-loop@${version}`, "share", "--latest", "--out-dir", outputRoot, "--json"],
    { cwd: process.env.GITHUB_WORKSPACE || process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw new Error(`Unable to run MartinLoop: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`MartinLoop receipt export exited with code ${result.status}`);

  const exported = newestExisting(walkForReceipts(outputRoot));
  if (!exported) throw new Error(`MartinLoop completed but no run-receipt.json was found under ${outputRoot}`);
  return exported;
}

export function resolveReceiptPath(inputPath, version = "latest") {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  if (inputPath) {
    const resolved = path.resolve(workspace, inputPath);
    if (!existsSync(resolved)) throw new Error(`Receipt file does not exist: ${resolved}`);
    return resolved;
  }

  const directCandidates = [
    path.join(workspace, "run-receipt.json"),
    path.join(workspace, "receipts", "run-receipt.json"),
    path.join(workspace, "martin-receipts", "run-receipt.json"),
  ];
  const persistedCandidates = walkForReceipts(path.join(homedir(), ".martin", "runs"));
  const discovered = newestExisting([...directCandidates, ...persistedCandidates]);
  if (discovered) return discovered;

  return exportLatestReceipt(version);
}

function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(value ?? "").replace(/\r?\n/g, " ")}\n`);
}

function writeSummary(receiptPath, result) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const verdict = result.passed ? "PASS" : "FAIL";
  const rows = [
    "## MartinLoop Budget Gate",
    "",
    `**Verdict:** ${verdict}`,
    "",
    "| Check | Value |",
    "| --- | --- |",
    `| Receipt | \`${receiptPath}\` |`,
    `| Actual spend | ${result.actualUsd === null ? "unavailable" : `$${result.actualUsd.toFixed(2)}`} |`,
    `| Effective limit | $${result.effectiveMaxUsd.toFixed(2)} |`,
    `| Cost provenance | ${result.costProvenance ?? "unavailable"} |`,
    `| Verifier | ${result.verifierStatus ?? "missing"} |`,
    `| Integrity | ${result.integrityStatus ?? "missing"} |`,
  ];
  if (result.errors.length) rows.push("", "### Failures", ...result.errors.map((error) => `- ${error}`));
  if (result.warnings.length) rows.push("", "### Warnings", ...result.warnings.map((warning) => `- ${warning}`));
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${rows.join("\n")}\n`);
}

export function runGateFromEnvironment() {
  const receiptPath = resolveReceiptPath(
    process.env.MARTIN_ACTION_RECEIPT || "",
    process.env.MARTIN_ACTION_VERSION || "latest",
  );
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  const result = evaluateReceipt(receipt, {
    maxUsd: process.env.MARTIN_ACTION_MAX_USD || "3",
    requireVerifier: parseBoolean(process.env.MARTIN_ACTION_REQUIRE_VERIFIER, true),
    requireIntegrity: parseBoolean(process.env.MARTIN_ACTION_REQUIRE_INTEGRITY, true),
    allowUnknownCost: parseBoolean(process.env.MARTIN_ACTION_ALLOW_UNKNOWN_COST, false),
  });

  setOutput("receipt-path", receiptPath);
  setOutput("actual-usd", result.actualUsd ?? "");
  setOutput("verifier-status", result.verifierStatus ?? "");
  setOutput("integrity-status", result.integrityStatus ?? "");
  writeSummary(receiptPath, result);

  for (const warning of result.warnings) console.log(`::warning title=MartinLoop Budget Gate::${warning}`);
  for (const error of result.errors) console.error(`::error title=MartinLoop Budget Gate::${error}`);

  if (!result.passed) process.exitCode = 1;
  else console.log(`MartinLoop gate passed: $${result.actualUsd?.toFixed(2)} / $${result.effectiveMaxUsd.toFixed(2)}, verifier=${result.verifierStatus}, integrity=${result.integrityStatus}`);

  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    runGateFromEnvironment();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error title=MartinLoop Budget Gate::${message}`);
    process.exitCode = 1;
  }
}
