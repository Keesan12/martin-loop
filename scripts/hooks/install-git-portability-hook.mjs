#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE = path.join(SCRIPT_DIR, "pre-commit-portability.sh");

export async function installGitPortabilityHook(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? path.join(SCRIPT_DIR, "..", ".."));
  const sourcePath = path.resolve(options.sourcePath ?? DEFAULT_SOURCE);
  const gitPath = execFileSync("git", ["-C", rootDir, "rev-parse", "--git-path", "hooks/pre-commit"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const hookPath = path.isAbsolute(gitPath) ? gitPath : path.resolve(rootDir, gitPath);
  await mkdir(path.dirname(hookPath), { recursive: true });
  await copyFile(sourcePath, hookPath);
  await chmod(hookPath, 0o755);
  return hookPath;
}

async function main() {
  const hookPath = await installGitPortabilityHook();
  process.stdout.write(`Installed MartinLoop portability hook: ${hookPath}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
