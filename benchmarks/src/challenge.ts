import { roundUsd } from "./scripted-runtime.js";
import { loadUnder3ChallengeFixture } from "./fixtures.js";
import type { Under3ChallengeReport } from "./types.js";

export async function generateUnder3ChallengeReport(
  options: { now?: () => string } = {}
): Promise<Under3ChallengeReport> {
  const now = options.now ?? (() => new Date().toISOString());
  const fixture = await loadUnder3ChallengeFixture();

  return {
    ...fixture,
    generatedAt: now(),
    martinSpendDeltaUsd: roundUsd(fixture.martin.spendUsd - fixture.baseline.spendUsd)
  };
}

export function renderUnder3ChallengeMarkdown(report: Under3ChallengeReport): string {
  return [
    "# MartinLoop Under-$3 Challenge",
    "",
    `Generated: ${report.generatedAt}`,
    `Suite: ${report.label} (${report.suiteId})`,
    "",
    "## Task",
    "",
    `- ${report.task.title}`,
    `- Objective: ${report.task.objective}`,
    "",
    "## Result",
    "",
    `- MartinLoop: $${report.martin.spendUsd.toFixed(2)} across ${String(report.martin.attempts)} attempt(s); ${report.martin.status}/${report.martin.lifecycleState}; verifier ${report.martin.verifierStatus}.`,
    `- Uncontrolled retry loop: $${report.baseline.spendUsd.toFixed(2)} across ${String(report.baseline.attempts)} attempt(s); ${report.baseline.status}/${report.baseline.lifecycleState}; verifier ${report.baseline.verifierStatus}.`,
    `- Spend delta: $${Math.abs(report.martinSpendDeltaUsd).toFixed(2)} ${report.martinSpendDeltaUsd <= 0 ? "less than" : "more than"} the uncontrolled baseline.`,
    "",
    "## Why it passes the public trust bar",
    "",
    "- The numbers come from a public deterministic fixture in this repository.",
    "- The same fixture powers README, challenge-page, and CLI bench output.",
    "- The comparison is reproducible with `pnpm --filter @martin/benchmarks eval`."
  ].join("\n");
}
