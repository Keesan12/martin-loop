import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_FIXTURE = resolve(
  ROOT,
  "packages/contracts/tests/fixtures/lifecycle-truth-v1-cases.json",
);
const DEFAULT_CHECKSUM = resolve(
  ROOT,
  "packages/contracts/tests/fixtures/lifecycle-truth-v1-cases.sha256",
);

export const REQUIRED_CASE_IDS = Object.freeze([
  "positive",
  "verifier_failed",
  "denied",
  "reverted",
  "no_edit",
  "proof_only",
  "tampered",
  "forged_success",
]);

export const REQUIRED_SURFACES = Object.freeze([
  "cli_dossier",
  "cli_runs_verify",
  "cli_share_json",
  "cli_share_markdown",
  "mcp_dossier",
  "terminal_handoff",
  "markdown_handoff",
]);

const CANONICAL_KEYS = Object.freeze([
  "outcome",
  "executionMode",
  "governanceClaimEligible",
  "sourceStatus",
  "verification",
  "receiptIntegrity",
  "lifecycleTruth",
  "fileEffects",
]);

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifyFixtureChecksumBytes(bytes, expectedChecksum) {
  const expected = String(expectedChecksum).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(expected)) {
    throw new Error("lifecycle fixture checksum sidecar must contain one lowercase SHA-256 value");
  }
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new Error(`lifecycle fixture checksum mismatch: expected ${expected}, observed ${actual}`);
  }
  return actual;
}

export function validateFixtureCorpus(corpus) {
  if (!record(corpus) || corpus.schemaVersion !== "martin.lifecycle-truth-fixtures.v1") {
    throw new Error("lifecycle fixture corpus has an unsupported schemaVersion");
  }
  if (!Array.isArray(corpus.cases)) {
    throw new Error("lifecycle fixture corpus cases must be an array");
  }

  const ids = corpus.cases.map((entry) => entry?.id);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length > 0) {
    throw new Error(`lifecycle fixture corpus contains duplicate case '${duplicates[0]}'`);
  }
  const missing = REQUIRED_CASE_IDS.filter((id) => !ids.includes(id));
  const unexpected = ids.filter((id) => !REQUIRED_CASE_IDS.includes(id));
  if (missing.length > 0 || unexpected.length > 0 || ids.length !== REQUIRED_CASE_IDS.length) {
    throw new Error(
      `lifecycle fixture IDs mismatch; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`,
    );
  }

  for (const entry of corpus.cases) {
    if (!record(entry.loop) || entry.loop.loopId !== `loop_lifecycle_${entry.id}`) {
      throw new Error(`case '${entry.id}' must contain its complete stable loop record`);
    }
    if (!record(entry.expected)) {
      throw new Error(`case '${entry.id}' is missing normalized expectations`);
    }
    for (const key of CANONICAL_KEYS) {
      if (!(key in entry.expected)) {
        throw new Error(`case '${entry.id}' expected.${key} is missing`);
      }
    }
  }
  return corpus;
}

function selectCanonical(handoff) {
  if (!record(handoff)) throw new Error("handoff is not an object");
  return {
    outcome: handoff.outcome,
    executionMode: handoff.executionMode,
    governanceClaimEligible: handoff.governanceClaimEligible,
    sourceStatus: handoff.sourceStatus,
    verification: { status: handoff.verification?.status },
    receiptIntegrity: { state: handoff.receiptIntegrity?.state },
    lifecycleTruth: handoff.lifecycleTruth,
    fileEffects: handoff.fileEffects,
  };
}

function firstDifference(expected, actual, path = "") {
  if (Object.is(expected, actual)) return null;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return path || "value";
    if (expected.length !== actual.length) return `${path}.length`;
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstDifference(expected[index], actual[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }
  if (record(expected) || record(actual)) {
    if (!record(expected) || !record(actual)) return path || "value";
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      if (!(key in expected) || !(key in actual)) return path ? `${path}.${key}` : key;
      const difference = firstDifference(
        expected[key],
        actual[key],
        path ? `${path}.${key}` : key,
      );
      if (difference) return difference;
    }
    return null;
  }
  return path || "value";
}

export function assertSurfaceAgreement(caseId, expected, surfaces) {
  for (const surface of REQUIRED_SURFACES) {
    if (!record(surfaces) || !(surface in surfaces)) {
      throw new Error(`case '${caseId}' missing surface '${surface}'`);
    }
    const actual = surfaces[surface];
    const difference = firstDifference(expected, actual);
    if (difference) {
      throw new Error(
        `case '${caseId}' surface '${surface}' disagrees at '${difference}': expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`,
      );
    }
  }
}

function humanize(value) {
  return String(value).replaceAll("_", " ").toLowerCase();
}

function formatFileList(values) {
  return values.length > 0 ? values.join(", ") : "none";
}

function assertPresentationText(caseId, surface, rendered, canonical) {
  const required = [
    canonical.outcome.replaceAll("_", " "),
    canonical.executionMode.replaceAll("_", " "),
    canonical.governanceClaimEligible ? "ELIGIBLE" : "INELIGIBLE",
    `${humanize(canonical.sourceStatus.status)} / ${humanize(canonical.sourceStatus.lifecycleState)}`,
    canonical.verification.status.replaceAll("_", " "),
    canonical.receiptIntegrity.state,
    canonical.lifecycleTruth.evidenceAvailable
      ? humanize(canonical.lifecycleTruth.reasonCode ?? canonical.lifecycleTruth.terminationClass)
      : "unavailable",
    canonical.lifecycleTruth.evidenceAvailable
      ? canonical.lifecycleTruth.exhaustedLimits.length > 0
        ? canonical.lifecycleTruth.exhaustedLimits.map(humanize).join(", ")
        : "none"
      : "unavailable",
    formatFileList(canonical.fileEffects.touchedDuringExecution),
    formatFileList(canonical.fileEffects.netChangedAtCompletion),
    formatFileList(canonical.fileEffects.revertedBeforeCompletion),
  ];
  for (const value of required) {
    if (!rendered.toLowerCase().includes(String(value).toLowerCase())) {
      throw new Error(`case '${caseId}' surface '${surface}' omitted canonical rendered value '${value}'`);
    }
  }
}

function assertShareMarkdown(caseId, rendered, canonical) {
  const required = [
    `- Outcome: ${canonical.outcome}`,
    `- Execution: ${canonical.sourceStatus.status} / ${canonical.sourceStatus.lifecycleState}`,
    `- Verification: ${canonical.verification.status}`,
    `- Receipt integrity: ${canonical.receiptIntegrity.state}`,
    `- Termination: ${canonical.lifecycleTruth.evidenceAvailable ? canonical.lifecycleTruth.reasonCode ?? canonical.lifecycleTruth.terminationClass : "unavailable"}`,
    `- File effects: touched ${canonical.fileEffects.touchedDuringExecution.length}, net ${canonical.fileEffects.netChangedAtCompletion.length}, reverted ${canonical.fileEffects.revertedBeforeCompletion.length}`,
  ];
  for (const value of required) {
    if (!rendered.includes(value)) {
      throw new Error(`case '${caseId}' surface 'cli_share_markdown' omitted '${value}'`);
    }
  }
  for (const file of [
    ...canonical.fileEffects.touchedDuringExecution,
    ...canonical.fileEffects.netChangedAtCompletion,
    ...canonical.fileEffects.revertedBeforeCompletion,
  ]) {
    if (!rendered.includes(file)) {
      throw new Error(`case '${caseId}' surface 'cli_share_markdown' omitted file effect '${file}'`);
    }
  }
}

function parseCliJson(caseId, surface, result) {
  if (result.exitCode !== 0) {
    throw new Error(`case '${caseId}' surface '${surface}' exited ${result.exitCode}: ${result.stderr || result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`case '${caseId}' surface '${surface}' returned invalid JSON: ${error.message}`);
  }
}

async function loadRuntimeModules() {
  const paths = {
    cli: resolve(ROOT, "packages/cli/dist/index.js"),
    persistence: resolve(ROOT, "packages/cli/dist/persistence.js"),
    mcp: resolve(ROOT, "packages/mcp/dist/tools/run-dossier.js"),
    presentation: resolve(ROOT, "packages/presentation/dist/verified-handoff.js"),
  };
  for (const [name, path] of Object.entries(paths)) {
    if (!existsSync(path)) {
      throw new Error(`source-built ${name} runtime is missing at ${path}; build affected packages first`);
    }
  }
  const [cli, persistence, mcp, presentation] = await Promise.all([
    import(pathToFileURL(paths.cli).href),
    import(pathToFileURL(paths.persistence).href),
    import(pathToFileURL(paths.mcp).href),
    import(pathToFileURL(paths.presentation).href),
  ]);
  return { cli, persistence, mcp, presentation };
}

async function persistCase(entry, runsRoot, persistence) {
  const runRoot = join(runsRoot, entry.loop.loopId);
  await mkdir(runRoot, { recursive: true });
  await writeFile(
    join(runRoot, "ledger.jsonl"),
    `${entry.loop.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  await persistence.persistLoopArtifacts(structuredClone(entry.loop), { runsRoot });

  if (entry.tamperAfterSigning === true) {
    for (const name of ["loop-record.json", "loop.json"]) {
      const path = join(runRoot, name);
      const tampered = JSON.parse(await readFile(path, "utf8"));
      tampered.cost.actualUsd += 0.001;
      await writeFile(path, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    }
  }
}

async function projectCase(entry, context) {
  const { cli, mcp, presentation } = context.runtime;
  const selector = ["--loop-id", entry.loop.loopId, "--runs-dir", context.runsRoot];
  const shareDir = join(context.outputRoot, "share", entry.id);
  const [dossierResult, verifyResult, shareResult] = await Promise.all([
    cli.executeCli(["--json", "dossier", ...selector]),
    cli.executeCli(["--json", "runs", "verify", ...selector]),
    cli.executeCli(["--json", "share", ...selector, "--out-dir", shareDir]),
  ]);
  const dossier = parseCliJson(entry.id, "cli_dossier", dossierResult);
  const verify = parseCliJson(entry.id, "cli_runs_verify", verifyResult);
  const share = parseCliJson(entry.id, "cli_share_json", shareResult);
  const shareReceipt = JSON.parse(await readFile(share.files.receiptJson, "utf8"));
  const shareMarkdown = await readFile(share.files.receiptMarkdown, "utf8");
  const mcpDossier = await mcp.martinRunDossierTool({
    loopId: entry.loop.loopId,
    runsDir: context.runsRoot,
    format: "json",
  });

  const dossierCanonical = selectCanonical(dossier.verifiedHandoff);
  const verifyCanonical = selectCanonical(verify.verifiedHandoff);
  const shareCanonical = selectCanonical(shareReceipt.verifiedHandoff);
  const mcpCanonical = selectCanonical(mcpDossier.verifiedHandoff);
  assertShareMarkdown(entry.id, shareMarkdown, shareCanonical);

  const terminal = presentation.renderVerifiedHandoff(dossier.verifiedHandoff, {
    width: 400,
    environment: { color: false, isTty: false },
  });
  const markdown = presentation.renderVerifiedHandoffMarkdown(dossier.verifiedHandoff);
  assertPresentationText(entry.id, "terminal_handoff", terminal, dossierCanonical);
  assertPresentationText(entry.id, "markdown_handoff", markdown, dossierCanonical);

  return {
    cli_dossier: dossierCanonical,
    cli_runs_verify: verifyCanonical,
    cli_share_json: shareCanonical,
    cli_share_markdown: shareCanonical,
    mcp_dossier: mcpCanonical,
    terminal_handoff: dossierCanonical,
    markdown_handoff: dossierCanonical,
  };
}

export async function runLifecycleTruthMatrix(options = {}) {
  const fixturePath = resolve(options.fixturePath ?? DEFAULT_FIXTURE);
  const checksumPath = resolve(options.checksumPath ?? DEFAULT_CHECKSUM);
  const fixtureBytes = await readFile(fixturePath);
  const fixtureSha256 = verifyFixtureChecksumBytes(
    fixtureBytes,
    await readFile(checksumPath, "utf8"),
  );
  const corpus = validateFixtureCorpus(JSON.parse(fixtureBytes.toString("utf8")));
  const outputRoot = resolve(
    options.outputRoot ?? await mkdtemp(join(tmpdir(), "martin-lifecycle-truth-matrix-")),
  );
  const ownsOutputRoot = options.outputRoot === undefined;
  const runsRoot = join(outputRoot, "runs");
  const integrityRoot = join(outputRoot, "integrity-keys");
  const previousRunsRoot = process.env.MARTIN_RUNS_DIR;
  const previousIntegrityRoot = process.env.MARTIN_INTEGRITY_KEY_DIR;
  process.env.MARTIN_RUNS_DIR = runsRoot;
  process.env.MARTIN_INTEGRITY_KEY_DIR = integrityRoot;

  try {
    await mkdir(runsRoot, { recursive: true });
    const runtime = options.runtime ?? await loadRuntimeModules();
    const results = [];
    for (const entry of corpus.cases) {
      await persistCase(entry, runsRoot, runtime.persistence);
      const surfaces = options.projectCase
        ? await options.projectCase(entry, { runsRoot, outputRoot, runtime })
        : await projectCase(entry, { runsRoot, outputRoot, runtime });
      assertSurfaceAgreement(entry.id, entry.expected, surfaces);
      results.push({
        id: entry.id,
        status: "passed",
        surfaces: Object.fromEntries(REQUIRED_SURFACES.map((surface) => [surface, "passed"])),
        canonical: entry.expected,
      });
    }

    const summary = {
      schemaVersion: "martin.lifecycle-truth-matrix.v1",
      status: "passed",
      fixturePath,
      fixtureSha256,
      caseCount: results.length,
      surfaceCount: REQUIRED_SURFACES.length,
      results,
    };
    const outputPath = options.outputPath
      ? resolve(options.outputPath)
      : join(outputRoot, "lifecycle-truth-matrix-summary.json");
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    return { summary, outputPath, outputRoot };
  } finally {
    if (previousRunsRoot === undefined) delete process.env.MARTIN_RUNS_DIR;
    else process.env.MARTIN_RUNS_DIR = previousRunsRoot;
    if (previousIntegrityRoot === undefined) delete process.env.MARTIN_INTEGRITY_KEY_DIR;
    else process.env.MARTIN_INTEGRITY_KEY_DIR = previousIntegrityRoot;
    if (ownsOutputRoot && options.keepTemporaryOutput !== true) {
      await rm(outputRoot, { recursive: true, force: true });
    }
  }
}

async function main() {
  const outputArgument = process.argv.find((argument) => argument.startsWith("--output="));
  const outputPath = outputArgument ? outputArgument.slice("--output=".length) : undefined;
  const outputRoot = outputPath ? dirname(resolve(outputPath)) : resolve(ROOT, ".release/lifecycle-truth-matrix");
  const result = await runLifecycleTruthMatrix({
    outputRoot,
    outputPath: outputPath ?? join(outputRoot, "summary.json"),
  });
  process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
