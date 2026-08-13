// SPDX-FileCopyrightText: MartinLoop contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Validates docs/product-truth/claims-registry.json for correctness.
 * - JSON parses cleanly
 * - All capability IDs are unique and non-empty
 * - Status values are from the allowed set
 * - All evidence paths exist on disk
 */

import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, "$1")
  .replace(/%20/g, " ");
const registryPath = resolve(ROOT, "docs/product-truth/claims-registry.json");

let registry;
try {
  registry = JSON.parse(await readFile(registryPath, "utf8"));
} catch (err) {
  console.error(`Failed to parse claims-registry.json: ${err.message}`);
  process.exit(1);
}

const ALLOWED_STATUSES = new Set([
  "shipped",
  "partial",
  "beta",
  "internal",
  "building",
  "roadmap",
]);

const ids = new Set();
const errors = [];

for (const capability of registry.capabilities ?? []) {
  if (!capability.id || typeof capability.id !== "string") {
    errors.push(`Missing or invalid id: ${JSON.stringify(capability.id)}`);
    continue;
  }
  if (ids.has(capability.id)) {
    errors.push(`Duplicate capability id: ${capability.id}`);
    continue;
  }
  ids.add(capability.id);

  if (!ALLOWED_STATUSES.has(capability.status)) {
    errors.push(
      `Invalid status '${capability.status}' for ${capability.id}. Allowed: ${[...ALLOWED_STATUSES].join(", ")}`
    );
  }

  for (const evidencePath of capability.evidence ?? []) {
    try {
      await access(resolve(ROOT, evidencePath));
    } catch {
      errors.push(`Evidence path not found for ${capability.id}: ${evidencePath}`);
    }
  }
}

if (errors.length > 0) {
  console.error("Product truth validation FAILED:");
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

console.log(`Validated ${ids.size} product-truth capabilities. All checks passed.`);
