#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export async function collectReleaseAuthorityFailures(rootDir, options = {}) {
  const failures = [];
  const readJson = async (relativePath) =>
    JSON.parse(await readFile(path.join(rootDir, relativePath), "utf8"));

  const rootManifest = await readJson("package.json");
  const releaseVersion = rootManifest.version;
  if (typeof releaseVersion !== "string" || !/^0\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(releaseVersion)) {
    failures.push(`root package version is not a valid pre-1.0 release: ${String(releaseVersion)}`);
    return failures;
  }
  const mcpManifest = await readJson("packages/mcp/package.json");
  const serverMetadata = await readJson("packages/mcp/server.json");
  const releaseTruth = await readJson("docs/product-truth/public-release-truth.json");
  const vendoredCli = await readJson("dist/vendor/cli/package.json");
  const mcpbManifest = await readJson("packages/mcp/mcpb/manifest.json");
  const pluginManifest = await readJson("plugins/martinloop/plugin.json");
  const pluginMcp = await readJson("plugins/martinloop/.mcp.json");

  expectVersion(failures, releaseVersion, "MCP package version", mcpManifest.version);
  expectVersion(failures, releaseVersion, "MCP server version", serverMetadata.version);
  expectVersion(
    failures,
    releaseVersion,
    "MCP server npm package version",
    serverMetadata.packages?.find((entry) => entry?.registryType === "npm")?.version,
  );
  expectVersion(failures, releaseVersion, "public release truth cliVersion", releaseTruth.cliVersion);
  expectVersion(failures, releaseVersion, "public release truth mcpVersion", releaseTruth.mcpVersion);
  expectVersion(failures, releaseVersion, "vendored CLI version", vendoredCli.version);
  expectVersion(failures, releaseVersion, "MCPB product version", mcpbManifest.version);
  expectVersion(failures, releaseVersion, "plugin version", pluginManifest.version);
  const pluginPackageSpec = pluginMcp.mcpServers?.["martin-loop"]?.args?.find(
    (arg) => typeof arg === "string" && arg.startsWith("@martinloop/mcp@"),
  );
  expectVersion(failures, releaseVersion, "plugin MCP package version", pluginPackageSpec?.split("@").at(-1));

  for (const relativePath of [
    "plugins/martinloop/.claude-plugin/plugin.json",
    "plugins/martinloop/.codex-plugin/plugin.json",
  ]) {
    if (await exists(path.join(rootDir, relativePath))) {
      const manifest = await readJson(relativePath);
      expectVersion(failures, releaseVersion, `${relativePath} version`, manifest.version);
    }
  }

  const runtimeSource = await readFile(
    path.join(rootDir, "packages/mcp/src/package-version.ts"),
    "utf8",
  );
  const runtimeVersion = runtimeSource.match(
    /MARTIN_MCP_PACKAGE_VERSION\s*=\s*["']([^"']+)["']/u,
  )?.[1];
  expectVersion(failures, releaseVersion, "MCP runtime version", runtimeVersion);

  await checkPresentationPath(failures, readJson, "packages/mcp/tsconfig.json", "source");
  await checkPresentationPath(failures, readJson, "packages/mcp/tsconfig.build.json", "build");
  await checkCurrentReleaseDocs(failures, rootDir, releaseVersion);
  await checkReadmeAuthority(failures, rootDir, releaseVersion);

  if (options.built) {
    await checkBuiltCli(failures, rootDir, releaseVersion);
  }

  return failures;
}

async function checkReadmeAuthority(failures, rootDir, releaseVersion) {
  const relativePath = "README.md";
  const lines = (await readFile(path.join(rootDir, relativePath), "utf8")).split(/\r?\n/u);
  const authorityLine = /(?:current root package|deterministic installs|MCP package:|aligned at|^\*\*Install\*\*|^\*\*MCP\*\*)/iu;
  lines.forEach((line, index) => {
    if (!authorityLine.test(line)) return;
    for (const version of line.match(/\b0\.\d+\.\d+\b/gu) ?? []) {
      if (version !== releaseVersion) {
        failures.push(
          `${relativePath}:${index + 1} stale current release reference ${version}; expected ${releaseVersion}`,
        );
      }
    }
  });
}

function expectVersion(failures, expected, label, actual) {
  if (actual !== expected) {
    failures.push(`${label} expected ${expected}; received ${String(actual)}`);
  }
}

async function checkPresentationPath(failures, readJson, relativePath, label) {
  const config = await readJson(relativePath);
  const target = config.compilerOptions?.paths?.["@martin/presentation"];
  if (!Array.isArray(target) || target.length === 0) {
    failures.push(`${label} MCP tsconfig must resolve @martin/presentation`);
  }
}

async function checkCurrentReleaseDocs(failures, rootDir, releaseVersion) {
  const relativePath = path.join("docs", "release", "VERSION-LEDGER.md");
  const ledgerPath = path.join(rootDir, relativePath);
  if (!(await exists(ledgerPath))) return;

  const lines = (await readFile(ledgerPath, "utf8")).split(/\r?\n/u);
  const pendingCandidate = lines.some(
    (line) =>
      /\bcurrent in-repo\b/iu.test(line) &&
      line.includes(`\`${releaseVersion}\``) &&
      /\bpending publication\b/iu.test(line),
  );
  if (pendingCandidate) {
    const prematureLiveLine = lines.find(
      (line) => /^\s*-\s*live\b/iu.test(line) && line.includes(releaseVersion),
    );
    if (prematureLiveLine) {
      failures.push(
        `pending candidate ${releaseVersion} must not be presented as live: ${prematureLiveLine.trim()}`,
      );
    }
  }

  lines.forEach((line, index) => {
    if (!/\bcurrent in-repo\b/iu.test(line)) return;
    const versions = line.match(/\b0\.\d+\.\d+\b/gu) ?? [];
    for (const version of versions) {
      if (version !== releaseVersion) {
        failures.push(
          `${relativePath}:${index + 1} stale current release reference ${version}; expected ${releaseVersion}`,
        );
      }
    }
  });
}

async function checkBuiltCli(failures, rootDir, releaseVersion) {
  const cliPath = path.join(rootDir, "dist", "bin", "martin-loop.js");
  if (!(await exists(cliPath))) {
    failures.push("built CLI is missing; run the release build before --built authority validation");
    return;
  }

  for (const args of [["--version"], ["doctor", "--json"]]) {
    const result = await run(process.execPath, [cliPath, ...args], rootDir);
    if (result.code !== 0) {
      failures.push(`built CLI ${args.join(" ")} exited ${result.code}: ${result.stderr.trim()}`);
      continue;
    }
    if (args[0] === "--version") {
      expectVersion(failures, releaseVersion, "built CLI version", result.stdout.trim());
    } else {
      try {
        const doctor = JSON.parse(result.stdout);
        const reported = doctor.version ?? doctor.cliVersion ?? doctor.martinVersion;
        expectVersion(failures, releaseVersion, "built CLI doctor version", reported);
      } catch {
        failures.push("built CLI doctor --json did not return valid JSON");
      }
    }
  }
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function main() {
  const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const failures = await collectReleaseAuthorityFailures(rootDir, {
    built: process.argv.includes("--built"),
  });
  if (failures.length > 0) {
    process.stderr.write(`Release authority check failed:\n- ${failures.join("\n- ")}\n`);
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  process.stdout.write(`Release authority aligned at ${manifest.version}.\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
