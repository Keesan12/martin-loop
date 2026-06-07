import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateRalphyEngineeringStressReport,
  renderRalphyEngineeringStressMarkdown
} from "./ralphy-stress.js";
import {
  generateUnder3ChallengeReport,
  renderUnder3ChallengeMarkdown
} from "./challenge.js";

const outputDir = fileURLToPath(new URL("../output/", import.meta.url));

function readSuiteId(argv: string[]): string {
  const index = argv.findIndex((token) => token === "--suite");
  return index >= 0 ? (argv[index + 1] ?? "under-3-challenge") : "under-3-challenge";
}

async function writeArtifacts(filePrefix: string, payload: unknown, markdown: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, `${filePrefix}.json`), JSON.stringify(payload, null, 2), "utf8");
  await writeFile(join(outputDir, `${filePrefix}.md`), markdown, "utf8");
}

async function main(): Promise<void> {
  const suiteId = readSuiteId(process.argv.slice(2));

  if (suiteId === "under-3-challenge" || suiteId === "ralphy-smoke") {
    const report = await generateUnder3ChallengeReport();
    const markdown = renderUnder3ChallengeMarkdown(report);
    await writeArtifacts("under-3-challenge-report", report, markdown);
    process.stdout.write(`${markdown}\n`);
    return;
  }

  if (suiteId === "ralphy-engineering-50") {
    const report = await generateRalphyEngineeringStressReport();
    const markdown = renderRalphyEngineeringStressMarkdown(report);
    await writeArtifacts("ralphy-engineering-50-report", report, markdown);
    process.stdout.write(`${markdown}\n`);
    process.exitCode = report.suite.summary.failedCases > 0 ? 1 : 0;
    return;
  }

  throw new Error(`Unknown benchmark suite: ${suiteId}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Benchmark evaluation failed: ${message}\n`);
  process.exitCode = 1;
});
