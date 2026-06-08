import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateRalphyEngineeringStressReport,
  renderRalphyEngineeringStressMarkdown
} from "./ralphy-stress.js";

const outputDir = fileURLToPath(new URL("../../output/", import.meta.url));

async function main(): Promise<void> {
  const report = await generateRalphyEngineeringStressReport();
  const markdown = renderRalphyEngineeringStressMarkdown(report);

  await mkdir(outputDir, { recursive: true });
  await writeFile(
    join(outputDir, "ralphy-engineering-50-report.json"),
    JSON.stringify(report, null, 2),
    "utf8"
  );
  await writeFile(
    join(outputDir, "ralphy-engineering-50-report.md"),
    markdown,
    "utf8"
  );

  process.stdout.write(markdown + "\n");
  process.stdout.write(
    `\nArtifacts written to ${join(outputDir, "ralphy-engineering-50-report.json")} and ${join(outputDir, "ralphy-engineering-50-report.md")}\n`
  );
  process.exitCode = report.suite.summary.failedCases > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fatal Ralph-loop stress report error: ${message}\n`);
  process.exitCode = 1;
});
