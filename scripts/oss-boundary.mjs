#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OSS_CORE_PATHS = [
  "packages/contracts",
  "packages/core",
  "packages/adapters",
  "packages/cli",
  "packages/mcp",
];

const ALLOWED_TOP_LEVEL_ENTRIES = [
  ".github",
  "demo",
  "docs",
  "examples",
  "packages",
  "scripts",
  ".gitignore",
  "AGENTS.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "martin.config.example.yaml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "README.md",
  "SECURITY.md",
  "tsconfig.base.json",
  "vitest.workspace.ts",
];

const FORBIDDEN_TOP_LEVEL_ENTRIES = [".planning", "apps", "benchmarks", "deploy"];
const IGNORED_TOP_LEVEL_ENTRIES = [".artifacts", ".git", "dist", "node_modules"];

export async function createOssBoundaryReport(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const rootManifest = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  const ossCorePackages = await loadPackages(rootDir, OSS_CORE_PATHS);
  const topLevelEntries = listTrackedTopLevelEntries(rootDir);

  const forbiddenTopLevelEntries = topLevelEntries.filter((entry) =>
    FORBIDDEN_TOP_LEVEL_ENTRIES.includes(entry),
  );
  const unexpectedTopLevelEntries = topLevelEntries.filter(
    (entry) =>
      !ALLOWED_TOP_LEVEL_ENTRIES.includes(entry) &&
      !IGNORED_TOP_LEVEL_ENTRIES.includes(entry),
  );
  const packageDirs = (await readdir(path.join(rootDir, "packages"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`)
    .sort();
  const unexpectedPackageDirs = packageDirs.filter((entry) => !OSS_CORE_PATHS.includes(entry));
  const dependencyLeaks = findDependencyLeaks(ossCorePackages);

  return {
    generatedAt: new Date().toISOString(),
    verdict:
      forbiddenTopLevelEntries.length === 0 &&
      unexpectedTopLevelEntries.length === 0 &&
      unexpectedPackageDirs.length === 0 &&
      dependencyLeaks.length === 0
        ? "go"
        : "no_go",
    publicSurface: {
      packageName: rootManifest.name,
      packageVersion: rootManifest.version,
      installCommand: `npm install ${rootManifest.name}`,
      npxCommand: `npx ${rootManifest.name}`,
      sdkImportPath: rootManifest.name,
      mcpCommand: "npx -y @martinloop/mcp",
    },
    ossCorePackages,
    topLevelEntries,
    forbiddenTopLevelEntries,
    unexpectedTopLevelEntries,
    unexpectedPackageDirs,
    dependencyLeaks,
    summary: {
      ossCoreCount: ossCorePackages.length,
      forbiddenTopLevelCount: forbiddenTopLevelEntries.length,
      unexpectedTopLevelCount: unexpectedTopLevelEntries.length,
      unexpectedPackageDirCount: unexpectedPackageDirs.length,
      dependencyLeakCount: dependencyLeaks.length,
    },
  };
}

function listTrackedTopLevelEntries(rootDir) {
  const output = execFileSync("git", ["ls-tree", "--name-only", "HEAD"], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

export function renderOssBoundaryReportMarkdown(report) {
  const lines = [
    "# Martin Loop OSS Boundary Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Verdict",
    `**${report.verdict.toUpperCase()}**`,
    "",
    "## Public Surface",
    `- Root package: \`${report.publicSurface.packageName}@${report.publicSurface.packageVersion}\``,
    `- Install target: \`${report.publicSurface.installCommand}\``,
    `- CLI target: \`${report.publicSurface.npxCommand}\``,
    `- SDK target: \`import { MartinLoop } from "${report.publicSurface.sdkImportPath}"\``,
    `- MCP target: \`${report.publicSurface.mcpCommand}\``,
    "",
    "## OSS Packages",
    "| Package | Path | Private | Publish Access | Workspace Deps |",
    "|---|---|---|---|---|",
    ...report.ossCorePackages.map(
      (pkg) =>
        `| ${pkg.name} | ${pkg.path} | ${pkg.private === true ? "yes" : "no"} | ${pkg.publishAccess ?? "n/a"} | ${pkg.workspaceDependencies.join(", ") || "none"} |`,
    ),
    "",
    "## Boundary Checks",
    `- Forbidden top-level entries: ${report.forbiddenTopLevelEntries.join(", ") || "none"}`,
    `- Unexpected top-level entries: ${report.unexpectedTopLevelEntries.join(", ") || "none"}`,
    `- Unexpected package directories: ${report.unexpectedPackageDirs.join(", ") || "none"}`,
    `- Workspace dependency leaks: ${report.dependencyLeaks.length === 0 ? "none" : report.dependencyLeaks.map((leak) => `${leak.fromPackage} -> ${leak.toPackage}`).join(", ")}`,
    "",
  ];

  return lines.join("\n");
}

export async function writeOssBoundaryReport(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const outputDir = options.outputDir ?? path.join(rootDir, "docs", "oss");
  const report = await createOssBoundaryReport({ rootDir });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, "OSS-BOUNDARY-REPORT.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );

  return report;
}

async function loadPackages(rootDir, relativePaths) {
  return Promise.all(
    relativePaths.map(async (relativePath) => {
      const manifestPath = path.join(rootDir, relativePath, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

      return {
        name: manifest.name,
        path: relativePath,
        private: manifest.private === true,
        publishAccess: manifest.publishConfig?.access ?? null,
        workspaceDependencies: collectWorkspaceDependencies(manifest),
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

function findDependencyLeaks(ossCorePackages) {
  const allowedNames = new Set(ossCorePackages.map((pkg) => pkg.name));

  return ossCorePackages.flatMap((pkg) =>
    pkg.workspaceDependencies
      .filter((dependencyName) => !allowedNames.has(dependencyName))
      .map((dependencyName) => ({
        fromPackage: pkg.name,
        toPackage: dependencyName,
      })),
  );
}

async function main() {
  const rootDir = process.cwd();
  const report = await writeOssBoundaryReport({ rootDir });
  const markdown = renderOssBoundaryReportMarkdown(report);

  process.stdout.write(`${markdown}\n`);
  process.stdout.write(
    `\nArtifact written to ${path.join(rootDir, "docs", "oss", "OSS-BOUNDARY-REPORT.json")}\n`,
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
