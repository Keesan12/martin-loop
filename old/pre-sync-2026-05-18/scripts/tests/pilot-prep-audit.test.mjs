import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPilotPrepReport,
  renderPilotPrepReportMarkdown,
} from "../pilot-prep-audit.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("createPilotPrepReport captures the required pilot-prep package and defaults", async () => {
  const report = await createPilotPrepReport({ rootDir: ROOT_DIR });

  assert.equal(report.requiredDocs.length, 7);
  assert.deepEqual(
    report.requiredDocs.map((entry) => entry.path),
    [
      path.join("docs", "ops", "OPERATOR-RUNBOOK.md"),
      path.join("docs", "ops", "INCIDENT-AND-ROLLBACK-RUNBOOK.md"),
      path.join("docs", "pilot", "README.md"),
      path.join("docs", "pilot", "PILOT-DEFAULTS.md"),
      path.join("docs", "pilot", "ARTIFACT-REVIEW-TEMPLATE.md"),
      path.join("docs", "pilot", "STAGING-CHECKLIST.md"),
      path.join("docs", "pilot", "SUCCESS-FAILURE-SCORECARD.md"),
    ],
  );

  assert.equal(report.defaults.trustProfile, "strict_local");
  assert.equal(report.defaults.primaryAdapter, "claude_cli");
  assert.equal(report.defaults.requiresCrossPlatformEvidenceBeforePilot, true);
  assert.equal(report.defaults.preparationOnly, true);

  assert.equal(report.docCoverage.operatorRunbook.hasEscalationPath, true);
  assert.equal(report.docCoverage.operatorRunbook.hasArtifactLocations, true);
  assert.equal(report.docCoverage.incidentRunbook.hasRollbackProcedure, true);
  assert.equal(report.docCoverage.incidentRunbook.hasStopUsingCriteria, true);
  assert.equal(report.docCoverage.pilotIndex.hasPreparationOnlyWarning, true);
  assert.equal(report.docCoverage.pilotDefaults.hasTrustProfileDefault, true);
  assert.equal(report.docCoverage.pilotDefaults.hasBudgetDefaults, true);
  assert.equal(report.docCoverage.pilotDefaults.hasProviderGuidance, true);
  assert.equal(report.docCoverage.artifactReview.hasRequiredArtifacts, true);
  assert.equal(report.docCoverage.stagingChecklist.hasCrossPlatformGate, true);
  assert.equal(report.docCoverage.scorecard.hasSuccessCriteria, true);
  assert.equal(report.docCoverage.scorecard.hasFailureCriteria, true);
});

test("renderPilotPrepReportMarkdown lists the pilot docs and gate status", async () => {
  const report = await createPilotPrepReport({ rootDir: ROOT_DIR });
  const markdown = renderPilotPrepReportMarkdown(report);

  assert.match(markdown, /^# Martin Loop Phase 13 Pilot Prep Audit/m);
  assert.match(markdown, /strict_local/);
  assert.match(markdown, /claude_cli/);
  assert.match(markdown, /docs\/ops\/OPERATOR-RUNBOOK.md/);
  assert.match(markdown, /docs\/pilot\/STAGING-CHECKLIST.md/);
  assert.match(markdown, /Phase 14 has not started/);
});
