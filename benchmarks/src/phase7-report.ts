import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { generateGoNoGoReport, renderGoNoGoReportMarkdown } from "./phase7.js";

async function main(): Promise<void> {
  const report = await generateGoNoGoReport();
  const markdown = renderGoNoGoReportMarkdown(report);
  const outputDir = join(process.cwd(), "output");

  await mkdir(outputDir, { recursive: true });
  await writeFile(
    join(outputDir, "phase7-go-no-go-report.json"),
    JSON.stringify(report, null, 2),
    "utf8"
  );
  await writeFile(join(outputDir, "phase7-go-no-go-report.md"), markdown, "utf8");

  process.stdout.write(markdown + "\n");
  process.stdout.write(
    `\nArtifacts written to ${join(outputDir, "phase7-go-no-go-report.json")} and ${join(outputDir, "phase7-go-no-go-report.md")}\n`
  );
  process.exitCode = report.verdict === "go" ? 0 : 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fatal Phase 7 report error: ${message}\n`);
  process.exitCode = 1;
});
