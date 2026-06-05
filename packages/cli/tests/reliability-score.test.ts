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
          detail: "Missing rollback proof at C:\\Users\\Torram\\private\\rollback.md"
        },
        mcpDoctorPassing: { present: false, detail: "doctor exited 1" }
      }
    });

    expect(score.points).toBe(40);
    expect(score.grade).toBe("needs-evidence");
    expect(score.missingReasons).toEqual([
      "Verifier configured: No --verify command or config rule found",
      "Rollback evidence present: Missing rollback proof at [redacted-path]",
      "MCP doctor passing: doctor exited 1"
    ]);
  });

  it("does not claim autonomous operation in score or badge output", () => {
    const score = computeMartinReliabilityScore(perfectInput);
    const combined = [
      JSON.stringify(score),
      renderMartinReliabilityBadgeSvg(score),
      JSON.stringify(renderMartinReliabilityBadgeJson(score))
    ].join("\n");

    expect(combined).not.toMatch(/autonom(?:y|ous)/iu);
  });

  it("renders deterministic SVG for the same score", () => {
    const score = computeMartinReliabilityScore(perfectInput);

    expect(renderMartinReliabilityBadgeSvg(score)).toBe(renderMartinReliabilityBadgeSvg(score));
  });

  it("redacts absolute paths and escapes text in SVG details", () => {
    const score = computeMartinReliabilityScore({
      signals: {
        budgetConfigured: { present: false, detail: "Missing C:\\Users\\Torram\\secret\\budget.yaml" },
        verifierConfigured: { present: false, detail: "Use <script>alert(1)</script> verifier" },
        runReceiptsPresent: { present: false, detail: "No receipts under /Users/keesan/private/runs" },
        rollbackEvidencePresent: { present: false, detail: "No rollback file" },
        mcpDoctorPassing: { present: false, detail: "doctor failed" }
      }
    });

    const svg = renderMartinReliabilityBadgeSvg(score);

    expect(svg).not.toContain("C:\\Users\\Torram");
    expect(svg).not.toContain("/Users/keesan");
    expect(svg).toContain("[redacted-path]");
    expect(svg).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(svg).not.toContain("<script>");
  });

  it("renders a Shields static endpoint compatible JSON shape", () => {
    const score = computeMartinReliabilityScore(perfectInput);

    expect(renderMartinReliabilityBadgeJson(score)).toEqual({
      schemaVersion: 1,
      label: "agent reliability",
      message: "100/100 ready",
      color: "brightgreen"
    });
  });
});
