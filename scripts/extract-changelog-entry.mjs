#!/usr/bin/env node

/**
 * Extracts the release notes body for a given version from CHANGELOG.md.
 * Usage: node extract-changelog-entry.mjs --version 0.1.8
 * Prints the markdown body to stdout (without the ## [version] heading line).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function extractChangelogEntry(version, options = {}) {
  const changelogPath = options.changelogPath ?? path.join(ROOT_DIR, "CHANGELOG.md");
  const content = await readFile(changelogPath, "utf8");
  const lines = content.split(/\r?\n/);

  const headingPattern = /^## \[/;
  const versionPattern = new RegExp(`^## \\[${escapeRegex(version)}\\]`);

  let inEntry = false;
  const entryLines = [];

  for (const line of lines) {
    if (versionPattern.test(line)) {
      inEntry = true;
      continue;
    }
    if (inEntry && headingPattern.test(line)) {
      break;
    }
    if (inEntry) {
      entryLines.push(line);
    }
  }

  if (entryLines.length === 0) {
    throw new Error(`No changelog entry found for version ${version}`);
  }

  return entryLines.join("\n").trim();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readFlag(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1] ?? null;
}

async function main() {
  const version = readFlag(process.argv, "--version") ?? readFlag(process.argv, "-v");
  if (!version) {
    process.stderr.write("Usage: node extract-changelog-entry.mjs --version <version>\n");
    process.exitCode = 1;
    return;
  }

  const body = await extractChangelogEntry(version);
  process.stdout.write(body + "\n");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === path.resolve(modulePath)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`extract-changelog-entry failed: ${message}\n`);
    process.exitCode = 1;
  });
}
