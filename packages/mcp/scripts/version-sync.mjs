#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readMcpPackageVersion, writeMcpRuntimeVersion } from "./version-authority.mjs";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function synchronizeMcpVersion(packageDir = PACKAGE_DIR) {
  const serverPath = path.join(packageDir, "server.json");
  const runtimePath = path.join(packageDir, "src", "package-version.ts");
  const version = await readMcpPackageVersion(packageDir);

  const server = JSON.parse(await readFile(serverPath, "utf8"));
  const npmPackage = server.packages?.find((entry) => entry?.registryType === "npm");
  if (!npmPackage) {
    throw new Error("server.json contains no npm package entry");
  }

  server.version = version;
  npmPackage.version = version;
  await writeFile(serverPath, `${JSON.stringify(server, null, 2)}\n`, "utf8");
  await writeMcpRuntimeVersion(packageDir);
  return { version, serverPath, runtimePath };
}

async function main() {
  const result = await synchronizeMcpVersion();
  process.stdout.write(`Synchronized MCP release authority at ${result.version}.\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`version-sync: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
