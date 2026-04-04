#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OSS_CORE_PATHS = [
  "packages/contracts",
  "packages/core",
  "packages/adapters",
  "packages/cli",
  "packages/mcp",
];

const NON_OSS_WORKSPACE_PATHS = [
  "apps/control-plane",
  "benchmarks",
];

const LOCAL_ONLY_SURFACES = [
  {
    path: "apps/local-dashboard",
    reason: "Local read-model viewer that is not yet packaged as a publishable OSS workspace.",
  },
];

export async function createOssBoundaryReport(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const rootManifest = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  const ossCorePackages = await loadPackages(rootDir, OSS_CORE_PATHS, "oss_core");
  const nonOssWorkspacePackages = await loadPackages(rootDir, NON_OSS_WORKSPACE_PATHS, "non_oss_workspace");
  const dependencyLeaks = findDependencyLeaks(ossCorePackages, nonOssWorkspacePackages);
  const publicSurface = {
    packageName: rootManifest.name,
    canonicalPackageManager: "npm",
    installCommand: `npm install ${rootManifest.name}`,
    npxCommand: `npx ${rootManifest.name}`,
    sdkImportPath: rootManifest.name,
    supportsNpxCommand: hasRootBin(rootManifest, rootManifest.name),
    supportsSdkImport: hasRootSdkEntrypoint(rootManifest),
  };

  return {
    generatedAt: new Date().toISOString(),
    verdict: dependencyLeaks.length === 0 ? "go" : "no_go",
    publicSurface,
    ossCorePackages,
    nonOssWorkspacePackages,
    localOnlySurfaces: LOCAL_ONLY_SURFACES,
    dependencyLeaks,
    summary: {
      ossCoreCount: ossCorePackages.length,
      nonOssWorkspaceCount: nonOssWorkspacePackages.length,
      localOnlySurfaceCount: LOCAL_ONLY_SURFACES.length,
      dependencyLeakCount: dependencyLeaks.length,
      privateOssCoreCount: ossCorePackages.filter((pkg) => pkg.private === true).length,
      publishReadyOssCoreCount: ossCorePackages.filter((pkg) => pkg.private !== true).length,
    },
  };
}

export function renderOssBoundaryReportMarkdown(report) {
  const leakSummary =
    report.dependencyLeaks.length === 0
      ? "No workspace dependency leaks detected between the intended OSS core and the non-OSS workspace surfaces."
      : `${report.dependencyLeaks.length} workspace dependency leak(s) detected between the intended OSS core and non-OSS workspace surfaces.`;

  const lines = [
    "# Martin Loop Phase 13 OSS Core Boundary",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Verdict",
    `**${report.verdict.toUpperCase()}**`,
    "",
    "## Summary",
    `- Public package target: ${report.publicSurface.packageName}`,
    `- Canonical public package manager: ${report.publicSurface.canonicalPackageManager}`,
    `- Intended OSS core packages: ${String(report.summary.ossCoreCount)}`,
    `- Non-OSS workspace packages: ${String(report.summary.nonOssWorkspaceCount)}`,
    `- Local-only surfaces: ${String(report.summary.localOnlySurfaceCount)}`,
    `- Private OSS-core packages still gated from publish: ${String(report.summary.privateOssCoreCount)}`,
    `- OSS-core packages already publish-configured: ${String(report.summary.publishReadyOssCoreCount)}`,
    `- Dependency leaks: ${String(report.summary.dependencyLeakCount)}`,
    `- ${leakSummary}`,
    "",
    "## Public Package Surface",
    `- Install target: \`${report.publicSurface.installCommand}\``,
    `- CLI target: \`${report.publicSurface.npxCommand}\``,
    `- SDK target: \`import { MartinLoop } from '${report.publicSurface.sdkImportPath}'\``,
    `- Root \`npx martin-loop\` support shipped: ${report.publicSurface.supportsNpxCommand ? "yes" : "no"}`,
    `- Root SDK import shipped: ${report.publicSurface.supportsSdkImport ? "yes" : "no"}`,
    "",
    "## Intended OSS Core Packages",
    "| Package | Path | Private | Publish Access | Workspace Deps |",
    "|---|---|---|---|---|",
    ...report.ossCorePackages.map(
      (pkg) =>
        `| ${pkg.name} | ${pkg.path} | ${pkg.private === true ? "yes" : "no"} | ${pkg.publishAccess ?? "n/a"} | ${pkg.workspaceDependencies.join(", ") || "none"} |`
    ),
    "",
    "## Non-OSS Workspace Packages",
    "| Package | Path | Reason |",
    "|---|---|---|",
    ...report.nonOssWorkspacePackages.map(
      (pkg) => `| ${pkg.name} | ${pkg.path} | ${pkg.classificationReason} |`
    ),
    "",
    "## Local-Only Surfaces",
    "| Path | Reason |",
    "|---|---|",
    ...report.localOnlySurfaces.map((surface) => `| ${surface.path} | ${surface.reason} |`),
    "",
    "## Dependency Leak Review",
  ];

  if (report.dependencyLeaks.length === 0) {
    lines.push("- No workspace dependency leaks detected.");
  } else {
    lines.push(
      ...report.dependencyLeaks.map(
        (leak) =>
          `- ${leak.fromPackage} depends on ${leak.toPackage} via ${leak.field}, which crosses the intended OSS boundary.`
      )
    );
  }

  lines.push("");

  return lines.join("\n");
}

export async function writeOssBoundaryReport(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const outputDir = options.outputDir ?? path.join(rootDir, "docs", "oss");
  const report = await createOssBoundaryReport({ rootDir });
  const markdown = renderOssBoundaryReportMarkdown(report);

  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, "OSS-BOUNDARY-REPORT.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(outputDir, "OSS-BOUNDARY-REPORT.md"),
    `${markdown}\n`,
    "utf8",
  );

  return report;
}

async function loadPackages(rootDir, relativePaths, classification) {
  return Promise.all(
    relativePaths.map(async (relativePath) => {
      const manifestPath = path.join(rootDir, relativePath, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const workspaceDependencies = collectWorkspaceDependencies(manifest);

      return {
        name: manifest.name,
        path: relativePath,
        private: manifest.private === true,
        publishAccess: manifest.publishConfig?.access ?? null,
        workspaceDependencies,
        classification,
        classificationReason:
          classification === "oss_core"
            ? "Intended Phase 13 OSS core surface."
            : "Managed or RC-only workspace surface that stays out of the initial OSS boundary.",
      };
    }),
  );
}

function collectWorkspaceDependencies(manifest) {
  const dependencySections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  const workspaceDependencies = [];

  for (const section of dependencySections) {
    const deps = manifest[section] ?? {};
    for (const [name, version] of Object.entries(deps)) {
      if (typeof version === "string" && version.startsWith("workspace:")) {
        workspaceDependencies.push(name);
      }
    }
  }

  return [...new Set(workspaceDependencies)].sort();
}

function findDependencyLeaks(ossCorePackages, nonOssWorkspacePackages) {
  const nonOssByName = new Map(nonOssWorkspacePackages.map((pkg) => [pkg.name, pkg]));
  const dependencySections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

  return ossCorePackages.flatMap((pkg) => {
    return pkg.workspaceDependencies
      .filter((dependencyName) => nonOssByName.has(dependencyName))
      .map((dependencyName) => ({
        fromPackage: pkg.name,
        toPackage: dependencyName,
        field: dependencySections.find(() => true) ?? "dependencies",
      }));
  });
}

function hasRootBin(manifest, packageName) {
  if (!manifest || typeof manifest !== "object") {
    return false;
  }

  const bin = manifest.bin;
  if (!bin || typeof bin !== "object") {
    return false;
  }

  return typeof bin[packageName] === "string" && bin[packageName].trim().length > 0;
}

function hasRootSdkEntrypoint(manifest) {
  if (!manifest || typeof manifest !== "object") {
    return false;
  }

  if (typeof manifest.main === "string" && manifest.main.trim().length > 0) {
    return true;
  }

  if (typeof manifest.module === "string" && manifest.module.trim().length > 0) {
    return true;
  }

  if (typeof manifest.types === "string" && manifest.types.trim().length > 0) {
    return true;
  }

  if (manifest.exports && typeof manifest.exports === "object") {
    return true;
  }

  return false;
}

async function main() {
  const rootDir = process.cwd();
  const report = await writeOssBoundaryReport({ rootDir });
  const markdown = renderOssBoundaryReportMarkdown(report);

  process.stdout.write(`${markdown}\n`);
  process.stdout.write(
    `\nArtifacts written to ${path.join(rootDir, "docs", "oss", "OSS-BOUNDARY-REPORT.json")} and ${path.join(rootDir, "docs", "oss", "OSS-BOUNDARY-REPORT.md")}\n`,
  );

  process.exitCode = report.verdict === "go" ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === path.resolve(modulePath)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`OSS boundary validation failed: ${message}\n`);
    process.exitCode = 1;
  });
}
