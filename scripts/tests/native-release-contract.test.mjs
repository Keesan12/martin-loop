// SPDX-FileCopyrightText: MartinLoop contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { NATIVE_TARGETS, selectNativeTarget } from "../build-native.mjs";
import { verifyNativeReleaseAssets } from "../verify-native-release-assets.mjs";

const root = resolve(import.meta.dirname, "..", "..");

test("native target contract has exact public asset names", () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(NATIVE_TARGETS).map(([target, contract]) => [target, contract.asset])
    ),
    {
      "linux-x64": "martin-loop-linux-x64",
      "linux-arm64": "martin-loop-linux-arm64",
      "macos-x64": "martin-loop-macos-x64",
      "macos-arm64": "martin-loop-macos-arm64",
      "win-x64": "martin-loop-win-x64.exe"
    }
  );
  assert.throws(() => selectNativeTarget("win-arm64"), /Unsupported native target/);
});

test("release workflow and bootstrap installers use the same asset contracts", async () => {
  const [workflow, shellInstaller, powerShellInstaller] = await Promise.all([
    readFile(join(root, ".github", "workflows", "release.yml"), "utf8"),
    readFile(join(root, "install.sh"), "utf8"),
    readFile(join(root, "install.ps1"), "utf8")
  ]);
  for (const contract of Object.values(NATIVE_TARGETS)) {
    assert.match(workflow, new RegExp(contract.asset.replace(".", "\\.")));
  }
  assert.match(shellInstaller, /ASSET="martin-loop-\$\{TARGET\}"/);
  assert.match(powerShellInstaller, /\$Asset = "martin-loop-\$Target\.exe"/);
  assert.match(shellInstaller, /\.sha256/);
  assert.match(powerShellInstaller, /\.sha256/);
});

test("release verification fails for missing assets and checksum mismatches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "martin-native-contract-"));
  const contract = NATIVE_TARGETS["win-x64"];
  try {
    await assert.rejects(
      verifyNativeReleaseAssets({ directory, target: "win-x64" }),
      /Missing native asset/
    );
    const assetPath = join(directory, contract.asset);
    await writeFile(assetPath, "native");
    await writeFile(`${assetPath}.sha256`, `${"0".repeat(64)}  ${contract.asset}\n`);
    await assert.rejects(
      verifyNativeReleaseAssets({ directory, target: "win-x64" }),
      /Checksum mismatch/
    );
    const digest = createHash("sha256").update("native").digest("hex");
    await writeFile(`${assetPath}.sha256`, `${digest}  ${contract.asset}\n`);
    const result = await verifyNativeReleaseAssets({ directory, target: "win-x64" });
    assert.equal(result[0].sha256, digest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
