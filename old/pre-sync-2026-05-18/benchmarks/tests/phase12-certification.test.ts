import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  generateCertificationReport,
  renderCertificationReportMarkdown,
  runCertificationSuite
} from "../src/index.js";

describe("Phase 12 certification harness", () => {
  it("replays the required certification scenarios with evidence-complete outputs", async () => {
    const scenarios = await runCertificationSuite();

    expect(scenarios.map((scenario) => scenario.caseId)).toEqual([
      "grounding-failure",
      "budget-admission-block",
      "unsafe-command-block",
      "no-progress-halt",
      "estimated-accounting",
      "keep-discard-truth",
      "golden-path-success"
    ]);
    expect(scenarios.every((scenario) => scenario.status === "passed")).toBe(true);
    expect(scenarios.every((scenario) => scenario.missingEvidence.length === 0)).toBe(true);
  });

  it("produces a certification report suitable for claim freeze and release gating", async () => {
    const report = await generateCertificationReport();
    const markdown = renderCertificationReportMarkdown(report);

    expect(report.verdict).toBe("go");
    expect(report.gates.every((gate) => gate.passed)).toBe(true);
    expect(markdown).toContain("# Martin Loop v4 Phase 12 Certification Report");
    expect(markdown).toContain("## Gate Summary");
    expect(markdown).toContain("GO");
  });

  it("rewrites persisted certification evidence cleanly across repeated runs", { timeout: 15000 }, async () => {
    const persistRoot = await mkdtemp(join(tmpdir(), "martin-phase12-persist-"));

    try {
      const firstReport = await generateCertificationReport({ persistRoot });
      const secondReport = await generateCertificationReport({ persistRoot });

      expect(firstReport.verdict).toBe("go");
      expect(secondReport.verdict).toBe("go");
      expect(secondReport.scenarios.every((scenario) => scenario.status === "passed")).toBe(true);
    } finally {
      await rm(persistRoot, { recursive: true, force: true });
    }
  });
});
