#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_DOCS = [
  path.join("docs", "ops", "OPERATOR-RUNBOOK.md"),
  path.join("docs", "ops", "INCIDENT-AND-ROLLBACK-RUNBOOK.md"),
  path.join("docs", "pilot", "README.md"),
  path.join("docs", "pilot", "PILOT-DEFAULTS.md"),
  path.join("docs", "pilot", "ARTIFACT-REVIEW-TEMPLATE.md"),
  path.join("docs", "pilot", "STAGING-CHECKLIST.md"),
  path.join("docs", "pilot", "SUCCESS-FAILURE-SCORECARD.md"),
];

const PILOT_DEFAULTS = {
  trustProfile: "strict_local",
  primaryAdapter: "claude_cli",
  requiresCrossPlatformEvidenceBeforePilot: true,
  preparationOnly: true,
};

const REQUIRED_ARTIFACTS = [
  "contract.json",
  "state.json",
  "ledger.jsonl",
  "compiled-context.json",
  "grounding-scan.json",
  "leash.json",
  "rollback-boundary.json",
  "rollback-outcome.json",
];

export async function createPilotPrepReport(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const docs = await loadDocs(rootDir, REQUIRED_DOCS);

  const report = {
    generatedAt: new Date().toISOString(),
    defaults: { ...PILOT_DEFAULTS },
    requiredDocs: REQUIRED_DOCS.map((relativePath) => ({ path: relativePath })),
    docCoverage: {
      operatorRunbook: {
        path: REQUIRED_DOCS[0],
        hasEscalationPath: /## Escalation Path/i.test(docs[REQUIRED_DOCS[0]]),
        hasArtifactLocations:
          docs[REQUIRED_DOCS[0]].includes("~/.martin/runs/<runId>/") &&
          docs[REQUIRED_DOCS[0]].includes("ledger.jsonl"),
      },
      incidentRunbook: {
        path: REQUIRED_DOCS[1],
        hasRollbackProcedure: /## Rollback Procedure/i.test(docs[REQUIRED_DOCS[1]]),
        hasStopUsingCriteria: /Stop using Martin for this repo\/task/i.test(docs[REQUIRED_DOCS[1]]),
      },
      pilotIndex: {
        path: REQUIRED_DOCS[2],
        hasPreparationOnlyWarning: /Phase 14 has not started/i.test(docs[REQUIRED_DOCS[2]]),
        hasCrossPlatformRequirement:
          docs[REQUIRED_DOCS[2]].includes("Windows") &&
          docs[REQUIRED_DOCS[2]].includes("macOS") &&
          docs[REQUIRED_DOCS[2]].includes("Linux"),
      },
      pilotDefaults: {
        path: REQUIRED_DOCS[3],
        hasTrustProfileDefault: docs[REQUIRED_DOCS[3]].includes(PILOT_DEFAULTS.trustProfile),
        hasBudgetDefaults: hasAllStrings(docs[REQUIRED_DOCS[3]], [
          "maxUsd",
          "softLimitUsd",
          "maxIterations",
          "maxTokens",
        ]),
        hasProviderGuidance: hasAllStrings(docs[REQUIRED_DOCS[3]], [
          PILOT_DEFAULTS.primaryAdapter,
          "actual",
          "estimated",
        ]),
      },
      artifactReview: {
        path: REQUIRED_DOCS[4],
        hasRequiredArtifacts: hasAllStrings(docs[REQUIRED_DOCS[4]], REQUIRED_ARTIFACTS),
      },
      stagingChecklist: {
        path: REQUIRED_DOCS[5],
        hasCrossPlatformGate: hasAllStrings(docs[REQUIRED_DOCS[5]], [
          "Windows",
          "macOS",
          "Linux",
          "pnpm rc:validate",
        ]),
      },
      scorecard: {
        path: REQUIRED_DOCS[6],
        hasSuccessCriteria: /## Success Signals/i.test(docs[REQUIRED_DOCS[6]]),
        hasFailureCriteria: /## Failure Signals/i.test(docs[REQUIRED_DOCS[6]]),
      },
    },
  };

  const failures = collectFailures(report);

  return {
    ...report,
    verdict: failures.length === 0 ? "go" : "no_go",
    failures,
  };
}

export function renderPilotPrepReportMarkdown(report) {
  const lines = [
    "# Martin Loop Phase 13 Pilot Prep Audit",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Verdict",
    `**${report.verdict.toUpperCase()}**`,
    "",
    "## Frozen Pilot Defaults",
    `- Trust profile default: \`${report.defaults.trustProfile}\``,
    `- Primary adapter default: \`${report.defaults.primaryAdapter}\``,
    `- Cross-platform evidence required before pilot: ${report.defaults.requiresCrossPlatformEvidenceBeforePilot ? "yes" : "no"}`,
    `- Phase 14 has not started: ${report.defaults.preparationOnly ? "yes" : "no"}`,
    "",
    "## Required Documents",
    ...report.requiredDocs.map((entry) => `- ${normalizeDisplayPath(entry.path)}`),
    "",
    "## Coverage",
    "| Surface | Path | Checks |",
    "|---|---|---|",
    `| Operator runbook | ${normalizeDisplayPath(report.docCoverage.operatorRunbook.path)} | escalation path: ${yesNo(report.docCoverage.operatorRunbook.hasEscalationPath)}, artifact locations: ${yesNo(report.docCoverage.operatorRunbook.hasArtifactLocations)} |`,
    `| Incident and rollback runbook | ${normalizeDisplayPath(report.docCoverage.incidentRunbook.path)} | rollback procedure: ${yesNo(report.docCoverage.incidentRunbook.hasRollbackProcedure)}, stop-using criteria: ${yesNo(report.docCoverage.incidentRunbook.hasStopUsingCriteria)} |`,
    `| Pilot index | ${normalizeDisplayPath(report.docCoverage.pilotIndex.path)} | preparation-only warning: ${yesNo(report.docCoverage.pilotIndex.hasPreparationOnlyWarning)}, cross-platform requirement: ${yesNo(report.docCoverage.pilotIndex.hasCrossPlatformRequirement)} |`,
    `| Pilot defaults | ${normalizeDisplayPath(report.docCoverage.pilotDefaults.path)} | trust default: ${yesNo(report.docCoverage.pilotDefaults.hasTrustProfileDefault)}, budget defaults: ${yesNo(report.docCoverage.pilotDefaults.hasBudgetDefaults)}, provider guidance: ${yesNo(report.docCoverage.pilotDefaults.hasProviderGuidance)} |`,
    `| Artifact review template | ${normalizeDisplayPath(report.docCoverage.artifactReview.path)} | required artifacts: ${yesNo(report.docCoverage.artifactReview.hasRequiredArtifacts)} |`,
    `| Staging checklist | ${normalizeDisplayPath(report.docCoverage.stagingChecklist.path)} | cross-platform gate: ${yesNo(report.docCoverage.stagingChecklist.hasCrossPlatformGate)} |`,
    `| Scorecard | ${normalizeDisplayPath(report.docCoverage.scorecard.path)} | success criteria: ${yesNo(report.docCoverage.scorecard.hasSuccessCriteria)}, failure criteria: ${yesNo(report.docCoverage.scorecard.hasFailureCriteria)} |`,
    "",
    "## Findings",
  ];

  if (report.failures.length === 0) {
    lines.push("- Pilot-prep packaging is complete and Phase 14 remains explicitly gated behind cross-platform evidence.");
  } else {
    lines.push(...report.failures.map((failure) => `- ${failure}`));
  }

  lines.push("");
  return lines.join("\n");
}

export async function writePilotPrepReport(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const outputDir = options.outputDir ?? path.join(rootDir, "docs", "pilot");
  const report = await createPilotPrepReport({ rootDir });
  const markdown = renderPilotPrepReportMarkdown(report);

  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, "PILOT-PREP-REPORT.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(outputDir, "PILOT-PREP-REPORT.md"),
    `${markdown}\n`,
    "utf8",
  );

  return report;
}

async function loadDocs(rootDir, relativePaths) {
  const entries = await Promise.all(
    relativePaths.map(async (relativePath) => {
      const contents = await readFile(path.join(rootDir, relativePath), "utf8");
      return [relativePath, contents];
    }),
  );

  return Object.fromEntries(entries);
}

function hasAllStrings(contents, values) {
  return values.every((value) => contents.includes(value));
}

function collectFailures(report) {
  const failures = [];

  if (!report.docCoverage.operatorRunbook.hasEscalationPath) {
    failures.push("docs/ops/OPERATOR-RUNBOOK.md is missing the escalation path.");
  }
  if (!report.docCoverage.operatorRunbook.hasArtifactLocations) {
    failures.push("docs/ops/OPERATOR-RUNBOOK.md is missing the canonical artifact locations.");
  }
  if (!report.docCoverage.incidentRunbook.hasRollbackProcedure) {
    failures.push("docs/ops/INCIDENT-AND-ROLLBACK-RUNBOOK.md is missing the rollback procedure.");
  }
  if (!report.docCoverage.incidentRunbook.hasStopUsingCriteria) {
    failures.push("docs/ops/INCIDENT-AND-ROLLBACK-RUNBOOK.md is missing explicit stop-using criteria.");
  }
  if (!report.docCoverage.pilotIndex.hasPreparationOnlyWarning) {
    failures.push("docs/pilot/README.md must say that Phase 14 has not started and pilot-prep is preparation only.");
  }
  if (!report.docCoverage.pilotIndex.hasCrossPlatformRequirement) {
    failures.push("docs/pilot/README.md must require Windows, macOS, and Linux evidence before pilot start.");
  }
  if (!report.docCoverage.pilotDefaults.hasTrustProfileDefault) {
    failures.push("docs/pilot/PILOT-DEFAULTS.md must freeze the trust-profile default.");
  }
  if (!report.docCoverage.pilotDefaults.hasBudgetDefaults) {
    failures.push("docs/pilot/PILOT-DEFAULTS.md must capture the pilot budget defaults.");
  }
  if (!report.docCoverage.pilotDefaults.hasProviderGuidance) {
    failures.push("docs/pilot/PILOT-DEFAULTS.md must explain the provider/accounting guidance.");
  }
  if (!report.docCoverage.artifactReview.hasRequiredArtifacts) {
    failures.push("docs/pilot/ARTIFACT-REVIEW-TEMPLATE.md must include the required artifact checklist.");
  }
  if (!report.docCoverage.stagingChecklist.hasCrossPlatformGate) {
    failures.push("docs/pilot/STAGING-CHECKLIST.md must include the cross-platform gate and rc:validate.");
  }
  if (!report.docCoverage.scorecard.hasSuccessCriteria) {
    failures.push("docs/pilot/SUCCESS-FAILURE-SCORECARD.md must include success signals.");
  }
  if (!report.docCoverage.scorecard.hasFailureCriteria) {
    failures.push("docs/pilot/SUCCESS-FAILURE-SCORECARD.md must include failure signals.");
  }

  return failures;
}

function yesNo(value) {
  return value ? "yes" : "no";
}

function normalizeDisplayPath(value) {
  return value.replace(/\\/g, "/");
}

async function main() {
  const rootDir = process.cwd();
  const report = await writePilotPrepReport({ rootDir });
  const markdown = renderPilotPrepReportMarkdown(report);

  process.stdout.write(`${markdown}\n`);
  process.stdout.write(
    `\nArtifacts written to ${path.join(rootDir, "docs", "pilot", "PILOT-PREP-REPORT.json")} and ${path.join(rootDir, "docs", "pilot", "PILOT-PREP-REPORT.md")}\n`,
  );

  process.exitCode = report.verdict === "go" ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === path.resolve(modulePath)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Pilot prep validation failed: ${message}\n`);
    process.exitCode = 1;
  });
}
