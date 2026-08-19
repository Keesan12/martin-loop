import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildCodexExecArgs,
  buildCodexStdin,
  checkCodexSandboxPreflight,
  clearCodexCapabilityCacheForTests,
  diagnoseCodexHost,
  probeCodexCapabilities,
  probeCodexLaunch,
  probeFilesystemWriteCapability,
  resolveCliCommandAvailability,
  type CodexCapabilityProfile
} from "../src/codex-launcher.js";

function profile(overrides: Partial<CodexCapabilityProfile> = {}): CodexCapabilityProfile {
  return {
    binaryPath: "/usr/local/bin/codex",
    supportsExec: true,
    probeSucceeded: true,
    promptTransport: "argv",
    ...overrides
  };
}

describe("resolveCliCommandAvailability", () => {
  it("captures the resolved path when the locator succeeds", () => {
    const availability = resolveCliCommandAvailability("codex", {
      platform: "win32",
      env: {},
      spawnSyncImpl: vi.fn(() => ({
        status: 0,
        stdout: "C:\\Tools\\npm\\codex.cmd\r\n",
        stderr: ""
      })) as never
    });

    expect(availability.available).toBe(true);
    expect(availability.resolvedPath).toContain("codex.cmd");
    expect(availability.locator).toBe("where.exe");
  });

  it("preserves Windows candidate discovery order from PATH", () => {
    const availability = resolveCliCommandAvailability("codex", {
      platform: "win32",
      env: {},
      spawnSyncImpl: vi.fn(() => ({
        status: 0,
        stdout: [
          "C:\\Tools\\npm\\codex",
          "C:\\Tools\\npm\\codex.cmd",
          "C:\\Program Files\\OpenAI\\Codex\\codex.exe",
          ""
        ].join("\r\n"),
        stderr: ""
      })) as never
    });

    expect(availability.candidatePaths).toEqual([
      "C:\\Tools\\npm\\codex",
      "C:\\Tools\\npm\\codex.cmd",
      "C:\\Program Files\\OpenAI\\Codex\\codex.exe"
    ]);
  });
});

describe("diagnoseCodexHost", () => {
  it("rejects a Windows-hosted Codex shim from WSL/Linux", () => {
    const diagnosis = diagnoseCodexHost(
      {
        command: "codex",
        available: true,
        locator: "which",
        detail: "codex is available on PATH.",
        resolvedPath: "/mnt/c/Users/Example/AppData/Roaming/npm/codex.cmd"
      },
      {
        platform: "linux",
        env: { WSL_DISTRO_NAME: "Ubuntu" }
      }
    );

    expect(diagnosis.hostPlatform).toBe("wsl");
    expect(diagnosis.installKind).toBe("windows_mounted_path");
    expect(diagnosis.nativeInstallValid).toBe(false);
    expect(diagnosis.sandboxCompatible).toBe(false);
  });
});

describe("probeCodexCapabilities", () => {
  it("parses global and exec flags separately", () => {
    clearCodexCapabilityCacheForTests();
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
      if (args.join(" ") === "--help") {
        return {
          status: 0,
          stdout: "Usage: codex [OPTIONS] [COMMAND]\n  --full-auto\n  --color <WHEN>",
          stderr: ""
        };
      }
      return {
        status: 0,
        stdout: [
          "Usage: codex exec [OPTIONS] [PROMPT]",
          "  --sandbox <SANDBOX_MODE> [possible values: read-only, workspace-write, danger-full-access]",
          "  --model <MODEL>",
          "  --cd <DIR>",
          "  --json",
          "Read prompt from stdin when '-' is supplied."
        ].join("\n"),
        stderr: ""
      };
    });

    const result = probeCodexCapabilities("/usr/local/bin/codex", {
      platform: "linux",
      spawnSyncImpl: spawnSyncImpl as never,
      cache: false
    });

    expect(result.supportsExec).toBe(true);
    expect(result.approval).toEqual({
      flag: "--full-auto",
      scope: "global",
      semantics: "automation-mode"
    });
    expect(result.sandbox).toEqual({
      flag: "--sandbox",
      scope: "exec",
      values: ["read-only", "workspace-write", "danger-full-access"]
    });
    expect(result.model).toEqual({ flag: "--model", scope: "exec" });
    expect(result.cwd).toEqual({ flag: "--cd", scope: "exec" });
    expect(result.json).toEqual({ flag: "--json", scope: "exec" });
    expect(result.color).toEqual({ flag: "--color", scope: "global" });
    expect(result.promptTransport).toBe("stdin-dash");
  });

  it("caches a real profile once per exact binary", () => {
    clearCodexCapabilityCacheForTests();
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) => ({
      status: 0,
      stdout: args[0] === "exec" ? "Usage: codex exec [PROMPT]" : "Usage: codex [COMMAND]",
      stderr: ""
    }));

    probeCodexCapabilities("/usr/local/bin/codex", {
      platform: "linux",
      spawnSyncImpl: spawnSyncImpl as never,
      cache: true
    });
    probeCodexCapabilities("/usr/local/bin/codex", {
      platform: "linux",
      spawnSyncImpl: spawnSyncImpl as never,
      cache: true
    });

    expect(spawnSyncImpl).toHaveBeenCalledTimes(2);
  });

  it("uses the Windows npm shim spawn shape for capability help", () => {
    clearCodexCapabilityCacheForTests();
    const shimDir = mkdtempSync(join(tmpdir(), "martin-codex-capability-shim-"));
    const scriptPath = join(shimDir, "cli.js");
    const shimPath = join(shimDir, "codex.cmd");
    writeFileSync(scriptPath, "// test codex entrypoint\n");
    writeFileSync(shimPath, '@ECHO off\n"%~dp0\\node.exe" "%~dp0\\cli.js" %*\n');

    try {
      const calls: Array<{ command: string; args: string[] }> = [];
      const spawnSyncImpl = vi.fn((command: string, args: string[]) => {
        calls.push({ command, args: [...args] });
        return {
          status: 0,
          stdout: args.includes("exec") ? "Usage: codex exec [PROMPT]" : "Usage: codex [COMMAND]",
          stderr: ""
        };
      });

      probeCodexCapabilities(shimPath, {
        platform: "win32",
        spawnSyncImpl: spawnSyncImpl as never,
        cache: false
      });

      expect(calls).toHaveLength(2);
      expect(calls[0]?.command).toBe(process.execPath);
      expect(calls[0]?.args[0]).toBe(scriptPath);
      expect(calls[1]?.command).toBe(process.execPath);
      expect(calls[1]?.args.slice(0, 3)).toEqual([scriptPath, "exec", "--help"]);
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
  });
});

describe("buildCodexExecArgs", () => {
  it("works with zero optional flags and makes no flag assumptions", () => {
    const args = buildCodexExecArgs({
      workingDirectory: "/repo",
      prompt: "do something",
      capabilityProfile: profile()
    });

    expect(args).toEqual(["exec", "do something"]);
    expect(args).not.toContain("--approve-for-me");
    expect(args).not.toContain("--sandbox");
    expect(args).not.toContain("--model");
  });

  it("uses the exact advertised sandbox mode", () => {
    const args = buildCodexExecArgs({
      workingDirectory: "/repo",
      sandbox: "workspace-write",
      prompt: "do something",
      capabilityProfile: profile({
        sandbox: {
          flag: "--sandbox",
          scope: "exec",
          values: ["read-only", "workspace-write"]
        }
      })
    });

    expect(args).toEqual(["exec", "--sandbox", "workspace-write", "do something"]);
  });

  it("does not escalate to danger-full-access when workspace-write is absent", () => {
    const args = buildCodexExecArgs({
      workingDirectory: "/repo",
      sandbox: "workspace-write",
      prompt: "do something",
      capabilityProfile: profile({
        sandbox: {
          flag: "--sandbox",
          scope: "exec",
          values: ["danger-full-access"]
        }
      })
    });

    expect(args).toEqual(["exec", "do something"]);
    expect(args).not.toContain("danger-full-access");
  });

  it("uses the exact advertised automation flag instead of a hardcoded name", () => {
    const args = buildCodexExecArgs({
      workingDirectory: "/repo",
      sandbox: "workspace-write",
      prompt: "do something",
      capabilityProfile: profile({
        approval: {
          flag: "--full-auto",
          scope: "global",
          semantics: "automation-mode"
        }
      })
    });

    expect(args).toEqual(["--full-auto", "exec", "do something"]);
    expect(args).not.toContain("--approve-for-me");
  });

  it("preserves global versus exec flag scope", () => {
    const args = buildCodexExecArgs({
      workingDirectory: "/repo",
      model: "operator-choice",
      prompt: "do something",
      capabilityProfile: profile({
        userConfigIsolation: { flag: "--ignore-user-config", scope: "global" },
        model: { flag: "--model", scope: "exec" },
        json: { flag: "--json", scope: "exec" }
      })
    });

    expect(args).toEqual([
      "--ignore-user-config",
      "exec",
      "--json",
      "--model",
      "operator-choice",
      "do something"
    ]);
  });

  it("omits model when operator did not explicitly select one", () => {
    const args = buildCodexExecArgs({
      workingDirectory: "/repo",
      prompt: "do something",
      capabilityProfile: profile({ model: { flag: "--model", scope: "exec" } })
    });
    expect(args).not.toContain("--model");
  });

  it("fails an explicit model override when the binary does not advertise model selection", () => {
    expect(() =>
      buildCodexExecArgs({
        workingDirectory: "/repo",
        model: "operator-choice",
        prompt: "do something",
        capabilityProfile: profile()
      })
    ).toThrow(/does not advertise a model override flag/iu);
  });

  it("uses stdin only when the exact binary advertises stdin prompt transport", () => {
    const p = profile({ promptTransport: "stdin-dash" });
    const args = buildCodexExecArgs({
      workingDirectory: "/repo",
      prompt: "long objective",
      capabilityProfile: p
    });

    expect(args).toEqual(["exec", "-"]);
    expect(buildCodexStdin(p, "long objective")).toBe("long objective");
  });
});

describe("probeCodexLaunch", () => {
  it("proves actual workspace-write ability with the dynamically built invocation", () => {
    clearCodexCapabilityCacheForTests();
    const workingDirectory = process.cwd();
    const spawnSyncImpl = vi.fn((_command: string, args: string[], options?: { input?: string }) => {
      if (args[0] === "codex-locator") {
        return { status: 0, stdout: "/usr/local/bin/codex\n", stderr: "" };
      }
      if (args.length === 1 && args[0] === "--help") {
        return { status: 0, stdout: "Usage: codex [COMMAND]", stderr: "" };
      }
      if (args[0] === "exec" && args[1] === "--help") {
        return {
          status: 0,
          stdout: [
            "Usage: codex exec [OPTIONS] [PROMPT]",
            "--sandbox <MODE> [possible values: read-only, workspace-write]",
            "--cd <DIR>",
            "Read prompt from stdin when '-' is supplied."
          ].join("\n"),
          stderr: ""
        };
      }

      const promptText = options?.input ?? args.at(-1) ?? "";
      const marker = promptText.match(/\.martin-codex-write-probe-[A-Za-z0-9.-]+\.tmp/u)?.[0];
      if (marker) {
        writeFileSync(join(workingDirectory, marker), "MARTIN_CODEX_WRITE_OK", "utf8");
      }
      return { status: 0, stdout: "READY\n", stderr: "" };
    });

    const result = probeCodexLaunch({
      workingDirectory,
      platform: "linux",
      env: {},
      availability: {
        command: "codex",
        available: true,
        locator: "test",
        detail: "test",
        resolvedPath: "/usr/local/bin/codex",
        candidatePaths: ["/usr/local/bin/codex"]
      },
      spawnSyncImpl: spawnSyncImpl as never
    });

    expect(result.ok).toBe(true);
    expect(result.capabilityProfile?.sandbox?.values).toContain("workspace-write");
    expect(result.args).toContain("--sandbox");
    expect(result.args).toContain("workspace-write");
    expect(result.args).not.toContain("--approve-for-me");
    expect(result.summary).toContain("workspace-write probe passed");
    const leftover = result.args.find((arg) => arg.includes(".martin-codex-write-probe-"));
    if (leftover) expect(existsSync(join(workingDirectory, leftover))).toBe(false);
  });
});

describe("filesystem sandbox preflight", () => {
  it("proves a writable directory by creating and removing a marker", () => {
    const directory = mkdtempSync(join(tmpdir(), "martin-codex-write-"));
    try {
      expect(probeFilesystemWriteCapability(directory)).toEqual({ writable: true });
      expect(checkCodexSandboxPreflight({
        requestedSandbox: "workspace-write",
        workingDirectory: directory
      }).ok).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
