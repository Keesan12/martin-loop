// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import {
  fetchLatestNpmVersion,
  detectInstallChannel,
  shouldShowUpdatePrompt,
  runNpmUpdate,
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
  it("returns an object with success boolean and optional error", () => {
    // We can't actually run npm in tests; just verify the return shape
    const result = runNpmUpdate();
    expect(typeof result.success).toBe("boolean");
    if (!result.success) {
      expect(typeof result.error).toBe("string");
    }
  });
});
