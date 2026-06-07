import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  diagnoseCodexHost,
  probeCodexLaunch,
  resolveCliCommandAvailability
} from "../src/codex-launcher.js";

describe("resolveCliCommandAvailability", () => {
  it("captures the resolved path when the locator succeeds", () => {
    const availability = resolveCliCommandAvailability("codex", {
      platform: "win32",
      spawnSyncImpl: vi.fn(() => ({
        status: 0,
        stdout: "C:\\Users\\ExampleUser\\AppData\\Roaming\\npm\\codex.cmd\r\n",
        stderr: ""
      })) as never
    });

    expect(availability.available).toBe(true);
    expect(availability.resolvedPath).toContain("codex.cmd");
    expect(availability.locator).toBe("where.exe");
  });

  it("prefers a Windows command shim over the bare npm shim", () => {
    const availability = resolveCliCommandAvailability("codex", {
      platform: "win32",
      spawnSyncImpl: vi.fn(() => ({
        status: 0,
        stdout: [
          "C:\\Users\\ExampleUser\\AppData\\Roaming\\npm\\codex",
          "C:\\Users\\ExampleUser\\AppData\\Roaming\\npm\\codex.cmd",
          "C:\\Program Files\\OpenAI\\Codex\\codex.exe",
          ""
        ].join("\r\n"),
        stderr: ""
      })) as never
    });

    expect(availability.available).toBe(true);
    expect(availability.resolvedPath).toBe("C:\\Users\\ExampleUser\\AppData\\Roaming\\npm\\codex.cmd");
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
    expect(diagnosis.nativeInstallValid).toBe(false);
    expect(diagnosis.remediation).toContain("Install Codex natively");
  });
});

describe("probeCodexLaunch", () => {
  it("probes the exact MartinLoop Codex exec shape without spending tokens", () => {
    const spawnSyncImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: "/usr/local/bin/codex\n",
        stderr: ""
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "usage: codex exec ...\n",
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
      "--cd",
      process.cwd(),
      "--sandbox",
      "workspace-write",
      "--json",
      "--color",
      "never",
      "--help"
    ]);
    expect(spawnSyncImpl).toHaveBeenNthCalledWith(
      2,
      "/usr/local/bin/codex",
      result.args,
      expect.objectContaining({
        cwd: process.cwd(),
        encoding: "utf8"
      })
    );
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
          resolvedPath: "C:\\Users\\ExampleUser\\AppData\\Roaming\\npm\\codex.cmd"
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

  it("wraps Windows cmd launch probes through cmd.exe", () => {
    const spawnSyncImpl = vi.fn(() => ({
      status: 0,
      stdout: "usage: codex exec ...\r\n",
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
        resolvedPath: "C:\\Users\\ExampleUser\\AppData\\Roaming\\npm\\codex.cmd"
      },
      spawnSyncImpl: spawnSyncImpl as never
    });

    expect(result.ok).toBe(true);
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      expect.stringMatching(/cmd(.exe)?$/i),
      expect.arrayContaining(["/d", "/c", expect.stringContaining("codex.cmd"), "exec"]),
      expect.objectContaining({
        cwd: process.cwd(),
        encoding: "utf8"
      })
    );
  });
});
