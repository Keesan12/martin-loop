import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  generateCertificationReport,
  renderCertificationReportMarkdown
} from "./phase12.js";

async function main(): Promise<void> {
  const outputDir = join(process.cwd(), "output");
  const evidenceDir = join(outputDir, `phase12-certification-evidence-${makeTimestampSlug(new Date())}`);
  const report = await generateCertificationReport({ persistRoot: evidenceDir });
  const markdown = renderCertificationReportMarkdown(report);

  await mkdir(outputDir, { recursive: true });
  await writeFile(
    join(outputDir, "phase12-certification-report.json"),
    JSON.stringify(report, null, 2),
    "utf8"
  );
  await writeFile(
    join(outputDir, "phase12-certification-report.md"),
    markdown,
    "utf8"
  );

  process.stdout.write(markdown + "\n");
  process.stdout.write(
    `\nArtifacts written to ${join(outputDir, "phase12-certification-report.json")} and ${join(outputDir, "phase12-certification-report.md")}\n`
  );
  process.stdout.write(`Evidence bundle written to ${evidenceDir}\n`);
  process.exitCode = report.verdict === "go" ? 0 : 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fatal Phase 12 certification error: ${message}\n`);
  process.exitCode = 1;
});

function makeTimestampSlug(value: Date): string {
  return value.toISOString().replace(/[:.]/g, "-");
}
