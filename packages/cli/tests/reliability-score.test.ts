import { describe, expect, it } from "vitest";

import {
  computeMartinReliabilityScore,
  renderMartinReliabilityBadgeJson,
  renderMartinReliabilityBadgeSvg,
  type MartinReliabilityScoreInput
} from "../src/reliability-score.js";

const perfectInput: MartinReliabilityScoreInput = {
  signals: {
    budgetConfigured: {
      present: true,
      detail: "martin.config.yaml sets maxUsd and maxIterations"
    },
    verifierConfigured: {
      present: true,
      detail: "verification plan runs pnpm test"
    },
    runReceiptsPresent: {
      present: true,
      detail: ".martin/runs/run_123/ledger.jsonl exists"
    },
    rollbackEvidencePresent: {
      present: true,
      detail: "rollback note links revert command and safety check"
    },
    mcpDoctorPassing: {
      present: true,
      detail: "martin doctor passed for MCP host config"
    }
  }
};

describe("Martin Reliability Score", () => {
  it("scores perfect evidence as 100 with a readiness grade", () => {
    const score = computeMartinReliabilityScore(perfectInput);

    expect(score.meaning).toBe("five_binary_local_evidence_signals");
    expect(score.signalCount).toBe(5);
    expect(score.totalSignals).toBe(5);
    expect(score.points).toBe(100);
    expect(score.maxPoints).toBe(100);
    expect(score.grade).toBe("ready");
    expect(score.missingReasons).toEqual([]);
    expect(score.signals).toEqual([
      expect.objectContaining({ id: "budgetConfigured", passed: true, points: 20 }),
      expect.objectContaining({ id: "verifierConfigured", passed: true, points: 20 }),
      expect.objectContaining({ id: "runReceiptsPresent", passed: true, points: 20 }),
      expect.objectContaining({ id: "rollbackEvidencePresent", passed: true, points: 20 }),
      expect.objectContaining({ id: "mcpDoctorPassing", passed: true, points: 20 })
    ]);
  });

  it("scores partial evidence honestly with missing-signal reasons", () => {
    const score = computeMartinReliabilityScore({
      signals: {
        budgetConfigured: { present: true },
        verifierConfigured: { present: false, detail: "No --verify command or config rule found" },
        runReceiptsPresent: { present: true },
        rollbackEvidencePresent: {
          present: false,
          detail: "Missing rollback proof at C:\\workspace\\private\\rollback.md"
        },
        mcpDoctorPassing: { present: false, detail: "doctor exited 1" }
      }
    });

    expect(score.points).toBe(40);
    expect(score.signalCount).toBe(2);
    expect(score.totalSignals).toBe(5);
    expect(score.grade).toBe("needs-evidence");
    expect(score.missingReasons).toEqual([
      "Verifier configured: No --verify command or config rule found",
      "Rollback evidence present: Missing rollback proof at [redacted-path]",
      "MCP doctor passing: doctor exited 1"
    ]);
    expect(score.signals.find((signal) => signal.id === "verifierConfigured")).toMatchObject({
      passed: false,
      detail: "No --verify command or config rule found",
      reason: "Verifier configured: No --verify command or config rule found"
    });
    expect(
      score.signals
        .filter((signal) => !signal.passed)
        .every((signal) => typeof signal.reason === "string" && signal.reason.trim().length > 0)
    ).toBe(true);
  });

  it("treats unsigned receipts as missing verified evidence", () => {
    const score = computeMartinReliabilityScore({
      signals: {
        budgetConfigured: { present: true },
        verifierConfigured: { present: true },
        runReceiptsPresent: {
          present: false,
          detail: "Receipt integrity is unsigned."
        },
        rollbackEvidencePresent: { present: true },
        mcpDoctorPassing: { present: true }
      }
    });

    expect(score.points).toBe(80);
    expect(score.grade).toBe("strong");
    expect(score.missingReasons).toContain(
      "Verified run receipts present: Receipt integrity is unsigned."
    );
  });

  it("does not claim statistical or autonomous reliability in score or badge output", () => {
    const score = computeMartinReliabilityScore(perfectInput);
    const combined = [
      JSON.stringify(score),
      renderMartinReliabilityBadgeSvg(score),
      JSON.stringify(renderMartinReliabilityBadgeJson(score))
    ].join("\n");

    expect(combined).not.toMatch(
      /agent reliability|success[ _-]?rate|probability|benchmark|autonom(?:y|ous)/iu
    );
  });

  it("renders deterministic SVG for the same score", () => {
    const score = computeMartinReliabilityScore(perfectInput);

    expect(renderMartinReliabilityBadgeSvg(score)).toBe(renderMartinReliabilityBadgeSvg(score));
  });

  it("redacts absolute paths and escapes text in SVG details", () => {
    const score = computeMartinReliabilityScore({
      signals: {
        budgetConfigured: { present: false, detail: "Missing C:\\workspace\\secret\\budget.yaml" },
        verifierConfigured: { present: false, detail: "Use <script>alert(1)</script> verifier" },
        runReceiptsPresent: { present: false, detail: "No receipts under /Users/keesan/private/runs" },
        rollbackEvidencePresent: { present: false, detail: "No rollback file" },
        mcpDoctorPassing: { present: false, detail: "doctor failed" }
      }
    });

    const svg = renderMartinReliabilityBadgeSvg(score);

    expect(svg).not.toContain("C:\\Users\\ExampleUser");
    expect(svg).not.toContain("/Users/keesan");
    expect(svg).toContain("[redacted-path]");
    expect(svg).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(svg).not.toContain("<script>");
  });

  it("renders a Shields static endpoint compatible JSON shape", () => {
    const score = computeMartinReliabilityScore(perfectInput);

    expect(renderMartinReliabilityBadgeJson(score)).toEqual({
      schemaVersion: 1,
      label: "evidence readiness",
      message: "5/5 ready",
      color: "brightgreen"
    });
  });

  it("renders evidence-readiness signal counts in summaries and SVG", () => {
    const score = computeMartinReliabilityScore(perfectInput);
    const svg = renderMartinReliabilityBadgeSvg(score);

    expect(score.summary).toContain("Evidence readiness: 5/5 signals");
    expect(score.summary).toContain("100/100 readiness points");
    expect(svg).toContain("evidence readiness");
    expect(svg).toContain("5/5 ready");
    expect(svg).not.toContain("100/100");
  });
});
