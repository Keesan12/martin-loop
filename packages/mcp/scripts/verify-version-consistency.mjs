#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function collectMcpVersionFailures(packageDir = PACKAGE_DIR) {
  const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  const server = JSON.parse(await readFile(path.join(packageDir, "server.json"), "utf8"));
  const runtime = await readFile(path.join(packageDir, "src", "package-version.ts"), "utf8");
  const canonical = manifest.version;
  const npmPackage = server.packages?.find((entry) => entry?.registryType === "npm");
  const runtimeVersion = runtime.match(/MARTIN_MCP_PACKAGE_VERSION\s*=\s*["']([^"']+)["']/u)?.[1];
  const surfaces = [
    ["server.json version", server.version],
    ["server.json npm package version", npmPackage?.version],
    ["runtime package version", runtimeVersion],
  ];
  return surfaces
    .filter(([, version]) => version !== canonical)
    .map(([label, version]) => `${label} expected ${canonical}; received ${String(version)}`);
}

async function main() {
  const failures = await collectMcpVersionFailures();
  if (failures.length > 0) {
    process.stderr.write(`MCP version consistency check failed:\n- ${failures.join("\n- ")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("MCP version surfaces are synchronized.\n");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
