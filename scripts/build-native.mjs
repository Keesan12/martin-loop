#!/usr/bin/env node
// SPDX-FileCopyrightText: MartinLoop contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";

export const NATIVE_TARGETS = Object.freeze({
  "linux-x64": { pkgTarget: "node22-linux-x64", asset: "martin-loop-linux-x64" },
  "linux-arm64": {
    pkgTarget: "node22-linux-arm64",
    asset: "martin-loop-linux-arm64"
  },
  "macos-x64": { pkgTarget: "node22-macos-x64", asset: "martin-loop-macos-x64" },
  "macos-arm64": {
    pkgTarget: "node22-macos-arm64",
    asset: "martin-loop-macos-arm64"
  },
  "win-x64": { pkgTarget: "node22-win-x64", asset: "martin-loop-win-x64.exe" }
});

export function hostNativeTarget() {
  const os = platform() === "darwin" ? "macos" : platform() === "win32" ? "win" : platform();
  return `${os}-${arch()}`;
}

export function selectNativeTarget(value = process.env.NATIVE_TARGET ?? hostNativeTarget()) {
  const target = NATIVE_TARGETS[value];
  if (!target) {
    throw new Error(
      `Unsupported native target ${value}. Expected one of: ${Object.keys(NATIVE_TARGETS).join(", ")}`
    );
  }
  return { name: value, ...target };
}

function run(command, args, cwd) {
  const windowsPnpm = process.platform === "win32" && command === "pnpm";
  const executable = windowsPnpm ? process.env.ComSpec ?? "cmd.exe" : command;
  const commandArgs = windowsPnpm
    ? ["/d", "/s", "/c", `pnpm.cmd ${args.join(" ")}`]
    : args;
  const result = spawnSync(executable, commandArgs, {
    cwd,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function buildNative({
  root = fileURLToPath(new URL("..", import.meta.url)),
  skipBuild = process.argv.includes("--skip-build")
} = {}) {
  const normalizedRoot = root;
  const target = selectNativeTarget();
  const outDirectory = join(normalizedRoot, "dist", "native");
  const bundleDirectory = join(normalizedRoot, "dist", "native-bundle");
  const bundle = join(bundleDirectory, "martin-loop.cjs");
  const entry = join(normalizedRoot, "packages", "cli", "dist", "bin", "martin.js");
  const output = join(outDirectory, target.asset);
  const packageJson = JSON.parse(
    await readFile(join(normalizedRoot, "package.json"), "utf8")
  );

  if (!skipBuild) run("pnpm", ["build"], normalizedRoot);
  await mkdir(bundleDirectory, { recursive: true });
  await mkdir(outDirectory, { recursive: true });
  await writeFile(
    join(normalizedRoot, "dist", "package.json"),
    `${JSON.stringify({ name: packageJson.name, version: packageJson.version })}\n`
  );
  try {
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      target: "node22",
      format: "cjs",
      outfile: bundle,
      external: ["@resvg/resvg-js"],
      banner: {
        js: 'const __martinImportMetaUrl = require("node:url").pathToFileURL(__filename).href;'
      },
      define: {
        "import.meta.url": "__martinImportMetaUrl",
        __MARTIN_NATIVE_PACKAGE_VERSION__: JSON.stringify(packageJson.version)
      },
      minifySyntax: true
    });
    run(
      process.execPath,
      [
        join(normalizedRoot, "node_modules", "@yao-pkg", "pkg", "lib-es5", "bin.js"),
        bundle,
        "--target",
        target.pkgTarget,
        "--output",
        output,
        "--compress",
        "GZip"
      ],
      normalizedRoot
    );
    const digest = await sha256(output);
    await writeFile(`${output}.sha256`, `${digest}  ${target.asset}\n`);
    await writeFile(
      join(outDirectory, `${target.asset}.json`),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          version: packageJson.version,
          target: target.name,
          asset: target.asset,
          sha256: digest
        },
        null,
        2
      )}\n`
    );
    return { ...target, output, sha256: digest };
  } finally {
    await rm(bundleDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  buildNative()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`Native build failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
