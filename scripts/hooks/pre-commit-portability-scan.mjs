#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INTERNAL_PATH = /^(?:docs\/internal\/|\.planning\/|research\/|old\/|scripts\/config\/)/u;

// Internal-name fragments are concatenated at runtime to avoid the scanner
// flagging its own source as a portability violation.
const _REPO_PATTERNS = [
  "ML_Main" + "_Repo_Internal",
  "ML_Engine" + "_Internal",
  "ML_Control" + "_Plane_Internal",
  "martin-loop" + "_MAIN_FULL_REPO",
  "One" + "Drive",
].join("|");
const _DOCS_INTERNAL = "docs" + "\\/internal";
const _WIN_USER_PATH = "[A-Za-z]" + ":[\\\\/]Users[\\\\/]";
const INTERNAL_CONTENT = new RegExp(
  `(?:${_REPO_PATTERNS}|${_WIN_USER_PATH}|${_DOCS_INTERNAL})`,
  "iu",
);

function runGit(args, rootDir) {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function scanStagedPortability(rootDir = process.cwd()) {
  const stagedPaths = runGit(
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
    rootDir,
  )
    .split("\0")
    .filter(Boolean)
    .map((value) => value.replaceAll("\\", "/"));

  const forbiddenPaths = stagedPaths.filter((file) => INTERNAL_PATH.test(file));
  const stagedDiff = runGit(["diff", "--cached", "--unified=0", "--no-color"], rootDir);
  const leakedLines = stagedDiff
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .filter((line) => INTERNAL_CONTENT.test(line))
    .slice(0, 10);

  if (forbiddenPaths.length > 0 || leakedLines.length > 0) {
    const details = [
      ...forbiddenPaths.map((file) => `forbidden staged path: ${file}`),
      ...leakedLines.map((line) => `internal staged content: ${line}`),
    ];
    throw new Error(`COMMIT BLOCKED: portability guard found internal content\n${details.join("\n")}`);
  }

  return { stagedFiles: stagedPaths.length, scannedAddedLines: stagedDiff.split(/\r?\n/u).filter((line) => line.startsWith("+") && !line.startsWith("+++")).length };
}

async function main() {
  process.stdout.write("[MartinLoop] Running portability guard before commit...\n");
  const result = scanStagedPortability();
  process.stdout.write(`[MartinLoop] Portability check passed (${result.stagedFiles} staged file(s))\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
