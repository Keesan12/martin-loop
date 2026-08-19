// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoist spawnSync mock so factory can reference it ────────────────────────
// vi.mock is hoisted by vitest; vi.hoisted() ensures the reference is ready.
const mockSpawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: mockSpawnSync }));
import {
  fetchLatestNpmVersion,
  detectInstallChannel,
  shouldShowUpdatePrompt,
  runNpmUpdate,
  classifyUpdateKey,
  buildNpmUpdateCommand,
  maybeShowUpdatePrompt,
  type InstallChannel,
  type UpdatePromptInput,
} from "../src/update-prompt.js";

// ─── semver / fetchLatestNpmVersion ──────────────────────────────────────────

describe("fetchLatestNpmVersion", () => {
  it("returns version string on 200 response", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ version: "1.2.3" }), { status: 200 });
    expect(await fetchLatestNpmVersion(fetchImpl)).toBe("1.2.3");
  });

  it("returns null on non-ok response", async () => {
    const fetchImpl = async () => new Response("err", { status: 500 });
    expect(await fetchLatestNpmVersion(fetchImpl)).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const fetchImpl = async (): Promise<Response> => { throw new Error("network"); };
    expect(await fetchLatestNpmVersion(fetchImpl)).toBeNull();
  });

  it("returns null when version field is missing", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ other: "data" }), { status: 200 });
    expect(await fetchLatestNpmVersion(fetchImpl)).toBeNull();
  });

  it("returns null on timeout (AbortError)", async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    expect(await fetchLatestNpmVersion(fetchImpl, 1)).toBeNull();
  });
});

// ─── detectInstallChannel ────────────────────────────────────────────────────

describe("detectInstallChannel", () => {
  it("returns global-npm when npm_config_global is true", () => {
    expect(detectInstallChannel({ npm_config_global: "true" })).toBe("global-npm");
  });

  it("returns npx when npm_execpath includes npx", () => {
    expect(detectInstallChannel({ npm_execpath: "/usr/lib/node_modules/npm/bin/npx-cli.js" })).toBe("npx");
  });

  it("returns npx when npm_command is exec", () => {
    expect(detectInstallChannel({ npm_command: "exec" })).toBe("npx");
  });

  it("returns source when npm_lifecycle_event is set without global", () => {
    expect(detectInstallChannel({ npm_lifecycle_event: "start" })).toBe("source");
  });

  it("returns unknown for empty env", () => {
    expect(detectInstallChannel({})).toBe("unknown");
  });
});

// ─── shouldShowUpdatePrompt ───────────────────────────────────────────────────

function baseInput(overrides: Partial<UpdatePromptInput> = {}): UpdatePromptInput {
  return {
    currentVersion: "0.4.5",
    interactiveTty: true,
    outputMode: "human",
    ci: false,
    command: "run",
    channel: "global-npm",
    ...overrides,
  };
}

describe("shouldShowUpdatePrompt", () => {
  it("returns true for eligible global-npm interactive human run", () => {
    expect(shouldShowUpdatePrompt(baseInput())).toBe(true);
  });

  it("returns false for non-global-npm channel", () => {
    expect(shouldShowUpdatePrompt(baseInput({ channel: "npx" }))).toBe(false);
    expect(shouldShowUpdatePrompt(baseInput({ channel: "source" }))).toBe(false);
    expect(shouldShowUpdatePrompt(baseInput({ channel: "unknown" }))).toBe(false);
    expect(shouldShowUpdatePrompt(baseInput({ channel: "native" }))).toBe(false);
  });

  it("returns false when not interactive TTY", () => {
    expect(shouldShowUpdatePrompt(baseInput({ interactiveTty: false }))).toBe(false);
  });

  it("returns false in CI", () => {
    expect(shouldShowUpdatePrompt(baseInput({ ci: true }))).toBe(false);
  });

  it("returns false for non-human output modes", () => {
    expect(shouldShowUpdatePrompt(baseInput({ outputMode: "json" }))).toBe(false);
    expect(shouldShowUpdatePrompt(baseInput({ outputMode: "quiet" }))).toBe(false);
    expect(shouldShowUpdatePrompt(baseInput({ outputMode: "mcp" }))).toBe(false);
  });

  it("suppresses for meta-commands", () => {
    expect(shouldShowUpdatePrompt(baseInput({ command: "help" }))).toBe(false);
    expect(shouldShowUpdatePrompt(baseInput({ command: "version" }))).toBe(false);
    expect(shouldShowUpdatePrompt(baseInput({ command: "telemetry" }))).toBe(false);
    expect(shouldShowUpdatePrompt(baseInput({ command: "update" }))).toBe(false);
  });
});

// ─── maybeShowUpdatePrompt ────────────────────────────────────────────────────

describe("maybeShowUpdatePrompt", () => {
  it("returns false when channel is not global-npm", async () => {
    // detectInstallChannel returns 'unknown' in test env (no npm env vars)
    const result = await maybeShowUpdatePrompt("0.4.5", async () => new Response(JSON.stringify({ version: "99.0.0" }), { status: 200 }));
    // In test env channel is unknown → false
    expect(result).toBe(false);
  });

  it("returns false when latest version is not newer", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ version: "0.4.5" }), { status: 200 });
    const result = await maybeShowUpdatePrompt("0.4.5", fetchImpl);
    expect(result).toBe(false);
  });

  it("returns false when registry fetch fails", async () => {
    const fetchImpl = async (): Promise<Response> => { throw new Error("network"); };
    const result = await maybeShowUpdatePrompt("0.4.5", fetchImpl);
    expect(result).toBe(false);
  });

  it("returns false when latest is older than current", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ version: "0.1.0" }), { status: 200 });
    const result = await maybeShowUpdatePrompt("0.4.5", fetchImpl);
    expect(result).toBe(false);
  });
});

// ─── runNpmUpdate ─────────────────────────────────────────────────────────────

describe("runNpmUpdate", () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  it("returns { success: true } when spawnSync exits 0", () => {
    mockSpawnSync.mockReturnValue({ status: 0, error: undefined });
    expect(runNpmUpdate()).toEqual({ success: true });
  });

  it("returns { success: false } with exit-code message when spawnSync exits non-zero", () => {
    mockSpawnSync.mockReturnValue({ status: 1, error: undefined });
    const result = runNpmUpdate();
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error).toContain("1");
  });

  it("includes error.message when spawnSync sets an error object", () => {
    mockSpawnSync.mockReturnValue({ status: null, error: new Error("ENOENT") });
    const result = runNpmUpdate();
    expect(result.success).toBe(false);
    expect(result.error).toBe("ENOENT");
  });
});

// ─── classifyUpdateKey ────────────────────────────────────────────────────────

describe("classifyUpdateKey", () => {
  it("maps Y and y to 'y'", () => {
    expect(classifyUpdateKey("y")).toBe("y");
    expect(classifyUpdateKey("Y")).toBe("y");
  });

  it("maps L and l to 'l'", () => {
    expect(classifyUpdateKey("l")).toBe("l");
    expect(classifyUpdateKey("L")).toBe("l");
  });

  it("maps Enter (\\r) to 'l'", () => {
    expect(classifyUpdateKey("\r")).toBe("l");
  });

  it("maps newline (\\n) to 'l'", () => {
    expect(classifyUpdateKey("\n")).toBe("l");
  });

  it("maps Ctrl+C (\\u0003) to 'l' — must not call process.exit", () => {
    // Regression test: before this fix, Ctrl+C called process.exit(0)
    // which killed the governed process. It must now resolve to 'l'.
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called — regression!");
    });
    try {
      expect(classifyUpdateKey("\u0003")).toBe("l");
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("maps any other key to 'l'", () => {
    expect(classifyUpdateKey("n")).toBe("l");
    expect(classifyUpdateKey("q")).toBe("l");
    expect(classifyUpdateKey(" ")).toBe("l");
    expect(classifyUpdateKey("\u001b")).toBe("l");
  });
});

// ─── buildNpmUpdateCommand ────────────────────────────────────────────────────

describe("buildNpmUpdateCommand", () => {
  it("returns npm on non-windows", () => {
    if (process.platform === "win32") return; // skip on actual win32
    const [cmd, args] = buildNpmUpdateCommand({});
    expect(cmd).toBe("npm");
    expect(args).toContain("install");
    expect(args).toContain("--global");
  });

  it("uses ComSpec on win32", () => {
    const [cmd, args] = buildNpmUpdateCommand({ ComSpec: "C:\\Windows\\System32\\cmd.exe" });
    // On any platform this pure function returns the win32 path when called
    // with a win32 process.platform. We test the env-arg branch separately.
    // The key contract: env["ComSpec"] is used, not npm.cmd.
    if (process.platform === "win32") {
      expect(cmd).toBe("C:\\Windows\\System32\\cmd.exe");
      expect(args[0]).toBe("/d");
      expect(args[1]).toBe("/s");
      expect(args[2]).toBe("/c");
      expect(args[3]).toContain("npm install");
    }
  });

  it("falls back to cmd.exe when ComSpec is absent on win32", () => {
    if (process.platform !== "win32") return;
    const [cmd] = buildNpmUpdateCommand({});
    expect(cmd).toBe("cmd.exe");
  });

  it("never uses npm.cmd", () => {
    const [cmd] = buildNpmUpdateCommand(process.env);
    expect(cmd).not.toBe("npm.cmd");
  });
});
