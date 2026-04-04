#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_RC_GATE_COMMANDS = [
  "pnpm oss:validate",
  "pnpm public:smoke",
  "pnpm repo:smoke",
  "pnpm rc:validate",
  "pnpm pilot:prep:validate",
  "pnpm release:matrix:local",
];

const DOC_FILES = {
  readme: "README.md",
  ossReadme: path.join("docs", "oss", "README.md"),
  quickstart: path.join("docs", "oss", "QUICKSTART.md"),
  examples: path.join("docs", "oss", "EXAMPLES.md"),
};

const DEPRECATED_FILES = [
  path.join("docs", "oss", "README-outline.md"),
];

const TRUST_PROFILES = [
  "strict_local",
  "ci_safe",
  "staging_controlled",
  "research_untrusted",
];

const ACCOUNTING_LABELS = [
  "actual",
  "estimated",
  "unavailable",
];

export async function createReleaseSurfaceReport(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const rootManifest = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  const docs = await loadDocs(rootDir);

  const report = {
    generatedAt: new Date().toISOString(),
    publicSurface: {
      packageName: rootManifest.name,
      installCommand: `npm install ${rootManifest.name}`,
      npxCommand: `npx ${rootManifest.name}`,
      sdkImportStatement: `import { MartinLoop } from "${rootManifest.name}"`,
    },
    rcGateCommands: REQUIRED_RC_GATE_COMMANDS,
    docCoverage: {
      readme: {
        path: DOC_FILES.readme,
        hasPublicSurface: hasPublicSurfaceStrings(docs.readme, rootManifest.name),
        hasRcGateCommands: hasAllStrings(docs.readme, REQUIRED_RC_GATE_COMMANDS),
        hasRegistryCaution: hasRegistryCaution(docs.readme),
      },
      ossReadme: {
        path: DOC_FILES.ossReadme,
        hasPublicSurface: hasPublicSurfaceStrings(docs.ossReadme, rootManifest.name),
        hasAccountingLabels: hasAllStrings(docs.ossReadme, ACCOUNTING_LABELS),
        hasTrustProfiles: hasAllStrings(docs.ossReadme, TRUST_PROFILES),
        hasRegistryCaution: hasRegistryCaution(docs.ossReadme),
      },
      quickstart: {
        path: DOC_FILES.quickstart,
        hasPublicSurface: hasPublicSurfaceStrings(docs.quickstart, rootManifest.name),
        hasRcGateCommands: hasAllStrings(docs.quickstart, REQUIRED_RC_GATE_COMMANDS),
        hasRegistryCaution: hasRegistryCaution(docs.quickstart),
      },
      examples: {
        path: DOC_FILES.examples,
        hasRegistryCaution: hasRegistryCaution(docs.examples),
      },
    },
    deprecatedFiles: await findDeprecatedFiles(rootDir, DEPRECATED_FILES),
  };

  const failures = collectFailures(report);

  return {
    ...report,
    verdict: failures.length === 0 ? "go" : "no_go",
    failures,
  };
}

export function renderReleaseSurfaceReportMarkdown(report) {
  const readmePath = normalizeDisplayPath(report.docCoverage.readme.path);
  const ossReadmePath = normalizeDisplayPath(report.docCoverage.ossReadme.path);
  const quickstartPath = normalizeDisplayPath(report.docCoverage.quickstart.path);
  const examplesPath = normalizeDisplayPath(report.docCoverage.examples.path);
  const lines = [
    "# Martin Loop Phase 13 Release Surface Audit",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Verdict",
    `**${report.verdict.toUpperCase()}**`,
    "",
    "## Public Package Surface",
    `- Package target: ${report.publicSurface.packageName}`,
    `- Install target: \`${report.publicSurface.installCommand}\``,
    `- CLI target: \`${report.publicSurface.npxCommand}\``,
    `- SDK target: \`${report.publicSurface.sdkImportStatement}\``,
    "",
    "## RC Gate Commands",
    ...report.rcGateCommands.map((command) => `- \`${command}\``),
    "",
    "## Doc Coverage",
    "| Surface | Path | Checks |",
    "|---|---|---|",
    `| Root README | ${readmePath} | public surface: ${yesNo(report.docCoverage.readme.hasPublicSurface)}, RC gate: ${yesNo(report.docCoverage.readme.hasRcGateCommands)}, registry caution: ${yesNo(report.docCoverage.readme.hasRegistryCaution)} |`,
    `| OSS README | ${ossReadmePath} | public surface: ${yesNo(report.docCoverage.ossReadme.hasPublicSurface)}, accounting labels: ${yesNo(report.docCoverage.ossReadme.hasAccountingLabels)}, trust profiles: ${yesNo(report.docCoverage.ossReadme.hasTrustProfiles)}, registry caution: ${yesNo(report.docCoverage.ossReadme.hasRegistryCaution)} |`,
    `| Quickstart | ${quickstartPath} | public surface: ${yesNo(report.docCoverage.quickstart.hasPublicSurface)}, RC gate: ${yesNo(report.docCoverage.quickstart.hasRcGateCommands)}, registry caution: ${yesNo(report.docCoverage.quickstart.hasRegistryCaution)} |`,
    `| Examples | ${examplesPath} | registry caution: ${yesNo(report.docCoverage.examples.hasRegistryCaution)} |`,
    "",
    "## Deprecated Files",
  ];

  if (report.deprecatedFiles.length === 0) {
    lines.push("- None.");
  } else {
    lines.push(...report.deprecatedFiles.map((file) => `- ${file}`));
  }

  lines.push("", "## Findings");

  if (report.failures.length === 0) {
    lines.push("- No release-surface drift detected across the audited RC docs and commands.");
  } else {
    lines.push(...report.failures.map((failure) => `- ${failure}`));
  }

  lines.push("");
  return lines.join("\n");
}

export async function writeReleaseSurfaceReport(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const outputDir = options.outputDir ?? path.join(rootDir, "docs", "oss");
  const report = await createReleaseSurfaceReport({ rootDir });
  const markdown = renderReleaseSurfaceReportMarkdown(report);

  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, "RELEASE-SURFACE-REPORT.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(outputDir, "RELEASE-SURFACE-REPORT.md"),
    `${markdown}\n`,
    "utf8",
  );

  return report;
}

async function loadDocs(rootDir) {
  const entries = await Promise.all(
    Object.entries(DOC_FILES).map(async ([key, relativePath]) => {
      const contents = await readFile(path.join(rootDir, relativePath), "utf8");
      return [key, contents];
    }),
  );

  return Object.fromEntries(entries);
}

async function findDeprecatedFiles(rootDir, files) {
  const found = [];

  for (const relativePath of files) {
    try {
      await readFile(path.join(rootDir, relativePath), "utf8");
      found.push(relativePath);
    } catch {}
  }

  return found;
}

function hasPublicSurfaceStrings(contents, packageName) {
  return hasAllStrings(contents, [
    `npm install ${packageName}`,
    `npx ${packageName}`,
    `import { MartinLoop } from "${packageName}"`,
  ]);
}

function hasRegistryCaution(contents) {
  return /registry publication/i.test(contents) || /later release step/i.test(contents);
}

function hasAllStrings(contents, strings) {
  return strings.every((value) => contents.includes(value));
}

function collectFailures(report) {
  const failures = [];

  if (!report.docCoverage.readme.hasPublicSurface) {
    failures.push(`README.md does not capture the frozen install, CLI, and SDK surface.`);
  }
  if (!report.docCoverage.readme.hasRcGateCommands) {
    failures.push(`README.md does not list the full Phase 13 RC gate commands.`);
  }
  if (!report.docCoverage.readme.hasRegistryCaution) {
    failures.push(`README.md does not preserve the registry-publication caution.`);
  }
  if (!report.docCoverage.ossReadme.hasPublicSurface) {
    failures.push(`docs/oss/README.md does not restate the frozen public package surface.`);
  }
  if (!report.docCoverage.ossReadme.hasAccountingLabels) {
    failures.push(`docs/oss/README.md does not preserve actual/estimated/unavailable accounting language.`);
  }
  if (!report.docCoverage.ossReadme.hasTrustProfiles) {
    failures.push(`docs/oss/README.md does not enumerate all trust profiles.`);
  }
  if (!report.docCoverage.ossReadme.hasRegistryCaution) {
    failures.push(`docs/oss/README.md does not preserve the registry-publication caution.`);
  }
  if (!report.docCoverage.quickstart.hasPublicSurface) {
    failures.push(`docs/oss/QUICKSTART.md does not restate the frozen public package surface.`);
  }
  if (!report.docCoverage.quickstart.hasRcGateCommands) {
    failures.push(`docs/oss/QUICKSTART.md does not list the full Phase 13 RC gate commands.`);
  }
  if (!report.docCoverage.quickstart.hasRegistryCaution) {
    failures.push(`docs/oss/QUICKSTART.md does not preserve the registry-publication caution.`);
  }
  if (!report.docCoverage.examples.hasRegistryCaution) {
    failures.push(`docs/oss/EXAMPLES.md does not preserve the registry-publication caution.`);
  }
  if (report.deprecatedFiles.length > 0) {
    failures.push(`Deprecated release-surface files still exist: ${report.deprecatedFiles.join(", ")}.`);
  }

  return failures;
}

function yesNo(value) {
  return value ? "yes" : "no";
}

function normalizeDisplayPath(value) {
  return value.replace(/\\/g, "/");
}

async function main() {
  const rootDir = process.cwd();
  const report = await writeReleaseSurfaceReport({ rootDir });
  const markdown = renderReleaseSurfaceReportMarkdown(report);

  process.stdout.write(`${markdown}\n`);
  process.stdout.write(
    `\nArtifacts written to ${path.join(rootDir, "docs", "oss", "RELEASE-SURFACE-REPORT.json")} and ${path.join(rootDir, "docs", "oss", "RELEASE-SURFACE-REPORT.md")}\n`,
  );

  process.exitCode = report.verdict === "go" ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === path.resolve(modulePath)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Release surface validation failed: ${message}\n`);
    process.exitCode = 1;
  });
}
