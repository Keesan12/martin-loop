#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRcCommandExecution } from "./rc-validation.mjs";
import { findSingleTarball } from "./root-release-guard.mjs";

export async function packRootRelease(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const outputDir = path.resolve(rootDir, options.outputDir ?? "dist-release");
  await mkdir(outputDir, { recursive: true });

  await runCommand(
    ["npm", "pack", "--pack-destination", outputDir],
    { cwd: rootDir },
  );
  const tarballName = await findSingleTarball(outputDir);

  return {
    outputDir,
    tarballName,
    tarballPath: path.join(outputDir, tarballName),
  };
}

function parseArgs(argv) {
  const outputDirIndex = argv.indexOf("--output-dir");
  return {
    outputDir: outputDirIndex === -1 ? "dist-release" : argv[outputDirIndex + 1] ?? "dist-release",
  };
}

function runCommand(command, options) {
  const execution = resolveRcCommandExecution(command, process.platform);

  return new Promise((resolve, reject) => {
    const child = spawn(execution.command, execution.args, {
      cwd: options.cwd,
      env: process.env,
      shell: execution.shell,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(`Command failed (${code ?? "unknown"}): ${command.join(" ")}\n${stdout}${stderr}`),
        );
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await packRootRelease({
    rootDir: process.cwd(),
    outputDir: args.outputDir,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === path.resolve(modulePath)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Root tarball pack failed: ${message}\n`);
    process.exitCode = 1;
  });
}
