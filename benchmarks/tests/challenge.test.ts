import { describe, expect, it } from "vitest";

import {
  generateUnder3ChallengeReport,
  renderUnder3ChallengeMarkdown
} from "../src/index.js";

describe("generateUnder3ChallengeReport", () => {
  it("loads the public under-$3 comparison fixture with the claimed spend figures", async () => {
    const report = await generateUnder3ChallengeReport();

    expect(report.suiteId).toBe("under-3-challenge");
    expect(report.martin.spendUsd).toBe(2.3);
    expect(report.baseline.spendUsd).toBe(5.2);
    expect(report.martin.attempts).toBe(1);
    expect(report.baseline.attempts).toBe(4);
  });

  it("renders markdown that matches the public challenge story", async () => {
    const report = await generateUnder3ChallengeReport();
    const markdown = renderUnder3ChallengeMarkdown(report);

    expect(markdown).toContain("MartinLoop Under-$3 Challenge");
    expect(markdown).toContain("$2.30");
    expect(markdown).toContain("$5.20");
    expect(markdown).toContain("public deterministic fixture");
  });
});
