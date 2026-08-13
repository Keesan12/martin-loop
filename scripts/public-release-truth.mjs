// SPDX-FileCopyrightText: MartinLoop contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Generates docs/product-truth/public-release-truth.json from live package.json files
 * and the canonical failure taxonomy document.
 *
 * Usage:
 *   node scripts/public-release-truth.mjs           # write/update the file
 *   node scripts/public-release-truth.mjs --check   # fail if file is stale
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, "$1")
  .replace(/%20/g, " ");
const OUTPUT = resolve(ROOT, "docs/product-truth/public-release-truth.json");

const rootPackage = JSON.parse(
  await readFile(resolve(ROOT, "package.json"), "utf8")
);
const mcpPackage = JSON.parse(
  await readFile(resolve(ROOT, "packages/mcp/package.json"), "utf8")
);

const taxonomyDocument = await readFile(
  resolve(ROOT, "docs/oss/FAILURE-TAXONOMY-13.md"),
  "utf8"
);
const taxonomyMatch = taxonomyDocument.match(
  /Failure Taxonomy \((\d+) Runtime Classes\)/
);

if (!taxonomyMatch) {
  throw new Error(
    "Could not resolve the canonical runtime failure-class count from docs/oss/FAILURE-TAXONOMY-13.md"
  );
}

const truth = {
  schemaVersion: "1.0.0",
  cliVersion: rootPackage.version,
  mcpVersion: mcpPackage.version,
  failureClassCount: Number(taxonomyMatch[1]),
};

const serialized = `${JSON.stringify(truth, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(OUTPUT, "utf8").catch(() => "");
  if (current !== serialized) {
    console.error("public-release-truth.json is stale. Run:");
    console.error("  node scripts/public-release-truth.mjs");
    process.exit(1);
  }
  console.log("Public release truth is synchronized.");
} else {
  await writeFile(OUTPUT, serialized);
  console.log(`Wrote ${OUTPUT}`);
}
