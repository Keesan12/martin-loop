#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_CTA_CHECKS = [
  {
    id: "top_get_started_cta",
    description: "top get-started CTA line",
    needle: "**Get started:** `npx -y martin-loop@latest start`",
  },
  {
    id: "top_demo_cta",
    description: "top demo CTA line",
    needle: "**Try the demo:** `npx -y martin-loop@latest demo`",
  },
  {
    id: "site_link",
    description: "martinloop.com link",
    needle: "[martinloop.com](https://martinloop.com)",
  },
  {
    id: "support_link",
    description: "support@martinloop.com mailto link",
    needle: "[support@martinloop.com](mailto:support@martinloop.com)",
  },
  {
    id: "nvidia_marker",
    description: "NVIDIA logo marker",
    needle: "nvidia-inception-program-light.png",
  },
];

export function evaluateReadmeCtaGuards(readmeContents) {
  const missingChecks = REQUIRED_CTA_CHECKS.filter((check) => !readmeContents.includes(check.needle));

  return {
    ok: missingChecks.length === 0,
    missingChecks: missingChecks.map(({ id, description }) => ({ id, description })),
  };
}

export async function readRootReadme(rootDir = process.cwd()) {
  const readmePath = path.join(rootDir, "README.md");
  return readFile(readmePath, "utf8");
}

async function main() {
  const readmeContents = await readRootReadme(process.cwd());
  const result = evaluateReadmeCtaGuards(readmeContents);

  if (result.ok) {
    process.stdout.write("README CTA guard passed.\n");
    return;
  }

  process.stderr.write("README CTA guard failed. Missing required anchors:\n");
  for (const missing of result.missingChecks) {
    process.stderr.write(`- ${missing.id}: ${missing.description}\n`);
  }

  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === path.resolve(modulePath)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`README CTA guard failed: ${message}\n`);
    process.exitCode = 1;
  });
}
