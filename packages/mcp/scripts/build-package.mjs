#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildStandaloneMcpPackage } from "./build-package-lib.mjs";

export { buildStandaloneMcpPackage, rewritePackageSpecifiers } from "./build-package-lib.mjs";

async function main() {
  const result = await buildStandaloneMcpPackage();
  process.stdout.write(`Standalone MCP package built at ${result.distDir}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === path.resolve(modulePath)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Standalone MCP build failed: ${message}\n`);
    process.exitCode = 1;
  });
}
