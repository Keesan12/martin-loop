import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";

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
  type CodexCapabilityProfile,
  type CodexAutonomyResolution
} from "../src/codex-launcher.js";
import { markCodexAutonomyResolutionVerifiedByLaunchProbe } from "../src/codex-capabilities.js";
import { createCodexCliAdapter } from "../src/codex-cli.js";
import type { SpawnLike } from "../src/cli-bridge.js";

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

  it("discovers Claude Code from the native Windows installer directory", () => {
    const userProfile = mkdtempSync(join(tmpdir(), "martin-claude-native-"));
    const nativeBin = join(userProfile, ".local", "bin");
    mkdirSync(nativeBin, { recursive: true });
    const claudeExe = join(nativeBin, "claude.exe");
    writeFileSync(claudeExe, "", "utf8");

    try {
      const availability = resolveCliCommandAvailability("claude", {
        platform: "win32",
        env: {
          USERPROFILE: userProfile,
          PATHEXT: ".EXE"
        },
        spawnSyncImpl: vi.fn(() => ({
          status: 1,
          stdout: "",
          stderr: ""
        })) as never
      });

      expect(availability.available).toBe(true);
      expect(availability.locator).toBe("off-path-discovery");
      expect(availability.resolvedPath).toBe(claudeExe);
    } finally {
      rmSync(userProfile, { recursive: true, force: true });
    }
  });

  it("recommends the native Claude installer instead of the deprecated npm package", () => {
    const availability = resolveCliCommandAvailability("claude", {
      platform: "win32",
      env: {},
      spawnSyncImpl: vi.fn(() => ({
        status: 1,
        stdout: "",
        stderr: ""
      })) as never
    });

    expect(availability.available).toBe(false);
    expect(availability.detail).toContain("irm https://claude.ai/install.ps1 | iex");
    expect(availability.detail).not.toContain("@anthropic-ai/claude-code");
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

  it("parses Codex 0.147 sandbox values when help separates them with a blank line", () => {
    clearCodexCapabilityCacheForTests();
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) => ({
      status: 0,
      stdout: args[0] === "exec"
        ? [
            "Usage: codex exec [OPTIONS] [PROMPT]",
            "  -s, --sandbox <SANDBOX_MODE>",
            "          Select the sandbox policy to use when executing model-generated shell commands",
            "          ",
            "          [possible values: read-only, workspace-write, danger-full-access]",
            "  -a, --ask-for-approval <APPROVAL_POLICY>",
            "          Configure when the model requires human approval",
            "          Possible values:",
            "          - untrusted: ask for untrusted commands",
            "          - on-request: let the model decide",
            "          - never: never ask for approval",
            "      --approve-for-me",
            "          Route approval requests through automatic review using the workspace-write sandbox"
          ].join("\n")
        : "Usage: codex [OPTIONS] <COMMAND> [ARGS]",
      stderr: ""
    }));

    const result = probeCodexCapabilities("codex", {
      platform: "win32",
      spawnSyncImpl: spawnSyncImpl as never,
      cache: false
    });

    expect(result.sandbox?.values).toEqual([
      "read-only",
      "workspace-write",
      "danger-full-access"
    ]);
    expect(result.approvalPolicy?.values).toEqual(["untrusted", "on-request", "never"]);
    expect(resolveCodexAutonomyCandidates(result)[0]).toMatchObject({
      strategy: "sandbox+approval",
      sandboxValue: "workspace-write",
      approvalValue: "never"
    });
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
        },
        automation: {
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

describe("createCodexCliAdapter live token enforcement", () => {
  it("terminates a streaming Codex child after a turn reports a token-lease breach", async () => {
    let killed = false;
    const adapter = createCodexCliAdapter({
      capabilityProfile: profile({
        binaryPath: "codex",
        sandbox: { flag: "--sandbox", scope: "exec", values: ["workspace-write"] },
        approvalPolicy: {
          flag: "--ask-for-approval",
          scope: "exec",
          semantics: "approval-policy",
          values: ["never"]
        },
        json: { flag: "--json", scope: "exec" },
        promptTransport: "stdin-dash"
      }),
      autonomyResolution: markCodexAutonomyResolutionVerifiedByLaunchProbe({
        binaryPath: "codex",
        intent: "governed-autonomous",
        strategy: "sandbox+approval",
        sandboxValue: "workspace-write",
        approvalValue: "never"
      }),
      spawnImpl: createStreamingCodexSpawn([
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 1_300,
            cached_input_tokens: 500,
            output_tokens: 900,
            reasoning_output_tokens: 500
          }
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "completed after exceeding the lease" }
        })
      ], () => { killed = true; })
    });

    const result = await adapter.execute({
      loopId: "loop-codex-token-lease",
      workspaceId: "workspace-codex-token-lease",
      attemptId: "attempt-codex-token-lease",
      context: {
        taskTitle: "bounded child",
        objective: "respect the child token lease",
        verificationPlan: [],
        focus: "bounded execution",
        remainingBudgetUsd: 100,
        remainingIterations: 1,
        remainingTokens: 2_000
      },
      previousAttempts: []
    });

    expect(killed).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.failure?.classHint).toBe("budget_pressure");
    expect(result.failure?.message).toMatch(/token.*(?:cap|lease)|(?:cap|lease).*token/iu);
    expect(result.summary).not.toContain("completed after exceeding the lease");
    expect(result.usage.tokensIn).toBe(1_300);
    expect(result.usage.tokensOut).toBe(900);
    expect(result.verification.passed).toBe(false);
  });

  it("allows an owned Codex child to complete below its token lease without double-counting detail fields", async () => {
    let killed = false;
    const adapter = createCodexCliAdapter({
      model: "gpt-6.1-sol",
      capabilityProfile: profile({
        binaryPath: "codex",
        sandbox: { flag: "--sandbox", scope: "exec", values: ["workspace-write"] },
        approvalPolicy: {
          flag: "--ask-for-approval",
          scope: "exec",
          semantics: "approval-policy",
          values: ["never"]
        },
        json: { flag: "--json", scope: "exec" },
        model: { flag: "--model", scope: "exec" },
        promptTransport: "stdin-dash"
      }),
      autonomyResolution: markCodexAutonomyResolutionVerifiedByLaunchProbe({
        binaryPath: "codex",
        intent: "governed-autonomous",
        strategy: "sandbox+approval",
        sandboxValue: "workspace-write",
        approvalValue: "never"
      }),
      spawnImpl: createStreamingCodexSpawn([
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "completed inside the lease" }
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 1_300,
            cached_input_tokens: 500,
            output_tokens: 600,
            reasoning_output_tokens: 400
          }
        })
      ], () => { killed = true; })
    });

    const result = await adapter.execute({
      loopId: "loop-codex-token-lease-under",
      workspaceId: "workspace-codex-token-lease-under",
      attemptId: "attempt-codex-token-lease-under",
      context: {
        taskTitle: "bounded child",
        objective: "complete inside the child token lease",
        verificationPlan: [],
        focus: "bounded execution",
        remainingBudgetUsd: 100,
        remainingIterations: 1,
        remainingTokens: 2_000
      },
      previousAttempts: []
    });

    expect(killed).toBe(false);
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("completed inside the lease");
    expect(result.usage).toMatchObject({
      tokensIn: 1_300,
      cachedInputTokens: 500,
      tokensOut: 600,
      reasoningTokensOut: 400
    });
  });
});

describe("resolveCodexAutonomyCandidates", () => {
  it("prefers least-privileged workspace-write before automation fallback", () => {
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
      "sandbox+approval",
      "automation"
    ]);
    expect(candidates[0]).toEqual(expect.objectContaining({
      strategy: "sandbox+approval",
      sandboxValue: "workspace-write",
      approvalValue: "never"
    }));
    expect(candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ approvalValue: "on-request" })
    ]));
    expect(candidates.flatMap((candidate) => Object.values(candidate))).not.toContain("danger-full-access");
  });

  it("allows an advertised workspace-write sandbox without requiring automation", () => {
    expect(resolveCodexAutonomyCandidates(profile({
      sandbox: { flag: "--sandbox", scope: "exec", values: ["workspace-write"] }
    }))).toEqual([
      expect.objectContaining({
        strategy: "sandbox+approval",
        sandboxValue: "workspace-write"
      })
    ]);
  });

  it.each([
    profile(),
    profile({
      approvalPolicy: {
        flag: "--ask-for-approval",
        scope: "exec",
        semantics: "approval-policy",
        values: ["never"]
      }
    }),
    profile({ sandbox: { flag: "--sandbox", scope: "exec", values: ["danger-full-access"] } })
  ])("does not downgrade to default, approval-only, or danger", (detected) => {
    expect(resolveCodexAutonomyCandidates(detected)).toEqual([]);
  });
});

describe("probeCodexLaunch", () => {
  it("respects PATH candidate order before desktop fallbacks on Windows", () => {
    clearCodexCapabilityCacheForTests();
    const workingDirectory = process.cwd();
    const candidateRoot = mkdtempSync(join(tmpdir(), "martin-codex-candidates-"));
    const pathCodex = join(candidateRoot, "AppData", "Roaming", "npm", "codex");
    const desktopCodex = join(candidateRoot, "desktop", "codex.exe");
    mkdirSync(dirname(pathCodex), { recursive: true });
    mkdirSync(dirname(desktopCodex), { recursive: true });
    writeFileSync(pathCodex, "", "utf8");
    writeFileSync(desktopCodex, "", "utf8");
    const observedCommands: string[] = [];
    const spawnSyncImpl = vi.fn((command: string, args: string[]) => {
      observedCommands.push(command);
      if (args.length === 1 && args[0] === "--help") {
        return { status: 0, stdout: "Usage: codex [COMMAND]", stderr: "" };
      }
      if (args[0] === "exec" && args[1] === "--help") {
        return {
          status: 0,
          stdout: [
            "Usage: codex exec [OPTIONS] [PROMPT]",
            "--sandbox <MODE> [possible values: read-only, workspace-write]",
            "--ask-for-approval <POLICY> [possible values: on-request, never]",
            "--cd <DIR>",
            "Read prompt from stdin when '-' is supplied."
          ].join("\n"),
          stderr: ""
        };
      }
      const markerPath = args.at(-2);
      if (markerPath) writeFileSync(markerPath, "MARTIN_CODEX_WRITE_OK", "utf8");
      return { status: 0, stdout: "READY\n", stderr: "" };
    });

    try {
      const result = probeCodexLaunch({
        workingDirectory,
        platform: "win32",
        env: {},
        availability: {
          command: "codex",
          available: true,
          locator: "where.exe",
          detail: "test",
          resolvedPath: pathCodex,
          candidatePaths: [pathCodex, desktopCodex]
        },
        spawnSyncImpl: spawnSyncImpl as never
      });

      expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
      expect(result.command).toBe(pathCodex);
      expect(observedCommands).not.toContain(desktopCodex);
    } finally {
      rmSync(candidateRoot, { recursive: true, force: true });
    }
  });

  it("proves workspace-write and outside-deny with the local Codex sandbox without provider execution", () => {
    clearCodexCapabilityCacheForTests();
    const workingDirectory = process.cwd();
    let simulateOutsideEscape = false;
    let observedTimeout: number | undefined;
    let observedOutsideMarker: string | undefined;
    let providerExecCalls = 0;
    let sandboxCalls = 0;
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

      if (args[0] === "exec") {
        providerExecCalls += 1;
        throw new Error("readiness must not invoke codex exec");
      }

      expect(args[0]).toBe("sandbox");
      sandboxCalls += 1;
      observedTimeout = options?.timeout;
      const markerPath = args.at(-2);
      const outsideMarker = args.at(-1);
      observedOutsideMarker = outsideMarker;
      if (simulateOutsideEscape && outsideMarker) {
        writeFileSync(outsideMarker, "MARTIN_CODEX_OUTSIDE_BAD", "utf8");
      }
      if (markerPath) {
        writeFileSync(markerPath, "MARTIN_CODEX_WRITE_OK", "utf8");
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
    expect(result.args.slice(0, 6)).toEqual([
      "sandbox",
      "--permission-profile",
      ":workspace",
      "-C",
      workingDirectory,
      "--"
    ]);
    expect(result.args).not.toContain("exec");
    expect(result.summary).toContain("local sandbox probe passed");
    expect(providerExecCalls).toBe(0);
    expect(sandboxCalls).toBe(1);
    expect(observedTimeout).toBe(300_000);
    expect(observedOutsideMarker).toBeDefined();
    expect(dirname(dirname(resolve(observedOutsideMarker!)))).toBe(resolve(userInfo().homedir));
    expect(resolve(observedOutsideMarker!)).not.toContain(resolve(tmpdir()));
    expect(resolve(observedOutsideMarker!)).not.toContain(resolve(workingDirectory));
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
    expect(providerExecCalls).toBe(0);
    expect(sandboxCalls).toBe(2);
    expect(observedTimeout).toBe(300_000);
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

function createStreamingCodexSpawn(lines: string[], onKill: () => void): SpawnLike {
  return (_command, _args = [], _options) => {
    const child = new EventEmitter() as Partial<ChildProcess> & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    let killed = false;
    let closed = false;
    const close = (code: number) => {
      if (closed) return;
      closed = true;
      child.emit("close", code);
    };
    child.kill = () => {
      if (!killed) {
        killed = true;
        onKill();
        child.stdout.end();
        child.stderr.end();
        setImmediate(() => close(143));
      }
      return true;
    };

    void (async () => {
      for (const line of lines) {
        if (killed) return;
        child.stdout.write(`${line}\n`);
        await new Promise((resolveLine) => setImmediate(resolveLine));
      }
      if (!killed) {
        child.stdout.end();
        child.stderr.end();
        close(0);
      }
    })();

    return child as ChildProcess;
  };
}
