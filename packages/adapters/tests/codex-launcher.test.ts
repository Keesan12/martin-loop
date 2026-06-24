import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CODEX_CHATGPT_MODEL,
  buildCodexExecArgs,
  diagnoseCodexHost,
  probeCodexLaunch,
  resolveCliCommandAvailability
} from "../src/codex-launcher.js";

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

    expect(availability.available).toBe(true);
    expect(availability.resolvedPath).toBe("C:\\Tools\\npm\\codex");
    expect(availability.candidatePaths).toEqual([
      "C:\\Tools\\npm\\codex",
      "C:\\Tools\\npm\\codex.cmd",
      "C:\\Program Files\\OpenAI\\Codex\\codex.exe"
    ]);
  });

  it("preserves where.exe order when equally ordered Windows candidates match", () => {
    const availability = resolveCliCommandAvailability("codex", {
      platform: "win32",
      env: {},
      spawnSyncImpl: vi.fn(() => ({
        status: 0,
        stdout: [
          "C:\\Zeta Tools\\codex.cmd",
          "C:\\Alpha Tools\\codex.cmd",
          ""
        ].join("\r\n"),
        stderr: ""
      })) as never
    });

    expect(availability.available).toBe(true);
    expect(availability.resolvedPath).toBe("C:\\Zeta Tools\\codex.cmd");
    expect(availability.candidatePaths).toEqual([
      "C:\\Zeta Tools\\codex.cmd",
      "C:\\Alpha Tools\\codex.cmd"
    ]);
  });
});

describe("diagnoseCodexHost", () => {
  it("rejects Windows PATH shims from WSL/Linux", () => {
    const diagnosis = diagnoseCodexHost(
      {
        command: "codex",
        available: true,
        locator: "which",
        detail: "codex is available on PATH.",
        resolvedPath: "/mnt/c/Users/ExampleUser/AppData/Roaming/npm/codex.cmd"
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
    expect(diagnosis.remediation).toContain("Install Codex natively");
  });
});

describe("buildCodexExecArgs", () => {
  it("builds the same exec contract used for real runs and launch probes", () => {
    expect(
      buildCodexExecArgs({
        workingDirectory: "/repo/worktree",
        sandbox: "workspace-write",
        model: "gpt-5-codex",
        extraArgs: ["--profile", "ci"],
        mode: "prompt"
      })
    ).toEqual([
      "exec",
      "--ignore-user-config",
      "--cd",
      "/repo/worktree",
      "--sandbox",
      "workspace-write",
      "--json",
      "--color",
      "never",
      "--model",
      "gpt-5-codex",
      "--profile",
      "ci",
      "-"
    ]);
  });
});

describe("probeCodexLaunch", () => {
  it("probes the exact MartinLoop Codex exec shape with a no-edit shell command", () => {
    const spawnSyncImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: "/usr/local/bin/codex\n",
        stderr: ""
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: [
          JSON.stringify({
            type: "item.completed",
            item: {
              id: "item_1",
              type: "command_execution",
              command: "git status --short -- .",
              aggregated_output: "",
              exit_code: 0,
              status: "completed"
            }
          }),
          JSON.stringify({
            type: "item.completed",
            item: {
              id: "item_2",
              type: "agent_message",
              text: "READY"
            }
          })
        ].join("\n"),
        stderr: ""
      });

    const result = probeCodexLaunch({
      workingDirectory: process.cwd(),
      platform: "linux",
      env: {},
      spawnSyncImpl: spawnSyncImpl as never
    });

    expect(result.ok).toBe(true);
    expect(result.args).toEqual([
      "exec",
      "--ignore-user-config",
      "--cd",
      process.cwd(),
      "--sandbox",
      "workspace-write",
      "--json",
      "--color",
      "never",
      "--model",
      DEFAULT_CODEX_CHATGPT_MODEL,
      "-"
    ]);
    expect(spawnSyncImpl).toHaveBeenNthCalledWith(
      2,
      "/usr/local/bin/codex",
      result.args,
      expect.objectContaining({
        cwd: process.cwd(),
        encoding: "utf8",
        input: expect.stringContaining("git status --short -- .")
      })
    );
    expect(result.summary).toContain("prompt-and-shell probe passed");
  });

  it("fails closed when Codex resolves to a Windows shim in WSL", () => {
    const spawnSyncImpl = vi.fn(() => ({
      status: 0,
      stdout: "/mnt/c/Users/ExampleUser/AppData/Roaming/npm/codex.cmd\n",
      stderr: ""
    }));

    const result = probeCodexLaunch({
      workingDirectory: process.cwd(),
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      spawnSyncImpl: spawnSyncImpl as never
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("Install Codex natively");
    expect(spawnSyncImpl).toHaveBeenCalledTimes(1);
  });

  it("prefers native Windows runtime candidates ahead of shims", () => {
    const spawnSyncImpl = vi.fn((command: string) => {
      if (/cmd(.exe)?$/iu.test(command)) {
        return {
          status: 0,
          stdout: [
            JSON.stringify({
              type: "item.completed",
              item: {
                id: "item_1",
                type: "command_execution",
                command: "\"pwsh.exe\" -NoProfile -Command 'git status --short -- .'",
                aggregated_output:
                  "execution error: Io(Custom { kind: Other, error: \"windows sandbox: runner error: CreateProcessAsUserW failed: 5\" })",
                exit_code: -1,
                status: "failed"
              }
            })
          ].join("\n"),
          stderr: ""
        };
      }

      return {
        status: 0,
        stdout: JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_1",
            type: "command_execution",
            command: "git status --short -- .",
            aggregated_output: "",
            exit_code: 0,
            status: "completed"
          }
        }),
        stderr: ""
      };
    });

    const result = probeCodexLaunch({
      workingDirectory: process.cwd(),
      platform: "win32",
      availability: {
        command: "codex",
        available: true,
        locator: "where.exe",
        detail: "codex is available on PATH.",
        resolvedPath: "C:\\Tools\\npm\\codex.cmd",
        candidatePaths: [
          "C:\\Tools\\npm\\codex.cmd",
          "C:\\Users\\ExampleUser\\AppData\\Local\\OpenAI\\Codex\\bin\\abcd1234\\codex.exe"
        ]
      },
      spawnSyncImpl: spawnSyncImpl as never
    });

    expect(result.ok).toBe(true);
    expect(result.command).toBe(
      "C:\\Users\\ExampleUser\\AppData\\Local\\OpenAI\\Codex\\bin\\abcd1234\\codex.exe"
    );
    expect(result.availability.resolvedPath).toBe(
      "C:\\Users\\ExampleUser\\AppData\\Local\\OpenAI\\Codex\\bin\\abcd1234\\codex.exe"
    );
    expect(result.candidateProbeResults).toEqual([
      expect.objectContaining({
        path: "C:\\Users\\ExampleUser\\AppData\\Local\\OpenAI\\Codex\\bin\\abcd1234\\codex.exe",
        launchReady: true,
        installKind: "native"
      })
    ]);
  });

  it("fails closed when the working directory is not inside a git repository", () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "martin-codex-nongit-"));

    try {
      const spawnSyncImpl = vi.fn();
      const result = probeCodexLaunch({
        workingDirectory,
        platform: "win32",
        env: {},
        availability: {
          command: "codex",
          available: true,
          locator: "where.exe",
          detail: "codex is available on PATH.",
          resolvedPath: "C:\\Tools\\npm\\codex.cmd"
        },
        spawnSyncImpl: spawnSyncImpl as never
      });

      expect(result.ok).toBe(false);
      expect(result.summary).toContain("not inside a git repository");
      expect(spawnSyncImpl).not.toHaveBeenCalled();
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

  it("surfaces non-zero launch probe exits", () => {
    const spawnSyncImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: "/usr/local/bin/codex\n",
        stderr: ""
      })
      .mockReturnValueOnce({
        status: 2,
        stdout: "",
        stderr: "unexpected argument '--json'\n"
      });

    const result = probeCodexLaunch({
      workingDirectory: process.cwd(),
      platform: "linux",
      env: {},
      spawnSyncImpl: spawnSyncImpl as never
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("unexpected argument '--json'");
    expect(result.exitCode).toBe(2);
  });

  it("classifies unsupported ChatGPT-account Codex models before governed work starts", () => {
    const spawnSyncImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: "/usr/local/bin/codex\n",
        stderr: ""
      })
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr:
          "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.\n"
      });

    const result = probeCodexLaunch({
      workingDirectory: process.cwd(),
      platform: "linux",
      env: {},
      model: "gpt-5.3-codex",
      spawnSyncImpl: spawnSyncImpl as never
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("ChatGPT-account");
    expect(result.summary).toContain(DEFAULT_CODEX_CHATGPT_MODEL);
    expect(result.diagnosis.remediation).toContain(DEFAULT_CODEX_CHATGPT_MODEL);
  });

  it("classifies read-only Codex sandbox mismatches before governed work continues", () => {
    const spawnSyncImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: "/usr/local/bin/codex\n",
        stderr: ""
      })
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr:
          "patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings\n"
      });

    const result = probeCodexLaunch({
      workingDirectory: process.cwd(),
      platform: "linux",
      env: {},
      spawnSyncImpl: spawnSyncImpl as never
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("read-only");
    expect(result.diagnosis.remediation).toContain("--ignore-user-config --sandbox workspace-write");
  });

  it("wraps Windows cmd launch probes through cmd.exe", () => {
    const spawnSyncImpl = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "git status --short -- .",
          aggregated_output: "",
          exit_code: 0,
          status: "completed"
        }
      }),
      stderr: ""
    }));

    const result = probeCodexLaunch({
      workingDirectory: process.cwd(),
      platform: "win32",
      availability: {
        command: "codex",
        available: true,
        locator: "where.exe",
        detail: "codex is available on PATH.",
          resolvedPath: "C:\\Tools\\npm\\codex.cmd"
      },
      spawnSyncImpl: spawnSyncImpl as never
    });

    expect(result.ok).toBe(true);
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      expect.stringMatching(/cmd(.exe)?$/i),
      expect.arrayContaining(["/d", "/c", "C:\\Tools\\npm\\codex.cmd", "exec"]),
      expect.objectContaining({
        cwd: process.cwd(),
        encoding: "utf8"
      })
    );
    expect(result.diagnosis.invocationMode).toBe("cmd_shell");
  });

  it("fails closed when Codex prompt execution cannot launch shell commands on Windows", () => {
    const spawnSyncImpl = vi.fn(() => ({
      status: 0,
      stdout: [
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_1",
            type: "command_execution",
            command: "\"pwsh.exe\" -NoProfile -Command 'git status --short -- .'",
            aggregated_output:
              "execution error: Io(Custom { kind: Other, error: \"windows sandbox: runner error: CreateProcessAsUserW failed: 5\" })",
            exit_code: -1,
            status: "failed"
          }
        }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_2",
            type: "agent_message",
            text: "Shell execution failed."
          }
        })
      ].join("\n"),
      stderr: ""
    }));

    const result = probeCodexLaunch({
      workingDirectory: process.cwd(),
      platform: "win32",
      availability: {
        command: "codex",
        available: true,
        locator: "where.exe",
        detail: "codex is available on PATH.",
        resolvedPath: "C:\\Tools\\npm\\codex.cmd"
      },
      spawnSyncImpl: spawnSyncImpl as never
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("workspace-write sandbox");
    expect(result.diagnosis.sandboxCompatible).toBe(false);
    expect(result.diagnosis.remediation).toContain("workspace-write");
  });

  it("classifies missing Linux native Codex dependencies before governed work starts", () => {
    const spawnSyncImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: "/usr/local/bin/codex\n",
        stderr: ""
      })
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: "Error: Cannot find module '@openai/codex-linux-x64'\n"
      });

    const result = probeCodexLaunch({
      workingDirectory: process.cwd(),
      platform: "linux",
      env: {},
      spawnSyncImpl: spawnSyncImpl as never
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("@openai/codex-linux-x64");
    expect(result.diagnosis.nativeInstallValid).toBe(false);
    expect(result.diagnosis.nativeDependencyStatus).toBe("missing");
    expect(result.diagnosis.nativeDependencyPackage).toBe("@openai/codex-linux-x64");
    expect(result.diagnosis.remediation).toContain("Reinstall Codex natively");
  });
});
