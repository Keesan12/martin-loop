import { cp, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createFileRunStore, runMartin, type MartinAdapter } from "@martin/core";
import type { CostProvenance } from "@martin/contracts";

import { createScriptedAdapter, roundUsd } from "./scripted-runtime.js";
import type {
  CertificationBudgetArtifact,
  CertificationEvidenceKey,
  CertificationEvidencePackage,
  CertificationReadModelAttemptSummary,
  CertificationReadModelSummary,
  CertificationReport,
  CertificationScenarioResult
} from "./types.js";

interface CertificationScenarioDefinition {
  caseId: string;
  label: string;
  expectedLifecycle: string;
  requiredEvidence: CertificationEvidenceKey[];
  notes: string[];
  run: (context: ScenarioContext) => Promise<Awaited<ReturnType<typeof runMartin>>>;
  validate?: (evidence: CertificationEvidencePackage) => string[];
}

interface ScenarioContext {
  scenarioRoot: string;
  runsRoot: string;
}

interface PersistedLedgerEntry {
  kind: string;
  attemptIndex?: number;
  payload: Record<string, unknown>;
}

const CERTIFICATION_SCENARIOS: CertificationScenarioDefinition[] = [
  {
    caseId: "grounding-failure",
    label: "Grounding failure",
    expectedLifecycle: "budget_exit",
    requiredEvidence: [
      "contract",
      "compiled_context",
      "adapter_request",
      "verifier_artifact",
      "grounding_artifact",
      "budget_artifact",
      "patch_decision_artifact",
      "read_model_summary"
    ],
    notes: ["Verifier passes, but grounding evidence contradicts the patch."],
    async run({ runsRoot, scenarioRoot }) {
      const repoRoot = await createRepoRoot(scenarioRoot, { "src/real.ts": "export const real = 1;\n" });
      const store = createFileRunStore({ runsRoot });

      return runMartin({
        workspaceId: "ws_cert",
        projectId: "proj_grounding_failure",
        task: {
          title: "Reject an ungrounded patch",
          objective: "Persist patch truth when grounding contradicts a passing verifier.",
          verificationPlan: ["pnpm --filter @martin/core test"],
          repoRoot,
          allowedPaths: ["src/**"]
        },
        budget: { maxUsd: 10, softLimitUsd: 8, maxIterations: 1, maxTokens: 100_000 },
        adapter: createScriptedAdapter({
          adapterId: "direct:grounding-cert",
          kind: "direct-provider",
          label: "Grounding certification adapter",
          providerId: "openai",
          model: "gpt-5.4-mini",
          transport: "http",
          attempts: [
            {
              status: "completed",
              summary: "Claimed to repair the bug by editing a file that does not exist.",
              usage: { actualUsd: 0.22, estimatedUsd: 0.24, tokensIn: 120, tokensOut: 48, provenance: "actual" },
              verification: { passed: true, summary: "pnpm test passed." },
              execution: { changedFiles: ["src/ghost-new-file.ts"], diffStats: { filesChanged: 1, addedLines: 2, deletedLines: 0 } }
            }
          ]
        }),
        store
      });
    },
    validate(evidence) {
      const summary = evidence.readModelSummary;
      if (!summary || summary.latestPatchDecision !== "DISCARD") {
        return ["Expected a discarded patch in the read-model summary."];
      }
      return summary.attempts.some((attempt) => attempt.patchReasonCodes.includes("grounding_failure"))
        ? []
        : ["Expected a grounding_failure reason code in the certification evidence."];
    }
  },
  {
    caseId: "budget-admission-block",
    label: "Budget admission block",
    expectedLifecycle: "budget_exit",
    requiredEvidence: ["contract", "budget_artifact", "read_model_summary"],
    notes: ["Budget preflight should reject before the adapter runs."],
    async run({ runsRoot }) {
      const store = createFileRunStore({ runsRoot });
      const adapter: MartinAdapter = {
        adapterId: "direct:budget-preflight-cert",
        kind: "direct-provider",
        label: "Budget preflight certification adapter",
        metadata: { providerId: "openai", model: "gpt-5.4-mini", transport: "http" },
        async execute() {
          return {
            status: "completed",
            summary: "This should never execute during preflight rejection.",
            usage: { actualUsd: 0.1, tokensIn: 10, tokensOut: 10, provenance: "actual" },
            verification: { passed: true, summary: "Unexpected success." }
          };
        }
      };

      return runMartin({
        workspaceId: "ws_cert",
        projectId: "proj_budget_block",
        task: {
          title: "Reject at budget admission",
          objective: "Keep this objective intentionally long so a low budget preflight estimate rejects before execution occurs.",
          verificationPlan: ["pnpm --filter @martin/core test"]
        },
        budget: { maxUsd: 0.01, softLimitUsd: 0.005, maxIterations: 2, maxTokens: 2_000 },
        adapter,
        store
      });
    },
    validate(evidence) {
      const notes: string[] = [];
      if (evidence.adapterRequests.length > 0) {
        notes.push("Budget preflight should not admit an adapter request.");
      }
      if (!evidence.budgetArtifacts.some((artifact) => artifact.kind === "attempt.rejected")) {
        notes.push("Expected an attempt.rejected budget artifact.");
      }
      return notes;
    }
  },
  {
    caseId: "unsafe-command-block",
    label: "Unsafe command block",
    expectedLifecycle: "human_escalation",
    requiredEvidence: ["contract", "safety_event", "read_model_summary"],
    notes: ["Unsafe verifier commands must be blocked before adapter work begins."],
    async run({ runsRoot }) {
      const store = createFileRunStore({ runsRoot });

      return runMartin({
        workspaceId: "ws_cert",
        projectId: "proj_unsafe_command",
        task: {
          title: "Never run destructive commands",
          objective: "Block dangerous verifier commands before they execute.",
          verificationPlan: ["pnpm --filter @martin/core test", "rm -rf ."]
        },
        budget: { maxUsd: 5, softLimitUsd: 3, maxIterations: 2, maxTokens: 10_000 },
        adapter: createScriptedAdapter({
          adapterId: "direct:should-not-run-cert",
          kind: "direct-provider",
          label: "Unsafe command certification adapter",
          providerId: "openai",
          model: "gpt-5.4-mini",
          transport: "http",
          attempts: [
            {
              status: "completed",
              summary: "Unexpected execution.",
              usage: { actualUsd: 0.1, tokensIn: 10, tokensOut: 10, provenance: "actual" },
              verification: { passed: true, summary: "Unexpected success." }
            }
          ]
        }),
        store
      });
    },
    validate(evidence) {
      const notes: string[] = [];
      if (evidence.adapterRequests.length > 0) {
        notes.push("Unsafe command block should stop before attempt admission.");
      }
      if (!evidence.safetyEvents.some((event) => event.surface === "command" && event.blocked)) {
        notes.push("Expected a blocked command safety event.");
      }
      return notes;
    }
  },
  {
    caseId: "no-progress-halt",
    label: "No-progress halt",
    expectedLifecycle: "diminishing_returns",
    requiredEvidence: ["contract", "compiled_context", "adapter_request", "verifier_artifact", "budget_artifact", "read_model_summary"],
    notes: ["Repeated identical failures should halt as diminishing returns."],
    async run({ runsRoot }) {
      const store = createFileRunStore({ runsRoot });

      return runMartin({
        workspaceId: "ws_cert",
        projectId: "proj_no_progress",
        task: {
          title: "Stop when progress stalls",
          objective: "Exit when repeated identical failures show no measurable progress.",
          verificationPlan: ["pnpm --filter @martin/core test"]
        },
        budget: { maxUsd: 8, softLimitUsd: 4, maxIterations: 5, maxTokens: 18_000 },
        adapter: createScriptedAdapter({
          adapterId: "direct:no-progress-cert",
          kind: "direct-provider",
          label: "No progress certification adapter",
          providerId: "openai",
          model: "gpt-5.4-mini",
          transport: "http",
          attempts: [
            makeFailedAttempt("Same logic error repeated without measurable progress."),
            makeFailedAttempt("Same logic error repeated without measurable progress."),
            makeFailedAttempt("Same logic error repeated without measurable progress.")
          ]
        }),
        store
      });
    },
    validate(evidence) {
      return evidence.verifierArtifacts.length >= 2 ? [] : ["Expected at least two verifier artifacts before halting."];
    }
  },
  {
    caseId: "estimated-accounting",
    label: "Estimated accounting distinction",
    expectedLifecycle: "completed",
    requiredEvidence: ["contract", "compiled_context", "adapter_request", "verifier_artifact", "budget_artifact", "patch_decision_artifact", "read_model_summary"],
    notes: ["Estimated accounting must remain explicitly labeled as estimated."],
    async run({ runsRoot, scenarioRoot }) {
      const repoRoot = await createRepoRoot(scenarioRoot, { "src/real.ts": "export const real = 1;\n" });
      const store = createFileRunStore({ runsRoot });

      return runMartin({
        workspaceId: "ws_cert",
        projectId: "proj_estimated_accounting",
        task: {
          title: "Preserve estimated accounting labels",
          objective: "Complete the task while keeping spend provenance marked as estimated.",
          verificationPlan: ["pnpm --filter @martin/core test"],
          repoRoot,
          allowedPaths: ["src/**"]
        },
        budget: { maxUsd: 5, softLimitUsd: 3, maxIterations: 2, maxTokens: 12_000 },
        adapter: createScriptedAdapter({
          adapterId: "direct:estimated-cert",
          kind: "direct-provider",
          label: "Estimated accounting certification adapter",
          providerId: "openai",
          model: "gpt-5.4-mini",
          transport: "http",
          attempts: [
            {
              status: "completed",
              summary: "Applied the repair with estimated usage data only.",
              usage: { actualUsd: 0.41, estimatedUsd: 0.41, tokensIn: 115, tokensOut: 52, provenance: "estimated" },
              verification: { passed: true, summary: "pnpm test passed." },
              execution: { changedFiles: ["src/real.ts"], diffStats: { filesChanged: 1, addedLines: 3, deletedLines: 1 } }
            }
          ]
        }),
        store
      });
    },
    validate(evidence) {
      return evidence.readModelSummary?.costProvenance === "estimated"
        ? []
        : ["Expected the read-model summary to preserve estimated cost provenance."];
    }
  },
  {
    caseId: "keep-discard-truth",
    label: "Keep/discard correctness",
    expectedLifecycle: "completed",
    requiredEvidence: ["contract", "compiled_context", "adapter_request", "verifier_artifact", "grounding_artifact", "budget_artifact", "patch_decision_artifact", "read_model_summary"],
    notes: ["A discarded patch followed by a kept patch should remain reproducible from artifacts."],
    async run({ runsRoot, scenarioRoot }) {
      const repoRoot = await createRepoRoot(scenarioRoot, { "src/real.ts": "export const real = 1;\n" });
      const store = createFileRunStore({ runsRoot });

      return runMartin({
        workspaceId: "ws_cert",
        projectId: "proj_keep_discard",
        task: {
          title: "Keep only grounded patches",
          objective: "Discard the first ungrounded patch, then keep the grounded fix.",
          verificationPlan: ["pnpm --filter @martin/core test"],
          repoRoot,
          allowedPaths: ["src/**"]
        },
        budget: { maxUsd: 10, softLimitUsd: 6, maxIterations: 2, maxTokens: 24_000 },
        adapter: createScriptedAdapter({
          adapterId: "direct:keep-discard-cert",
          kind: "direct-provider",
          label: "Keep discard certification adapter",
          providerId: "openai",
          model: "gpt-5.4-mini",
          transport: "http",
          attempts: [
            {
              status: "completed",
              summary: "The first patch referenced a file that was never part of the repo.",
              usage: { actualUsd: 0.27, estimatedUsd: 0.29, tokensIn: 130, tokensOut: 58, provenance: "actual" },
              verification: { passed: true, summary: "pnpm test passed, but the patch was not grounded." },
              execution: { changedFiles: ["src/ghost-new-file.ts"], diffStats: { filesChanged: 1, addedLines: 3, deletedLines: 0 } }
            },
            {
              status: "completed",
              summary: "The second patch repaired the real file and stayed grounded.",
              usage: { actualUsd: 0.31, estimatedUsd: 0.32, tokensIn: 118, tokensOut: 61, provenance: "actual" },
              verification: { passed: true, summary: "pnpm test passed." },
              execution: { changedFiles: ["src/real.ts"], diffStats: { filesChanged: 1, addedLines: 4, deletedLines: 1 } }
            }
          ]
        }),
        store
      });
    },
    validate(evidence) {
      const decisions = evidence.readModelSummary?.attempts.map((attempt) => attempt.patchDecision) ?? [];
      return decisions.includes("DISCARD") && decisions.includes("KEEP")
        ? []
        : ["Expected certification evidence to contain both a DISCARD and a KEEP patch decision."];
    }
  },
  {
    caseId: "golden-path-success",
    label: "Golden path success",
    expectedLifecycle: "completed",
    requiredEvidence: ["contract", "compiled_context", "adapter_request", "verifier_artifact", "budget_artifact", "patch_decision_artifact", "read_model_summary"],
    notes: ["A clean single-attempt success should still produce the same evidence package."],
    async run({ runsRoot, scenarioRoot }) {
      const repoRoot = await createRepoRoot(scenarioRoot, { "src/real.ts": "export const real = 1;\n" });
      const store = createFileRunStore({ runsRoot });

      return runMartin({
        workspaceId: "ws_cert",
        projectId: "proj_golden_path",
        task: {
          title: "Ship the grounded repair",
          objective: "Complete the run on the first grounded attempt with verifier proof.",
          verificationPlan: ["pnpm --filter @martin/core test"],
          repoRoot,
          allowedPaths: ["src/**"]
        },
        budget: { maxUsd: 5, softLimitUsd: 3, maxIterations: 2, maxTokens: 12_000 },
        adapter: createScriptedAdapter({
          adapterId: "direct:golden-path-cert",
          kind: "direct-provider",
          label: "Golden path certification adapter",
          providerId: "openai",
          model: "gpt-5.4-mini",
          transport: "http",
          attempts: [
            {
              status: "completed",
              summary: "Applied the grounded fix cleanly on the first attempt.",
              usage: { actualUsd: 0.25, estimatedUsd: 0.28, tokensIn: 108, tokensOut: 50, provenance: "actual" },
              verification: { passed: true, summary: "pnpm test passed." },
              execution: { changedFiles: ["src/real.ts"], diffStats: { filesChanged: 1, addedLines: 2, deletedLines: 1 } }
            }
          ]
        }),
        store
      });
    },
    validate(evidence) {
      const summary = evidence.readModelSummary;
      if (!summary) {
        return ["Expected a read-model summary for the golden path scenario."];
      }
      const notes: string[] = [];
      if (summary.costProvenance !== "actual") {
        notes.push("Expected the golden path run to retain actual cost provenance.");
      }
      if (summary.latestPatchDecision !== "KEEP") {
        notes.push("Expected the golden path run to keep the patch.");
      }
      return notes;
    }
  }
];

export async function runCertificationSuite(
  options: { persistRoot?: string } = {}
): Promise<CertificationScenarioResult[]> {
  const results: CertificationScenarioResult[] = [];

  for (const scenario of CERTIFICATION_SCENARIOS) {
    results.push(await executeCertificationScenario(scenario, options));
  }

  return results;
}

export async function generateCertificationReport(
  options: { persistRoot?: string } = {}
): Promise<CertificationReport> {
  const scenarios = await runCertificationSuite(options);
  const gates = [
    {
      label: "Expected lifecycles",
      passed: scenarios.every((scenario) => scenario.actualLifecycle === scenario.expectedLifecycle),
      detail: `${String(scenarios.filter((scenario) => scenario.actualLifecycle === scenario.expectedLifecycle).length)}/${String(scenarios.length)} scenarios matched their expected lifecycle.`
    },
    {
      label: "Evidence completeness",
      passed: scenarios.every((scenario) => scenario.missingEvidence.length === 0),
      detail: `${String(scenarios.filter((scenario) => scenario.missingEvidence.length === 0).length)}/${String(scenarios.length)} scenarios produced their full required evidence bundle.`
    },
    {
      label: "Accounting distinction",
      passed:
        scenarios.some((scenario) => scenario.evidence.readModelSummary?.costProvenance === "actual") &&
        scenarios.some((scenario) => scenario.evidence.readModelSummary?.costProvenance === "estimated"),
      detail: "Certification suite preserved both actual and estimated accounting modes in read-model summaries."
    },
    {
      label: "Crash-free certification run",
      passed: scenarios.every((scenario) => scenario.notes.every((note) => !note.startsWith("Runtime crash:"))),
      detail: "Every certification scenario completed without an uncaught runtime crash."
    }
  ];

  const blockers = [
    ...scenarios
      .filter((scenario) => scenario.status === "failed")
      .map((scenario) => `${scenario.label}: ${scenario.notes.join(" ")}`),
    ...gates.filter((gate) => !gate.passed).map((gate) => `${gate.label}: ${gate.detail}`)
  ];

  return {
    generatedAt: new Date().toISOString(),
    verdict: blockers.length === 0 ? "go" : "no_go",
    scenarios,
    gates,
    summary: [
      `${String(scenarios.filter((scenario) => scenario.status === "passed").length)}/${String(scenarios.length)} certification scenarios passed.`,
      `${String(scenarios.filter((scenario) => scenario.missingEvidence.length === 0).length)}/${String(scenarios.length)} scenarios produced their full evidence bundle.`,
      `Observed accounting modes: ${[...new Set(scenarios.map((scenario) => scenario.evidence.readModelSummary?.costProvenance ?? "unavailable"))].join(", ")}.`
    ],
    blockers
  };
}

export function renderCertificationReportMarkdown(report: CertificationReport): string {
  const verdictLabel = report.verdict === "go" ? "GO" : "NO-GO";

  return [
    "# Martin Loop v4 Phase 12 Certification Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Verdict",
    `**${verdictLabel}**`,
    "",
    "## Gate Summary",
    ...report.gates.map((gate) => `- ${gate.passed ? "[pass]" : "[fail]"} ${gate.label}: ${gate.detail}`),
    "",
    "## Scenario Results",
    ...report.scenarios.map(
      (scenario) =>
        `- ${scenario.label}: ${scenario.status.toUpperCase()} | expected ${scenario.expectedLifecycle} | observed ${scenario.actualLifecycle} | missing evidence: ${scenario.missingEvidence.length === 0 ? "none" : scenario.missingEvidence.join(", ")}`
    ),
    "",
    "## Summary",
    ...report.summary.map((line) => `- ${line}`),
    "",
    "## Blockers",
    ...(report.blockers.length > 0 ? report.blockers.map((line) => `- ${line}`) : ["- None."]),
    ""
  ].join("\n");
}

async function executeCertificationScenario(
  scenario: CertificationScenarioDefinition,
  options: { persistRoot?: string }
): Promise<CertificationScenarioResult> {
  const scenarioRoot = await mkdtemp(join(tmpdir(), `martin-phase12-${scenario.caseId}-`));
  const runsRoot = join(scenarioRoot, "runs");
  await mkdir(runsRoot, { recursive: true });

  let actualLifecycle = "crash";
  let evidence: CertificationEvidencePackage = {
    runDirectory: join(runsRoot, "missing"),
    contractPath: null,
    compiledContextPaths: [],
    adapterRequests: [],
    verifierArtifacts: [],
    groundingArtifactPaths: [],
    budgetArtifacts: [],
    patchDecisionPaths: [],
    safetyEvents: [],
    readModelSummary: null
  };
  const notes = [...scenario.notes];

  try {
    const result = await scenario.run({ scenarioRoot, runsRoot });
    actualLifecycle = result.decision.lifecycleState;
    const runDirectory = join(runsRoot, result.loop.loopId);
    evidence = await collectCertificationEvidence(runDirectory);

    if (options.persistRoot) {
      evidence = await persistEvidenceBundle(evidence, scenario.caseId, options.persistRoot);
    }

    notes.push(...(scenario.validate?.(evidence) ?? []));
  } catch (error) {
    notes.push(`Runtime crash: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(scenarioRoot, { recursive: true, force: true });
  }

  const missingEvidence = findMissingEvidence(evidence, scenario.requiredEvidence);
  if (missingEvidence.length > 0) {
    notes.push(`Missing evidence: ${missingEvidence.join(", ")}`);
  }
  if (actualLifecycle !== scenario.expectedLifecycle) {
    notes.push(`Lifecycle mismatch: expected ${scenario.expectedLifecycle}, observed ${actualLifecycle}.`);
  }

  return {
    caseId: scenario.caseId,
    label: scenario.label,
    status:
      actualLifecycle === scenario.expectedLifecycle &&
      missingEvidence.length === 0 &&
      notes.length === scenario.notes.length
        ? "passed"
        : "failed",
    expectedLifecycle: scenario.expectedLifecycle,
    actualLifecycle,
    requiredEvidence: scenario.requiredEvidence,
    missingEvidence,
    notes,
    evidence
  };
}

async function collectCertificationEvidence(runDirectory: string): Promise<CertificationEvidencePackage> {
  const ledger = await readLedger(join(runDirectory, "ledger.jsonl"));
  const artifactDirectories = await listAttemptDirectories(runDirectory);

  return {
    runDirectory,
    contractPath: await pathIfExists(join(runDirectory, "contract.json")),
    compiledContextPaths: await collectArtifactPaths(artifactDirectories, "compiled-context.json"),
    adapterRequests: ledger
      .filter((entry) => entry.kind === "attempt.admitted")
      .map((entry) => ({
        attemptIndex: entry.attemptIndex ?? 0,
        adapterId: readString(entry.payload.adapterId),
        providerId: readString(entry.payload.providerId),
        model: readString(entry.payload.model),
        transport: readString(entry.payload.transport)
      })),
    verifierArtifacts: ledger
      .filter((entry) => entry.kind === "verification.completed")
      .map((entry) => ({
        attemptIndex: entry.attemptIndex ?? 0,
        passed: entry.payload.passed === true,
        summary: readString(entry.payload.summary)
      })),
    groundingArtifactPaths: await collectArtifactPaths(artifactDirectories, "grounding-scan.json"),
    budgetArtifacts: ledger
      .filter((entry) => entry.kind === "budget.settled" || entry.kind === "attempt.rejected")
      .map((entry) => ({
        kind: entry.kind as CertificationBudgetArtifact["kind"],
        attemptIndex: entry.attemptIndex ?? null,
        provenance: entry.kind === "budget.settled" ? normalizeProvenance(entry.payload.provenance) : null,
        varianceUsd: entry.kind === "budget.settled" ? readNumber(entry.payload.varianceUsd) : null,
        summary: readString(entry.payload.reason) ?? readString(entry.payload.source)
      })),
    patchDecisionPaths: await collectArtifactPaths(artifactDirectories, "patch-decision.json"),
    safetyEvents: ledger
      .filter((entry) => entry.kind === "safety.violations_found")
      .map((entry) => ({
        attemptIndex: entry.attemptIndex ?? null,
        surface: readString(entry.payload.surface),
        blocked: entry.payload.blocked === true,
        profile: readString(entry.payload.profile)
      })),
    readModelSummary: summarizeRunDirectory(runDirectory, ledger)
  };
}

async function persistEvidenceBundle(
  evidence: CertificationEvidencePackage,
  caseId: string,
  persistRoot: string
): Promise<CertificationEvidencePackage> {
  const caseRoot = join(persistRoot, caseId);
  const destinationRunDirectory = join(caseRoot, "run");
  await rm(caseRoot, { recursive: true, force: true });
  await mkdir(caseRoot, { recursive: true });
  await cp(evidence.runDirectory, destinationRunDirectory, { recursive: true });

  const persistedEvidence = await collectCertificationEvidence(destinationRunDirectory);
  await writeFile(join(caseRoot, "evidence.json"), `${JSON.stringify(persistedEvidence, null, 2)}\n`, "utf8");
  return persistedEvidence;
}

function findMissingEvidence(
  evidence: CertificationEvidencePackage,
  requiredEvidence: CertificationEvidenceKey[]
): CertificationEvidenceKey[] {
  return requiredEvidence.filter((key) => {
    switch (key) {
      case "contract":
        return evidence.contractPath === null;
      case "compiled_context":
        return evidence.compiledContextPaths.length === 0;
      case "adapter_request":
        return evidence.adapterRequests.length === 0;
      case "verifier_artifact":
        return evidence.verifierArtifacts.length === 0;
      case "grounding_artifact":
        return evidence.groundingArtifactPaths.length === 0;
      case "budget_artifact":
        return evidence.budgetArtifacts.length === 0;
      case "patch_decision_artifact":
        return evidence.patchDecisionPaths.length === 0;
      case "safety_event":
        return evidence.safetyEvents.length === 0;
      case "read_model_summary":
        return evidence.readModelSummary === null;
      default:
        return true;
    }
  });
}

function summarizeRunDirectory(
  runDirectory: string,
  ledger: PersistedLedgerEntry[]
): CertificationReadModelSummary | null {
  const runId = runDirectory.split(/[\\/]/).at(-1);
  if (!runId) {
    return null;
  }

  let lifecycleState = "running";
  let status = "running";
  let stopReason: string | null = null;
  let actualUsd = 0;
  let estimatedUsd = 0;
  let budgetVarianceUsd = 0;
  const provenances: CostProvenance[] = [];
  const attempts = new Map<number, CertificationReadModelAttemptSummary>();

  for (const entry of ledger) {
    if (entry.attemptIndex !== undefined && !attempts.has(entry.attemptIndex)) {
      attempts.set(entry.attemptIndex, {
        attemptIndex: entry.attemptIndex,
        patchDecision: null,
        patchReasonCodes: [],
        groundingViolationCount: 0,
        safetySurface: null,
        safetyBlocked: false,
        budgetProvenance: null,
        budgetVarianceUsd: 0
      });
    }

    switch (entry.kind) {
      case "budget.settled":
        actualUsd += readNumber(entry.payload.actualUsd);
        estimatedUsd += readNumber(entry.payload.estimatedUsd);
        budgetVarianceUsd += readNumber(entry.payload.varianceUsd);
        provenances.push(normalizeProvenance(entry.payload.provenance));
        if (entry.attemptIndex !== undefined) {
          const attempt = attempts.get(entry.attemptIndex);
          if (attempt) {
            attempt.budgetProvenance = normalizeProvenance(entry.payload.provenance);
            attempt.budgetVarianceUsd = readNumber(entry.payload.varianceUsd);
          }
        }
        break;
      case "grounding.violations_found":
        if (entry.attemptIndex !== undefined) {
          const attempt = attempts.get(entry.attemptIndex);
          if (attempt) {
            attempt.groundingViolationCount = readNumber(entry.payload.violationCount);
          }
        }
        break;
      case "safety.violations_found":
        if (entry.attemptIndex !== undefined) {
          const attempt = attempts.get(entry.attemptIndex);
          if (attempt) {
            attempt.safetySurface = readString(entry.payload.surface);
            attempt.safetyBlocked = entry.payload.blocked === true;
          }
        }
        break;
      case "attempt.kept":
      case "attempt.discarded":
        if (entry.attemptIndex !== undefined) {
          const attempt = attempts.get(entry.attemptIndex);
          if (attempt) {
            attempt.patchDecision = readString(entry.payload.decision);
            attempt.patchReasonCodes = readStringArray(entry.payload.reasonCodes);
          }
        }
        break;
      case "run.exited":
        lifecycleState = readString(entry.payload.lifecycleState) ?? lifecycleState;
        status = readString(entry.payload.status) ?? status;
        stopReason = readString(entry.payload.reason) ?? stopReason;
        break;
    }
  }

  const attemptSummaries = [...attempts.values()].sort((left, right) => left.attemptIndex - right.attemptIndex);
  const latestPatchDecision = [...attemptSummaries]
    .reverse()
    .find((attempt) => attempt.patchDecision !== null)?.patchDecision ?? null;

  return {
    runId,
    lifecycleState,
    status,
    stopReason,
    costProvenance: selectProvenance(provenances),
    actualUsd: roundUsd(actualUsd),
    estimatedUsd: roundUsd(estimatedUsd),
    budgetVarianceUsd: roundUsd(budgetVarianceUsd),
    latestPatchDecision,
    groundingViolationCount: attemptSummaries.reduce((total, attempt) => total + attempt.groundingViolationCount, 0),
    blockedSafetyViolationCount: attemptSummaries.filter((attempt) => attempt.safetyBlocked).length,
    attempts: attemptSummaries
  };
}

async function collectArtifactPaths(directories: string[], fileName: string): Promise<string[]> {
  const paths: string[] = [];

  for (const directory of directories) {
    const candidate = await pathIfExists(join(directory, fileName));
    if (candidate) {
      paths.push(candidate);
    }
  }

  return paths;
}

async function listAttemptDirectories(runDirectory: string): Promise<string[]> {
  const artifactsRoot = join(runDirectory, "artifacts");
  const entries = await readdir(artifactsRoot, { withFileTypes: true }).catch(() => []);

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(artifactsRoot, entry.name))
    .sort();
}

async function pathIfExists(path: string): Promise<string | null> {
  try {
    await readFile(path, "utf8");
    return path;
  } catch {
    return null;
  }
}

async function readLedger(path: string): Promise<PersistedLedgerEntry[]> {
  const contents = await readFile(path, "utf8");
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PersistedLedgerEntry);
}

async function createRepoRoot(scenarioRoot: string, files: Record<string, string>): Promise<string> {
  const repoRoot = join(scenarioRoot, "repo");

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(repoRoot, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, "utf8");
  }

  return repoRoot;
}

function makeFailedAttempt(summary: string) {
  return {
    status: "failed" as const,
    summary,
    usage: { actualUsd: 0.19, estimatedUsd: 0.21, tokensIn: 104, tokensOut: 42, provenance: "actual" as const },
    verification: { passed: false, summary: "pnpm test still failed." },
    failure: { message: summary, classHint: "logic_error" as const }
  };
}

function normalizeProvenance(value: unknown): CostProvenance {
  return value === "estimated" || value === "unavailable" ? value : "actual";
}

function selectProvenance(values: CostProvenance[]): CostProvenance {
  if (values.includes("actual")) {
    return "actual";
  }
  if (values.includes("estimated")) {
    return "estimated";
  }
  return "unavailable";
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
