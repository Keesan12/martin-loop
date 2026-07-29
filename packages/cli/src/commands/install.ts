// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";

import type { MartinOutputMode } from "@martin/contracts";

const RELEASE_REPOSITORY = "Keesan12/martin-loop";
const PRODUCT_NAME = "martin-loop";

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallError";
  }
}

export interface NativeInstallRuntime {
  platform: NodeJS.Platform;
  arch: string;
  fetchBytes(url: string): Promise<Uint8Array>;
  verifyExecutable(path: string): string;
  now(): number;
}

export interface InstallOptions {
  version?: string;
  dir?: string;
  outputMode: MartinOutputMode;
  runtime?: NativeInstallRuntime;
}

export interface InstallResult {
  version: string;
  installPath: string;
  aliasPath: string;
  backupPath?: string;
  target: string;
  assetName: string;
}

export function nativeTarget(
  platformName: NodeJS.Platform = platform(),
  architecture: string = arch()
): string {
  const os =
    platformName === "darwin"
      ? "macos"
      : platformName === "win32"
        ? "win"
        : platformName === "linux"
          ? "linux"
          : undefined;
  const normalizedArch =
    architecture === "x64" || architecture === "arm64" ? architecture : undefined;
  if (!os) {
    throw new InstallError(`Unsupported operating system: ${platformName}`);
  }
  if (!normalizedArch) {
    throw new InstallError(`Unsupported architecture: ${architecture}`);
  }
  if (os === "win" && normalizedArch !== "x64") {
    throw new InstallError("Windows native releases currently support x64 only");
  }
  return `${os}-${normalizedArch}`;
}

export function nativeAssetName(target: string): string {
  return `${PRODUCT_NAME}-${target}${target.startsWith("win-") ? ".exe" : ""}`;
}

export function parseSha256File(contents: string, expectedAsset: string): string {
  const match = contents.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
  if (!match) {
    throw new InstallError("Checksum file is missing or malformed");
  }
  const digest = match[1];
  const fileName = match[2];
  if (!digest || !fileName) {
    throw new InstallError("Checksum file is missing or malformed");
  }
  if (fileName !== expectedAsset) {
    throw new InstallError(
      `Checksum file names ${fileName} instead of expected asset ${expectedAsset}`
    );
  }
  return digest.toLowerCase();
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateBinary(bytes: Uint8Array, target: string): void {
  if (bytes.byteLength < 1024) {
    throw new InstallError(
      `Downloaded asset is too small (${bytes.byteLength} bytes); the release asset may be missing`
    );
  }
  const isPe = bytes[0] === 0x4d && bytes[1] === 0x5a;
  const isElf =
    bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
  const magic = Buffer.from(bytes.subarray(0, 4)).readUInt32BE(0);
  const isMachO =
    magic === 0xfeedface ||
    magic === 0xfeedfacf ||
    magic === 0xcefaedfe ||
    magic === 0xcffaedfe;
  const valid = target.startsWith("win-")
    ? isPe
    : target.startsWith("linux-")
      ? isElf
      : isMachO;
  if (!valid) {
    throw new InstallError(`Downloaded asset is not a valid ${target} executable`);
  }
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": "martin-loop-installer"
      },
      redirect: "follow"
    });
  } catch (error) {
    throw new InstallError(`Network request failed for ${url}: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new InstallError(`HTTP ${response.status} downloading ${url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

const defaultRuntime: NativeInstallRuntime = {
  platform: platform(),
  arch: arch(),
  fetchBytes,
  verifyExecutable(path) {
    return execFileSync(path, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true
    }).trim();
  },
  now: () => Date.now()
};

function defaultInstallDirectory(platformName: NodeJS.Platform): string {
  if (platformName === "win32") {
    return join(
      process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"),
      "martin-loop",
      "bin"
    );
  }
  return join(homedir(), ".local", "bin");
}

function readVersionFromLatestRelease(bytes: Uint8Array): string {
  let parsed: { tag_name?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as { tag_name?: unknown };
  } catch {
    throw new InstallError("Latest release response was not valid JSON");
  }
  if (typeof parsed.tag_name !== "string" || !/^v\d+\.\d+\.\d+/.test(parsed.tag_name)) {
    throw new InstallError("Latest release response did not contain a valid version tag");
  }
  return parsed.tag_name.slice(1);
}

function removeIfPresent(path: string): void {
  if (existsSync(path)) {
    rmSync(path, { force: true });
  }
}

export async function runInstall(options: InstallOptions): Promise<InstallResult> {
  const runtime = options.runtime ?? defaultRuntime;
  const target = nativeTarget(runtime.platform, runtime.arch);
  const assetName = nativeAssetName(target);
  const installDirectory = options.dir ?? defaultInstallDirectory(runtime.platform);
  const extension = target.startsWith("win-") ? ".exe" : "";
  const installPath = join(installDirectory, `${PRODUCT_NAME}${extension}`);
  const aliasPath = join(installDirectory, `martin${extension}`);
  const nonce = `${process.pid}-${runtime.now()}`;
  const stagedPath = join(installDirectory, `.${PRODUCT_NAME}.${nonce}.stage${extension}`);
  const stagedAliasPath = join(installDirectory, `.martin.${nonce}.stage${extension}`);
  const backupPath = join(installDirectory, `.${PRODUCT_NAME}.${nonce}.backup${extension}`);
  const aliasBackupPath = join(installDirectory, `.martin.${nonce}.backup${extension}`);

  const version =
    options.version ??
    readVersionFromLatestRelease(
      await runtime.fetchBytes(
        `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`
      )
    );
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new InstallError(`Invalid release version: ${version}`);
  }

  const releaseBase = `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}`;
  const assetUrl = `${releaseBase}/${assetName}`;
  const checksumUrl = `${assetUrl}.sha256`;
  const assetBytes = await runtime.fetchBytes(assetUrl);
  const checksumBytes = await runtime.fetchBytes(checksumUrl);
  const expected = parseSha256File(Buffer.from(checksumBytes).toString("utf8"), assetName);
  const actual = sha256(assetBytes);
  if (actual !== expected) {
    throw new InstallError(`Checksum mismatch for ${assetName}`);
  }
  validateBinary(assetBytes, target);

  mkdirSync(installDirectory, { recursive: true });
  writeFileSync(stagedPath, assetBytes, { mode: 0o755, flag: "wx" });
  if (runtime.platform !== "win32") {
    chmodSync(stagedPath, 0o755);
  }
  try {
    runtime.verifyExecutable(stagedPath);
  } catch (error) {
    removeIfPresent(stagedPath);
    throw new InstallError(`Downloaded executable failed verification: ${(error as Error).message}`);
  }

  const hadInstall = existsSync(installPath);
  const hadAlias = existsSync(aliasPath);
  try {
    if (hadInstall) renameSync(installPath, backupPath);
    if (hadAlias) renameSync(aliasPath, aliasBackupPath);
    renameSync(stagedPath, installPath);
    if (runtime.platform === "win32") {
      copyFileSync(installPath, stagedAliasPath);
    } else {
      symlinkSync(installPath, stagedAliasPath);
    }
    renameSync(stagedAliasPath, aliasPath);
    runtime.verifyExecutable(installPath);
  } catch (error) {
    removeIfPresent(stagedPath);
    removeIfPresent(stagedAliasPath);
    removeIfPresent(aliasPath);
    removeIfPresent(installPath);
    if (hadInstall && existsSync(backupPath)) renameSync(backupPath, installPath);
    if (hadAlias && existsSync(aliasBackupPath)) renameSync(aliasBackupPath, aliasPath);
    throw new InstallError(`Native install failed and was rolled back: ${(error as Error).message}`);
  }

  removeIfPresent(aliasBackupPath);
  return {
    version,
    installPath,
    aliasPath,
    ...(hadInstall && existsSync(backupPath) ? { backupPath } : {}),
    target,
    assetName
  };
}

export function verifyInstalledNativeBinary(path: string): {
  path: string;
  size: number;
  sha256: string;
} {
  if (!existsSync(path)) {
    throw new InstallError(`Installed binary not found: ${path}`);
  }
  const bytes = readFileSync(path);
  return {
    path,
    size: statSync(path).size,
    sha256: sha256(bytes)
  };
}
