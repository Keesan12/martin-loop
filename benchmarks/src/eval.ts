import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateRalphyEngineeringStressReport,
  renderRalphyEngineeringStressMarkdown
} from "./ralphy-stress.js";
import {
  generateUnder3ChallengeReport,
  renderUnder3ChallengeMarkdown
} from "./challenge.js";

const entryFilePath = fileURLToPath(import.meta.url);

function resolveOutputDir(): string {
  const configured = process.env.MARTIN_BENCHMARK_OUTPUT_DIR?.trim();
  return configured && configured.length > 0 ? resolve(configured) : fileURLToPath(new URL("../output/", import.meta.url));
}

export function readSuiteId(argv: string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }
    if (token === "--suite") {
      const suiteId = argv[index + 1];
      if (!suiteId || suiteId.startsWith("--")) {
        throw new Error("Missing value for --suite.");
      }
      return suiteId;
    }

    if (token.startsWith("--suite=")) {
      const suiteId = token.slice("--suite=".length).trim();
      if (suiteId.length === 0) {
        throw new Error("Missing value for --suite.");
      }
      return suiteId;
    }
  }
  return "under-3-challenge";
}

async function writeArtifacts(filePrefix: string, payload: unknown, markdown: string): Promise<void> {
  const outputDir = resolveOutputDir();
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

if (process.argv[1] && resolve(process.argv[1]) === entryFilePath) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Benchmark evaluation failed: ${message}\n`);
    process.exitCode = 1;
  });
}
