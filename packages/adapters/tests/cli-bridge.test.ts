import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveNpmShimScript } from "../src/cli-bridge.js";

describe("resolveNpmShimScript", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("resolves the real script wrapped by an npm-generated .cmd shim", () => {
    dir = mkdtempSync(join(tmpdir(), "martin-shim-test-"));
    const scriptPath = join(dir, "cli.js");
    writeFileSync(scriptPath, "// stub cli entrypoint\n");

    const shimPath = join(dir, "codex.cmd");
    writeFileSync(
      shimPath,
      [
        "@ECHO off",
        "SETLOCAL",
        'IF EXIST "%~dp0\\node.exe" (',
        '  "%~dp0\\node.exe"  "%~dp0\\cli.js" %*',
        ") ELSE (",
        '  node  "%~dp0\\cli.js" %*',
        ")"
      ].join("\r\n")
    );

    expect(resolveNpmShimScript(shimPath)).toBe(scriptPath);
  });

  it("resolves the real script wrapped by an npm-generated .ps1 shim", () => {
    dir = mkdtempSync(join(tmpdir(), "martin-shim-test-"));
    const scriptPath = join(dir, "cli.js");
    writeFileSync(scriptPath, "// stub cli entrypoint\n");

    const shimPath = join(dir, "claude.ps1");
    writeFileSync(
      shimPath,
      ['#!/usr/bin/env pwsh', '$basedir = Split-Path $MyInvocation.MyCommand.Definition -Parent', '& "$basedir/cli.js" $args'].join(
        "\n"
      )
    );

    expect(resolveNpmShimScript(shimPath)).toBe(scriptPath);
  });

  it("returns undefined when the shim references a script that does not exist on disk", () => {
    dir = mkdtempSync(join(tmpdir(), "martin-shim-test-"));
    const shimPath = join(dir, "codex.cmd");
    writeFileSync(shimPath, '@ECHO off\n"%~dp0\\node.exe" "%~dp0\\missing-cli.js" %*\n');

    expect(resolveNpmShimScript(shimPath)).toBeUndefined();
  });

  it("returns undefined when the shim file does not exist", () => {
    expect(resolveNpmShimScript("/nonexistent/path/codex.cmd")).toBeUndefined();
  });

  it("returns undefined for shim content with no recognizable node script reference", () => {
    dir = mkdtempSync(join(tmpdir(), "martin-shim-test-"));
    const shimPath = join(dir, "weird.cmd");
    writeFileSync(shimPath, "@ECHO off\necho hello world\n");

    expect(resolveNpmShimScript(shimPath)).toBeUndefined();
  });
});
