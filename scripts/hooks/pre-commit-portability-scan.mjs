#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INTERNAL_PATH = /^(?:docs\/internal\/|\.planning\/|research\/|old\/|scripts\/config\/)/u;

const INTERNAL_CONTENT = /(?:\b[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*_Internal\b|\b[A-Za-z0-9-]+_MAIN_FULL_REPO\b|[A-Za-z]:[\\/]Users[\\/]|docs[\\/]internal|[A-Za-z]:[\\/][^\r\n]*[\\/]One[D]rive[\\/])/iu;

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
