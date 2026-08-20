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
  resolveCodexAutonomyCandidates,
  probeFilesystemWriteCapability,
  resolveCliCommandAvailability,
  type CodexCapabilityProfile
  , type CodexAutonomyResolution
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

function autonomy(
  binaryPath = "/usr/local/bin/codex",
  overrides: Partial<CodexAutonomyResolution> = {}
): CodexAutonomyResolution {
  return {
    binaryPath,
    intent: "governed-autonomous",
    strategy: "automation",
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
  it("discovers every advertised approval value without selecting a policy", () => {
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) => ({
      status: 0,
      stdout: args[0] === "exec"
        ? [
            "Usage: codex exec [OPTIONS] [PROMPT]",
            "--ask-for-approval <POLICY> [possible values: untrusted, on-failure, on-request, never]"
          ].join("\n")
        : "Usage: codex [COMMAND]",
      stderr: ""
    }));

    const result = probeCodexCapabilities("/tools/codex-a", {
      platform: "linux",
      spawnSyncImpl: spawnSyncImpl as never,
      cache: false
    });

    expect(result.approvalPolicy?.values).toEqual([
      "untrusted",
      "on-failure",
      "on-request",
      "never"
    ]);
    expect(result).not.toHaveProperty("selectedWriteStrategy");
  });
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
  it("refuses prompt execution without a negotiated autonomous resolution", () => {
    expect(() => buildCodexExecArgs({
      workingDirectory: "/repo",
      prompt: "do something",
      capabilityProfile: profile()
    })).toThrow(/negotiated governed-autonomous/iu);
  });

  it("rejects permission overrides in extra arguments", () => {
    const detected = profile({
      automation: { flag: "--approve-for-me", scope: "exec", semantics: "automation-mode" }
    });
    expect(() => buildCodexExecArgs({
      workingDirectory: "/repo",
      prompt: "do something",
      capabilityProfile: detected,
      autonomyResolution: autonomy(),
      extraArgs: ["--approve-for-me"]
    })).toThrow(/permission.*extraArgs/iu);
    expect(() => buildCodexExecArgs({
      workingDirectory: "/repo",
      prompt: "do something",
      capabilityProfile: detected,
      autonomyResolution: autonomy(),
      extraArgs: ["--sandbox", "danger-full-access"]
    })).toThrow(/permission.*extraArgs/iu);
  });
  it("works with zero optional flags and makes no flag assumptions", () => {
    const args = buildCodexExecArgs({
      workingDirectory: "/repo",
      prompt: "do something",
      mode: "probe",
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
        },
        approvalPolicy: {
          flag: "--ask-for-approval",
          scope: "exec",
          semantics: "approval-policy",
          values: ["never"]
        }
      }),
      autonomyResolution: autonomy("/usr/local/bin/codex", {
        strategy: "sandbox+approval",
        sandboxValue: "workspace-write",
        approvalValue: "never"
      })
    });

    expect(args).toEqual([
      "exec",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "do something"
    ]);
  });

  it("does not escalate to danger-full-access when workspace-write is absent", () => {
    const args = buildCodexExecArgs({
      workingDirectory: "/repo",
      sandbox: "workspace-write",
      prompt: "do something",
      mode: "probe",
      capabilityProfile: profile({
        sandbox: {
          flag: "--sandbox",
          scope: "exec",
          values: ["danger-full-access"]
        }
      }),
      autonomyResolution: autonomy()
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
      }),
      autonomyResolution: autonomy()
    });

    expect(args).toEqual(["--full-auto", "exec", "do something"]);
    expect(args).not.toContain("--approve-for-me");
  });

  it("preserves global versus exec flag scope", () => {
    const args = buildCodexExecArgs({
      workingDirectory: "/repo",
      model: "operator-choice",
      prompt: "do something",
      mode: "probe",
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
      mode: "probe",
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
        mode: "probe",
        capabilityProfile: profile()
      })
    ).toThrow(/does not advertise a model override flag/iu);
  });

  it("uses stdin only when the exact binary advertises stdin prompt transport", () => {
    const p = profile({ promptTransport: "stdin-dash" });
    const args = buildCodexExecArgs({
      workingDirectory: "/repo",
      prompt: "long objective",
      mode: "probe",
      capabilityProfile: p
    });

    expect(args).toEqual(["exec", "-"]);
    expect(buildCodexStdin(p, "long objective")).toBe("long objective");
  });
});

describe("resolveCodexAutonomyCandidates", () => {
  it("keeps capability detection separate from governed-autonomous policy resolution", () => {
    const candidates = resolveCodexAutonomyCandidates(profile({
      automation: { flag: "--approve-for-me", scope: "exec", semantics: "automation-mode" },
      sandbox: { flag: "--sandbox", scope: "exec", values: ["workspace-write", "danger-full-access"] },
      approvalPolicy: {
        flag: "--ask-for-approval",
        scope: "global",
        semantics: "approval-policy",
        values: ["on-request", "never"]
      }
    }));

    expect(candidates.map((candidate) => candidate.strategy)).toEqual([
      "automation"
    ]);
    expect(candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ approvalValue: "on-request" }),
      expect.objectContaining({ approvalValue: "never" })
    ]));
    expect(candidates.flatMap((candidate) => Object.values(candidate))).not.toContain("danger-full-access");
  });

  it.each([
    profile(),
    profile({ sandbox: { flag: "--sandbox", scope: "exec", values: ["workspace-write"] } }),
    profile({
      approvalPolicy: {
        flag: "--ask-for-approval",
        scope: "exec",
        semantics: "approval-policy",
        values: ["never"]
      }
    }),
    profile({ sandbox: { flag: "--sandbox", scope: "exec", values: ["danger-full-access"] } })
  ])("does not downgrade to default, sandbox-only, approval-only, or danger", (detected) => {
    expect(resolveCodexAutonomyCandidates(detected)).toEqual([]);
  });
});

describe("probeCodexLaunch", () => {
  it("proves actual workspace-write ability with the dynamically built invocation", () => {
    clearCodexCapabilityCacheForTests();
    const workingDirectory = process.cwd();
    let simulateOutsideEscape = false;
    let observedTimeout: number | undefined;
    const spawnSyncImpl = vi.fn((_command: string, args: string[], options?: { input?: string; timeout?: number }) => {
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
            "--full-auto  Run non-interactively with workspace-scoped automation",
            "--sandbox <MODE> [possible values: read-only, workspace-write]",
            "--ask-for-approval <POLICY> [possible values: on-request, never]",
            "--cd <DIR>",
            "Read prompt from stdin when '-' is supplied."
          ].join("\n"),
          stderr: ""
        };
      }

      const promptText = options?.input ?? args.at(-1) ?? "";
      observedTimeout = options?.timeout;
      const outsideMarker = promptText.match(/"([^"]*\.martin-codex-outside-probe\.tmp)"/u)?.[1];
      if (simulateOutsideEscape && outsideMarker) {
        writeFileSync(outsideMarker, "MARTIN_CODEX_OUTSIDE_BAD", "utf8");
      }
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

    expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.capabilityProfile?.sandbox?.values).toContain("workspace-write");
    expect(result.args).toContain("--full-auto");
    expect(result.args).not.toContain("--ask-for-approval");
    expect(result.summary).toContain("workspace-write probe passed");
    expect(observedTimeout).toBe(300_000);
    const leftover = result.args.find((arg) => arg.includes(".martin-codex-write-probe-"));
    if (leftover) expect(existsSync(join(workingDirectory, leftover))).toBe(false);

    simulateOutsideEscape = true;
    const escaped = probeCodexLaunch({
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
      spawnSyncImpl: spawnSyncImpl as never,
      providerExecutionTimeoutMs: 900_000
    });
    expect(escaped.ok).toBe(false);
    expect(escaped.summary).toMatch(/escaped|outside|boundary/iu);
    expect(observedTimeout).toBe(900_000);
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
