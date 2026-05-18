import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  generateProviderPathReport,
  renderProviderPathReportMarkdown
} from "./provider-paths.js";

async function main(): Promise<void> {
  const outputDir = join(process.cwd(), "output");
  const report = await generateProviderPathReport();
  const markdown = renderProviderPathReportMarkdown(report);

  await mkdir(outputDir, { recursive: true });
  await writeFile(
    join(outputDir, "phase13-provider-path-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(outputDir, "phase13-provider-path-report.md"),
    `${markdown}\n`,
    "utf8"
  );

  process.stdout.write(`${markdown}\n`);
  process.stdout.write(
    `\nArtifacts written to ${join(outputDir, "phase13-provider-path-report.json")} and ${join(outputDir, "phase13-provider-path-report.md")}\n`
  );
  process.exitCode = report.verdict === "go" ? 0 : 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fatal Phase 13 provider-path validation error: ${message}\n`);
  process.exitCode = 1;
});
