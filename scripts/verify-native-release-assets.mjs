#!/usr/bin/env node
// SPDX-FileCopyrightText: MartinLoop contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NATIVE_TARGETS } from "./build-native.mjs";

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyNativeReleaseAssets({
  directory,
  target,
  smoke = false
}) {
  const targets = target
    ? [[target, NATIVE_TARGETS[target]]]
    : Object.entries(NATIVE_TARGETS);
  if (targets.some(([, contract]) => !contract)) {
    throw new Error(`Unknown native target: ${target}`);
  }

  const verified = [];
  for (const [targetName, contract] of targets) {
    const assetPath = join(directory, contract.asset);
    const checksumPath = `${assetPath}.sha256`;
    if (!existsSync(assetPath)) throw new Error(`Missing native asset: ${contract.asset}`);
    if (!existsSync(checksumPath)) {
      throw new Error(`Missing checksum asset: ${contract.asset}.sha256`);
    }
    const checksumText = (await readFile(checksumPath, "utf8")).trim();
    const match = checksumText.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (!match || match[2] !== contract.asset) {
      throw new Error(`Malformed checksum contract for ${contract.asset}`);
    }
    const actual = await sha256(assetPath);
    if (actual !== match[1].toLowerCase()) {
      throw new Error(`Checksum mismatch for ${contract.asset}`);
    }
    if (smoke) {
      const result = spawnSync(assetPath, ["--version"], {
        encoding: "utf8",
        windowsHide: true
      });
      if (result.error || result.status !== 0) {
        throw new Error(
          `Native smoke test failed for ${contract.asset}: ${result.error?.message ?? result.stderr}`
        );
      }
    }
    verified.push({ target: targetName, asset: contract.asset, sha256: actual });
  }
  return verified;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const directory =
    process.argv.find((value) => value.startsWith("--directory="))?.slice(12) ??
    resolve("dist", "native");
  const target = process.argv.find((value) => value.startsWith("--target="))?.slice(9);
  verifyNativeReleaseAssets({
    directory,
    ...(target ? { target } : {}),
    smoke: process.argv.includes("--smoke")
  })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
