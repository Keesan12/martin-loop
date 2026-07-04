#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
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
    id: "footer_star_cta",
    description: "footer star CTA line",
    needle: "Star this repo",
  },
  {
    id: "site_link",
    description: "martinloop.com link",
    needle: 'href="https://martinloop.com"',
  },
  {
    id: "support_link",
    description: "support@martinloop.com mailto link",
    needle: 'href="mailto:support@martinloop.com"',
  },
  {
    id: "nvidia_marker",
    description: "NVIDIA logo marker",
    needle: "nvidia-inception-program-light.png",
  },
];

const FORBIDDEN_LICENSE_NEEDLES = [
  "MIT Licensed",
  "MIT License",
  "License: MIT",
  "Licensed under MIT"
];

export function evaluateReadmeCtaGuards(readmeContents) {
  const missingChecks = REQUIRED_CTA_CHECKS.filter((check) => !readmeContents.includes(check.needle));
  const forbiddenLicenseChecks = FORBIDDEN_LICENSE_NEEDLES.filter((needle) => readmeContents.includes(needle));

  return {
    ok: missingChecks.length === 0 && forbiddenLicenseChecks.length === 0,
    missingChecks: missingChecks.map(({ id, description }) => ({ id, description })),
    forbiddenLicenseChecks,
  };
}

export async function readRootReadme(rootDir = process.cwd()) {
  const readmePath = path.join(rootDir, "README.md");
  return readFile(readmePath, "utf8");
}

export async function checkReadmePrecedenceHazards(rootDir = process.cwd()) {
  const githubReadmePath = path.join(rootDir, ".github", "README.md");

  try {
    await access(githubReadmePath);
    return [
      {
        id: "github_readme_shadow",
        description: "remove .github/README.md because it shadows the repo homepage README",
      },
    ];
  } catch {
    return [];
  }
}

async function main() {
  const rootDir = process.cwd();
  const readmeContents = await readRootReadme(rootDir);
  const result = evaluateReadmeCtaGuards(readmeContents);
  const precedenceHazards = await checkReadmePrecedenceHazards(rootDir);

  if (result.ok && precedenceHazards.length === 0) {
    process.stdout.write("README CTA guard passed.\n");
    return;
  }

  process.stderr.write("README CTA guard failed.\n");

  if (result.missingChecks.length > 0) {
    process.stderr.write("Missing required anchors:\n");
    for (const missing of result.missingChecks) {
      process.stderr.write(`- ${missing.id}: ${missing.description}\n`);
    }
  }

  if (result.forbiddenLicenseChecks.length > 0) {
    process.stderr.write("Forbidden stale license copy:\n");
    for (const needle of result.forbiddenLicenseChecks) {
      process.stderr.write(`- ${needle}\n`);
    }
  }

  if (precedenceHazards.length > 0) {
    process.stderr.write("README precedence hazards:\n");
    for (const hazard of precedenceHazards) {
      process.stderr.write(`- ${hazard.id}: ${hazard.description}\n`);
    }
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
