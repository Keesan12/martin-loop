import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveNpmShimScript,
  runSubprocess,
  runVerification,
  type SpawnLike
} from "../src/cli-bridge.js";

function immediateSpawn(output = "ok\n"): SpawnLike {
  return () => {
    const child = new EventEmitter() as Partial<ChildProcess> & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: Writable;
      exitCode: number | null;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    child.exitCode = null;
    Object.defineProperty(child, "pid", { value: 4242 });
    process.nextTick(() => {
      child.stdout.write(output);
      child.exitCode = 0;
      child.emit("exit", 0, null);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child as ChildProcess;
  };
}

describe("resolveNpmShimScript", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("resolves the real script wrapped by an npm-generated .cmd shim (generic package)", () => {
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

  it("resolves the real script wrapped by an npm-generated .ps1 shim (generic package)", () => {
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

  it("prefers npm-cli.js over npm-prefix.js when shim lists npm-prefix.js first", () => {
    dir = mkdtempSync(join(tmpdir(), "martin-shim-test-"));
    const prefixPath = join(dir, "npm-prefix.js");
    const cliPath = join(dir, "npm-cli.js");
    writeFileSync(prefixPath, "// npm-prefix stub\n");
    writeFileSync(cliPath, "// npm-cli stub\n");

    const shimPath = join(dir, "npm.cmd");
    writeFileSync(
      shimPath,
      [
        "@ECHO off",
        'node "%~dp0\\npm-prefix.js" %*',
        'node "%~dp0\\npm-cli.js" %*'
      ].join("\r\n")
    );

    expect(resolveNpmShimScript(shimPath)).toBe(cliPath);
  });

  it("returns undefined when npm-prefix.js exists but npm-cli.js is missing", () => {
    dir = mkdtempSync(join(tmpdir(), "martin-shim-test-"));
    const prefixPath = join(dir, "npm-prefix.js");
    writeFileSync(prefixPath, "// npm-prefix stub\n");

    const shimPath = join(dir, "npm.cmd");
    writeFileSync(shimPath, `@ECHO off\nnode "%~dp0\\npm-prefix.js" %*\n`);

    expect(resolveNpmShimScript(shimPath)).toBeUndefined();
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

describe("supervised CLI bridge", () => {
  it("preserves successful subprocess output through the shared supervisor", async () => {
    const result = await runSubprocess("tool", [], {
      cwd: process.cwd(),
      timeoutMs: 1_000,
      spawnImpl: immediateSpawn("verified\n")
    });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "verified\n",
      launched: true,
      completed: true,
      timedOut: false,
      cleanup: { state: "not_required" }
    });
  });

  it("binds external outcome evidence and authoritative run identity before stdout truncation", async () => {
    let observedEnv: NodeJS.ProcessEnv | undefined;
    const evidence = {
      kind: "external_outcome",
      contractId: "booking-save",
      sha256: "a".repeat(64),
      path: "external-outcomes/booking-save.json",
    };
    const spawnImpl: SpawnLike = (command, args, options) => {
      observedEnv = options?.env as NodeJS.ProcessEnv | undefined;
      return immediateSpawn(JSON.stringify({
        command: "outcomes verify",
        status: "passed",
        evidence,
        actions: Array.from({ length: 27 }, (_, index) => ({ actionId: `a-${index}`, status: "passed" })),
      }))(command, args, options);
    };

    const cwd = process.cwd();
    const result = await runVerification(
      ["martin outcomes verify --contract outcome-contract.json --json"],
      cwd,
      1_000,
      undefined,
      spawnImpl,
      {
        runId: "loop-outcome",
        workspaceId: "workspace-outcome",
        attemptId: "attempt-outcome",
        cwd,
        runsRoot: "C:/tmp/martin-runs",
        executionProfile: "staging_controlled",
        allowedNetworkDomains: ["staging.example.com"],
      },
    );

    expect(result.steps[0]?.evidence).toEqual(evidence);
    expect(result.steps[0]?.detail?.length).toBeLessThanOrEqual(500);
    expect(observedEnv).toMatchObject({
      MARTIN_RUN_ID: "loop-outcome",
      MARTIN_WORKSPACE_ID: "workspace-outcome",
      MARTIN_ATTEMPT_ID: "attempt-outcome",
      MARTIN_VERIFIER_CWD: cwd,
      MARTIN_RUNS_DIR: "C:/tmp/martin-runs",
      MARTIN_EXECUTION_PROFILE: "staging_controlled",
      MARTIN_ALLOWED_NETWORK_DOMAINS: JSON.stringify(["staging.example.com"]),
    });
  });

  it("forwards an already-aborted verifier signal without launching a command", async () => {
    const controller = new AbortController();
    controller.abort("cancelled");
    let spawnCalls = 0;

    const result = await runVerification(
      ["tool verify"],
      process.cwd(),
      1_000,
      undefined,
      () => {
        spawnCalls += 1;
        return immediateSpawn()("tool", []);
      },
      undefined,
      controller.signal
    );

    expect(spawnCalls).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.steps).toEqual([
      expect.objectContaining({ launched: false, completed: false, exitCode: 1 })
    ]);
  });
});
