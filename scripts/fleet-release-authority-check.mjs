#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MARTINLOOP_RELEASE_VERSION = "0.5.0";

const CURRENT_DOCS = [
  "README.md",
  "docs/getting-started/quickstart.md",
  "docs/oss/MCP-FOR-AI-AGENTS.md",
  "docs/release/VERSION-LEDGER.md",
];

const STALE_CURRENT_VERSIONS = ["0.3.16", "0.4.5", "0.3.9", "0.3.2"];
const CURRENT_LINE_MARKERS = ["current", "latest", "live", "baseline", "pin", "release train", "pending public release"];

async function readJson(rootDir, relativePath) {
  return JSON.parse(await readFile(path.join(rootDir, relativePath), "utf8"));
}

async function collectFailures(rootDir = process.cwd(), options = {}) {
  const failures = [];
  const rootPackage = await readJson(rootDir, "package.json");
  const mcpPackage = await readJson(rootDir, "packages/mcp/package.json");
  const mcpServer = await readJson(rootDir, "packages/mcp/server.json");
  const publicTruth = await readJson(rootDir, "docs/product-truth/public-release-truth.json");
  const vendoredCli = await readJson(rootDir, "dist/vendor/cli/package.json");
  const cliSource = await readFile(path.join(rootDir, "packages/cli/src/index.ts"), "utf8");
  const mcpPackageVersionSource = await readFile(path.join(rootDir, "packages/mcp/src/package-version.ts"), "utf8");

  expectEqual(failures, "root package version", rootPackage.version, MARTINLOOP_RELEASE_VERSION);
  expectEqual(failures, "MCP package version", mcpPackage.version, MARTINLOOP_RELEASE_VERSION);
  expectEqual(failures, "MCP server version", mcpServer.version, MARTINLOOP_RELEASE_VERSION);
  expectEqual(
    failures,
    "MCP server package metadata",
    mcpServer.packages?.find((entry) => entry?.identifier === "@martinloop/mcp")?.version,
    MARTINLOOP_RELEASE_VERSION,
  );
  expectEqual(failures, "public release truth cliVersion", publicTruth.cliVersion, MARTINLOOP_RELEASE_VERSION);
  expectEqual(failures, "public release truth mcpVersion", publicTruth.mcpVersion, MARTINLOOP_RELEASE_VERSION);
  expectEqual(failures, "vendored CLI manifest version", vendoredCli.version, MARTINLOOP_RELEASE_VERSION);

  if (!cliSource.includes("cliVersion: rootPackageVersion")) {
    failures.push("CLI user-facing cliVersion fields must resolve from the root martin-loop package version.");
  }
  if (/cliVersion:\s*packageJson\.version/u.test(cliSource)) {
    failures.push("CLI user-facing cliVersion fields must not read the private @martin/cli package version.");
  }
  if (!mcpPackageVersionSource.includes(`MARTIN_MCP_PACKAGE_VERSION = "${MARTINLOOP_RELEASE_VERSION}"`)) {
    failures.push("MCP runtime package-version source must match the standalone MCP package version.");
  }

  failures.push(...await collectStaleCurrentReferences(rootDir));

  if (options.runCli !== false) {
    failures.push(...runCliVersionChecks(rootDir));
  }

  return failures;
}

async function collectStaleCurrentReferences(rootDir = process.cwd()) {
  const failures = [];

  for (const relativePath of CURRENT_DOCS) {
    const text = await readFile(path.join(rootDir, relativePath), "utf8");
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      const lower = line.toLowerCase();
      const hasStaleVersion = STALE_CURRENT_VERSIONS.some((version) => line.includes(version));
      const claimsCurrent = CURRENT_LINE_MARKERS.some((marker) => lower.includes(marker));
      if (hasStaleVersion && claimsCurrent) {
        failures.push(`${relativePath}:${index + 1}: stale current release reference: ${line.trim()}`);
      }
    }
  }

  return failures;
}

function runCliVersionChecks(rootDir) {
  const failures = [];
  const cliPath = path.join(rootDir, "dist", "bin", "martin-loop.js");

  if (!existsSync(cliPath)) {
    failures.push("dist/bin/martin-loop.js is missing; cannot verify packaged CLI version identity.");
    return failures;
  }

  const versionRun = runNodeCli(rootDir, [cliPath, "--version"]);
  if (versionRun.status !== 0) {
    failures.push(`martin --version failed with exit ${versionRun.status}: ${versionRun.stderr || versionRun.stdout}`);
  } else {
    expectEqual(failures, "martin --version", versionRun.stdout.trim(), MARTINLOOP_RELEASE_VERSION);
  }

  const doctorRun = runNodeCli(rootDir, [cliPath, "doctor", "--json"]);
  if (doctorRun.status !== 0) {
    failures.push(`martin doctor --json failed with exit ${doctorRun.status}: ${doctorRun.stderr || doctorRun.stdout}`);
  } else {
    const doctor = JSON.parse(doctorRun.stdout.trim());
    expectEqual(failures, "martin doctor --json cliVersion", doctor.cliVersion, MARTINLOOP_RELEASE_VERSION);
  }

  return failures;
}

function runNodeCli(rootDir, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: rootDir,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, MARTIN_SKIP_UPDATE_CHECK: "1", NO_COLOR: "1" },
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function expectEqual(failures, label, actual, expected) {
  if (actual !== expected) {
    failures.push(`${label} expected ${expected}; received ${String(actual)}`);
  }
}

async function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const runCli = !process.argv.includes("--skip-cli");
  const failures = await collectFailures(rootDir, { runCli });

  if (failures.length > 0) {
    console.error("Fleet release authority check failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log(`Fleet release authority check passed for MartinLoop ${MARTINLOOP_RELEASE_VERSION}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
