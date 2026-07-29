// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import {
  InstallError,
  nativeAssetName,
  nativeTarget,
  parseSha256File,
  runInstall,
  type NativeInstallRuntime
} from "../src/commands/install.js";
import { executeCli, parseCliArguments, renderCliHelp } from "../src/index.js";

const temporaryDirectories: string[] = [];

function fakePeBinary(marker = 1): Uint8Array {
  const bytes = new Uint8Array(2048);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  bytes[1024] = marker;
  return bytes;
}

function checksum(bytes: Uint8Array, assetName: string): Uint8Array {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return Buffer.from(`${digest}  ${assetName}\n`);
}

async function installDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "martin-native-install-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runtimeFor(
  binary: Uint8Array,
  overrides: Partial<NativeInstallRuntime> = {}
): NativeInstallRuntime {
  const assetName = nativeAssetName("win-x64");
  return {
    platform: "win32",
    arch: "x64",
    now: () => 1234,
    verifyExecutable: () => "0.5.0",
    async fetchBytes(url) {
      if (url.endsWith(".sha256")) return checksum(binary, assetName);
      return binary;
    },
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("native release contracts", () => {
  it("uses exact platform asset names", () => {
    expect(nativeAssetName(nativeTarget("linux", "x64"))).toBe("martin-loop-linux-x64");
    expect(nativeAssetName(nativeTarget("linux", "arm64"))).toBe(
      "martin-loop-linux-arm64"
    );
    expect(nativeAssetName(nativeTarget("darwin", "x64"))).toBe("martin-loop-macos-x64");
    expect(nativeAssetName(nativeTarget("darwin", "arm64"))).toBe(
      "martin-loop-macos-arm64"
    );
    expect(nativeAssetName(nativeTarget("win32", "x64"))).toBe(
      "martin-loop-win-x64.exe"
    );
  });

  it("requires a checksum for the exact asset", () => {
    const hash = "a".repeat(64);
    expect(parseSha256File(`${hash}  martin-loop-linux-x64\n`, "martin-loop-linux-x64"))
      .toBe(hash);
    expect(() => parseSha256File("", "martin-loop-linux-x64")).toThrow(
      "missing or malformed"
    );
    expect(() =>
      parseSha256File(`${hash}  other-file\n`, "martin-loop-linux-x64")
    ).toThrow("instead of expected asset");
  });
});

describe("native install CLI", () => {
  it("parses version and directory without requiring a TTY", () => {
    expect(parseCliArguments(["install", "--version", "0.5.0", "--dir", "./bin"])).toEqual({
      command: "install",
      version: "0.5.0",
      directory: "./bin"
    });
    expect(renderCliHelp()).toContain(
      "martin install [--version <version>] [--dir <path>]"
    );
  });

  it("returns a typed JSON error without stdout contamination", async () => {
    const result = await executeCli(["--json", "install", "--version", "not-a-version"]);
    expect(result.exitCode).toBe(11);
    expect(result.stderr).toBe("");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      category: "install_failed"
    });
  });
});

describe("native install transaction", () => {
  it("fails on a missing asset and preserves the existing install", async () => {
    const directory = await installDirectory();
    const existing = join(directory, "martin-loop.exe");
    mkdirSync(directory, { recursive: true });
    writeFileSync(existing, "existing");
    const runtime = runtimeFor(fakePeBinary(), {
      fetchBytes: async () => {
        throw new InstallError("HTTP 404");
      }
    });

    await expect(
      runInstall({ version: "0.5.0", dir: directory, outputMode: "quiet", runtime })
    ).rejects.toThrow("HTTP 404");
    expect(readFileSync(existing, "utf8")).toBe("existing");
  });

  it("fails on checksum mismatch and preserves the existing install", async () => {
    const directory = await installDirectory();
    const existing = join(directory, "martin-loop.exe");
    writeFileSync(existing, "existing");
    const runtime = runtimeFor(fakePeBinary(), {
      async fetchBytes(url) {
        if (url.endsWith(".sha256")) {
          return Buffer.from(`${"0".repeat(64)}  martin-loop-win-x64.exe\n`);
        }
        return fakePeBinary();
      }
    });

    await expect(
      runInstall({ version: "0.5.0", dir: directory, outputMode: "quiet", runtime })
    ).rejects.toThrow("Checksum mismatch");
    expect(readFileSync(existing, "utf8")).toBe("existing");
  });

  it("rolls back when post-install verification fails", async () => {
    const directory = await installDirectory();
    const existing = join(directory, "martin-loop.exe");
    writeFileSync(existing, "existing");
    let calls = 0;
    const runtime = runtimeFor(fakePeBinary(2), {
      verifyExecutable: () => {
        calls += 1;
        if (calls === 2) throw new Error("post-install failure");
        return "0.5.0";
      }
    });

    await expect(
      runInstall({ version: "0.5.0", dir: directory, outputMode: "quiet", runtime })
    ).rejects.toThrow("rolled back");
    expect(readFileSync(existing, "utf8")).toBe("existing");
  });

  it("upgrades atomically and preserves a rollback binary", async () => {
    const directory = await installDirectory();
    const existing = join(directory, "martin-loop.exe");
    writeFileSync(existing, "existing");
    const binary = fakePeBinary(3);

    const result = await runInstall({
      version: "0.5.0",
      dir: directory,
      outputMode: "quiet",
      runtime: runtimeFor(binary)
    });

    expect(readFileSync(existing)).toEqual(Buffer.from(binary));
    expect(result.backupPath).toBeDefined();
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(readFileSync(result.backupPath!, "utf8")).toBe("existing");
    expect(readFileSync(result.aliasPath)).toEqual(Buffer.from(binary));
  });
});
