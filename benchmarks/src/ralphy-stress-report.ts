import { access, mkdir, writeFile } from "node:fs/promises";
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
  const { jsonPath, markdownPath } = await reserveArtifactPaths();

  await mkdir(outputDir, { recursive: true });
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(markdownPath, markdown, "utf8");

  process.stdout.write(markdown + "\n");
  process.stdout.write(
    `\nArtifacts written to ${jsonPath} and ${markdownPath}\n`
  );
  process.exitCode = report.suite.summary.failedCases > 0 ? 1 : 0;
}

async function reserveArtifactPaths(): Promise<{ jsonPath: string; markdownPath: string }> {
  const filePrefix = "ralphy-engineering-50-report";
  const baseJsonPath = join(outputDir, `${filePrefix}.json`);
  const baseMarkdownPath = join(outputDir, `${filePrefix}.md`);

  if (!(await pathExists(baseJsonPath)) && !(await pathExists(baseMarkdownPath))) {
    return { jsonPath: baseJsonPath, markdownPath: baseMarkdownPath };
  }

  for (let revision = 1; revision <= 9999; revision += 1) {
    const suffix = `.rev-${revision.toString().padStart(4, "0")}`;
    const jsonPath = join(outputDir, `${filePrefix}${suffix}.json`);
    const markdownPath = join(outputDir, `${filePrefix}${suffix}.md`);
    if (!(await pathExists(jsonPath)) && !(await pathExists(markdownPath))) {
      return { jsonPath, markdownPath };
    }
  }

  throw new Error(`Unable to reserve artifact path for ${filePrefix}.`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fatal Ralph-loop stress report error: ${message}\n`);
  process.exitCode = 1;
});
