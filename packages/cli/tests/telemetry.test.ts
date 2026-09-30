// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  shouldShowTelemetryNotice,
  isTelemetrySendingEnabled,
  telemetryEnvironmentDisabled,
  assertAllowedTelemetryPayload,
  toTelemetryFailureReason,
  sendProductEvent,
  renderTelemetryNotice,
  readTelemetryConfig,
  DEFAULT_TELEMETRY_CONFIG,
  type TelemetryConfigV1,
} from "../src/telemetry.js";

// Helper for a fully-enabled config (explicit preference, notice shown).
function enabledConfig(overrides: Partial<TelemetryConfigV1> = {}): TelemetryConfigV1 {
  return {
    schemaVersion: 1,
    enabled: true,
    noticeShown: true,
    installId: "test-install-id",
    initializedEventSent: true,
    userChoseExplicitly: true,
    ...overrides,
  };
}

// ─── fresh-install defaults ───────────────────────────────────────────────────

describe("DEFAULT_TELEMETRY_CONFIG", () => {
  it("has telemetry enabled by default (opt-out model)", () => {
    expect(DEFAULT_TELEMETRY_CONFIG.enabled).toBe(true);
  });

  it("has noticeShown false on fresh install", () => {
    expect(DEFAULT_TELEMETRY_CONFIG.noticeShown).toBe(false);
  });

  it("has userChoseExplicitly false on fresh install", () => {
    expect(DEFAULT_TELEMETRY_CONFIG.userChoseExplicitly).toBe(false);
  });

  it("does NOT send before disclosure (noticeShown=false, userChoseExplicitly=false)", () => {
    expect(isTelemetrySendingEnabled(DEFAULT_TELEMETRY_CONFIG, {})).toBe(false);
  });

  it("sends after disclosure is shown (noticeShown=true, enabled=true)", () => {
    const afterDisclosure: TelemetryConfigV1 = {
      ...DEFAULT_TELEMETRY_CONFIG,
      noticeShown: true,
      installId: "inst-123",
    };
    expect(isTelemetrySendingEnabled(afterDisclosure, {})).toBe(true);
  });

  it("does not send when enabled=false even after disclosure", () => {
    const explicitOff: TelemetryConfigV1 = {
      ...DEFAULT_TELEMETRY_CONFIG,
      enabled: false,
      noticeShown: true,
      userChoseExplicitly: true,
    };
    expect(isTelemetrySendingEnabled(explicitOff, {})).toBe(false);
  });
});

// ─── legacy config migration ──────────────────────────────────────────────────
// All tests here write a real legacy file to a temporary Martin home and call
// the real readTelemetryConfig() to exercise the actual migration code path.

describe("legacy config migration", () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(async () => {
    originalHome = process.env["HOME"];
    originalUserProfile = process.env["USERPROFILE"];
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "martin-legacy-test-"));
    process.env["HOME"] = tempHome;
    process.env["USERPROFILE"] = tempHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (originalUserProfile === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = originalUserProfile;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  async function writeLegacyConfig(cfg: object): Promise<void> {
    const dir = path.join(tempHome, ".martin");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "telemetry.json"), `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  }

  it("A: legacy explicit OFF — readTelemetryConfig migrates userChoseExplicitly=true, blocks sending", async () => {
    await writeLegacyConfig({
      schemaVersion: 1,
      enabled: false,
      noticeShown: true,
      installId: "legacy-off",
      initializedEventSent: true,
      // No userChoseExplicitly field — simulates pre-PR legacy file
    });
    const config = await readTelemetryConfig();
    expect(config.enabled).toBe(false);
    expect(config.userChoseExplicitly).toBe(true);
    expect(isTelemetrySendingEnabled(config, {})).toBe(false);
  });

  it("B: legacy explicit ON — readTelemetryConfig migrates userChoseExplicitly=true, allows sending", async () => {
    await writeLegacyConfig({
      schemaVersion: 1,
      enabled: true,
      noticeShown: true,
      installId: "legacy-on",
      initializedEventSent: true,
      // No userChoseExplicitly field — simulates pre-PR legacy file
    });
    const config = await readTelemetryConfig();
    expect(config.enabled).toBe(true);
    expect(config.userChoseExplicitly).toBe(true);
    expect(isTelemetrySendingEnabled(config, {})).toBe(true);
  });

  it("C: current-schema userChoseExplicitly=false is preserved (not reclassified as legacy)", async () => {
    await writeLegacyConfig({
      schemaVersion: 1,
      enabled: true,
      noticeShown: false,
      installId: null,
      initializedEventSent: false,
      userChoseExplicitly: false, // Explicit false — new install default
    });
    const config = await readTelemetryConfig();
    expect(config.userChoseExplicitly).toBe(false);
    expect(isTelemetrySendingEnabled(config, {})).toBe(false); // No disclosure yet
  });

  it("D: absent or malformed config returns opt-out default safely, no sending", async () => {
    // No file written — readTelemetryConfig must return DEFAULT_TELEMETRY_CONFIG
    const config = await readTelemetryConfig();
    expect(config).toEqual(DEFAULT_TELEMETRY_CONFIG);
    expect(isTelemetrySendingEnabled(config, {})).toBe(false);
  });
});

// ─── shouldShowTelemetryNotice ────────────────────────────────────────────────

describe("shouldShowTelemetryNotice", () => {
  it("shows when noticeShown=false, interactive TTY, human output", () => {
    expect(shouldShowTelemetryNotice({
      config: { ...DEFAULT_TELEMETRY_CONFIG, noticeShown: false },
      interactiveTty: true,
      humanOutput: true,
    })).toBe(true);
  });

  it("shows even when userChoseExplicitly=false (opt-out default still discloses)", () => {
    expect(shouldShowTelemetryNotice({
      config: { ...DEFAULT_TELEMETRY_CONFIG, enabled: true, noticeShown: false, userChoseExplicitly: false },
      interactiveTty: true,
      humanOutput: true,
    })).toBe(true);
  });

  it("hides when noticeShown is true", () => {
    expect(shouldShowTelemetryNotice({
      config: enabledConfig({ noticeShown: true }),
      interactiveTty: true,
      humanOutput: true,
    })).toBe(false);
  });

  it("hides when not interactive TTY", () => {
    expect(shouldShowTelemetryNotice({
      config: { ...DEFAULT_TELEMETRY_CONFIG, noticeShown: false },
      interactiveTty: false,
      humanOutput: true,
    })).toBe(false);
  });

  it("hides when output is not human", () => {
    expect(shouldShowTelemetryNotice({
      config: { ...DEFAULT_TELEMETRY_CONFIG, noticeShown: false },
      interactiveTty: true,
      humanOutput: false,
    })).toBe(false);
  });

  it("hides when CI env is set", () => {
    expect(shouldShowTelemetryNotice({
      config: { ...DEFAULT_TELEMETRY_CONFIG, noticeShown: false },
      interactiveTty: true,
      humanOutput: true,
      env: { CI: "true" },
    })).toBe(false);
  });

  it("hides when MARTIN_TELEMETRY_DISABLED is set", () => {
    expect(shouldShowTelemetryNotice({
      config: { ...DEFAULT_TELEMETRY_CONFIG, noticeShown: false },
      interactiveTty: true,
      humanOutput: true,
      env: { MARTIN_TELEMETRY_DISABLED: "1" },
    })).toBe(false);
  });

  it("hides when DO_NOT_TRACK is set", () => {
    expect(shouldShowTelemetryNotice({
      config: { ...DEFAULT_TELEMETRY_CONFIG, noticeShown: false },
      interactiveTty: true,
      humanOutput: true,
      env: { DO_NOT_TRACK: "1" },
    })).toBe(false);
  });
});

// ─── renderTelemetryNotice ────────────────────────────────────────────────────
// All tests here use a temporary Martin home so they never touch the
// developer's real ~/.martin/telemetry.json.

describe("renderTelemetryNotice", () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(async () => {
    originalHome = process.env["HOME"];
    originalUserProfile = process.env["USERPROFILE"];
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "martin-telemetry-test-"));
    process.env["HOME"] = tempHome;
    process.env["USERPROFILE"] = tempHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (originalUserProfile === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = originalUserProfile;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("sets noticeShown=true and persists to temp home — opt-out default config", async () => {
    const chunks: string[] = [];
    const mockOutput = { write: (s: string) => { chunks.push(s); return true; } } as unknown as NodeJS.WriteStream;
    const config: TelemetryConfigV1 = { ...DEFAULT_TELEMETRY_CONFIG }; // enabled=true, userChoseExplicitly=false

    const result = await renderTelemetryNotice(config, mockOutput);

    // Returned config is correct
    expect(result.noticeShown).toBe(true);
    expect(result.enabled).toBe(true);           // preserved
    expect(result.userChoseExplicitly).toBe(false); // preserved

    // Persisted file in temp home is correct (proves real persistence ran)
    const persisted = JSON.parse(
      await fs.readFile(path.join(tempHome, ".martin", "telemetry.json"), "utf8")
    ) as TelemetryConfigV1;
    expect(persisted.noticeShown).toBe(true);
    expect(persisted.enabled).toBe(true);
    expect(persisted.userChoseExplicitly).toBe(false);

    // Sending is now eligible (disclosure done, enabled=true)
    expect(isTelemetrySendingEnabled(result, {})).toBe(true);
  });

  it("preserves explicit OFF — notice must never re-enable telemetry", async () => {
    const mockOutput = { write: () => true } as unknown as NodeJS.WriteStream;
    const config: TelemetryConfigV1 = {
      schemaVersion: 1,
      enabled: false,
      noticeShown: false,
      installId: null,
      initializedEventSent: false,
      userChoseExplicitly: true,
    };

    const result = await renderTelemetryNotice(config, mockOutput);

    expect(result.enabled).toBe(false);          // must not be turned on
    expect(result.userChoseExplicitly).toBe(true); // preserved
    expect(result.noticeShown).toBe(true);

    const persisted = JSON.parse(
      await fs.readFile(path.join(tempHome, ".martin", "telemetry.json"), "utf8")
    ) as TelemetryConfigV1;
    expect(persisted.enabled).toBe(false);

    // Sending remains blocked
    expect(isTelemetrySendingEnabled(result, {})).toBe(false);
  });

  it("does not block — resolves without waiting for input", async () => {
    const mockOutput = { write: () => true } as unknown as NodeJS.WriteStream;
    const config: TelemetryConfigV1 = { ...DEFAULT_TELEMETRY_CONFIG };

    const raceResult = await Promise.race([
      renderTelemetryNotice(config, mockOutput),
      new Promise<null>((r) => setTimeout(() => r(null), 200)),
    ]);

    // If raceResult is null the promise didn't resolve in 200 ms — blocking
    expect(raceResult).not.toBeNull();
    expect((raceResult as TelemetryConfigV1).noticeShown).toBe(true);
  });

  it("prints disclosure text and no Y/N prompt", async () => {
    const chunks: string[] = [];
    const mockOutput = { write: (s: string) => { chunks.push(s); return true; } } as unknown as NodeJS.WriteStream;
    await renderTelemetryNotice({ ...DEFAULT_TELEMETRY_CONFIG }, mockOutput);
    const allOutput = chunks.join("");
    expect(allOutput).toContain("MartinLoop anonymous usage analytics");
    expect(allOutput).toContain("martin telemetry off");
    expect(allOutput).not.toContain("[Y/n]");
    expect(allOutput).not.toContain("Enable analytics?");
  });
});

// ─── isTelemetrySendingEnabled ────────────────────────────────────────────────

describe("isTelemetrySendingEnabled", () => {
  it("returns true when all conditions met (explicit on, notice shown)", () => {
    expect(isTelemetrySendingEnabled(enabledConfig(), {})).toBe(true);
  });

  it("returns false when enabled is false", () => {
    expect(isTelemetrySendingEnabled(enabledConfig({ enabled: false }), {})).toBe(false);
  });

  it("returns false when noticeShown=false and userChoseExplicitly=false (not yet disclosed)", () => {
    expect(isTelemetrySendingEnabled(
      { ...DEFAULT_TELEMETRY_CONFIG, enabled: true, noticeShown: false, userChoseExplicitly: false },
      {}
    )).toBe(false);
  });

  it("returns true when userChoseExplicitly=true even if noticeShown=false (explicit ON)", () => {
    expect(isTelemetrySendingEnabled(
      enabledConfig({ noticeShown: false, userChoseExplicitly: true }),
      {}
    )).toBe(true);
  });

  it("returns false on fresh install (default config)", () => {
    expect(isTelemetrySendingEnabled(DEFAULT_TELEMETRY_CONFIG, {})).toBe(false);
  });

  it("returns false when DO_NOT_TRACK is set", () => {
    expect(isTelemetrySendingEnabled(enabledConfig(), { DO_NOT_TRACK: "1" })).toBe(false);
  });

  it("returns false when MARTIN_TELEMETRY_DISABLED is set", () => {
    expect(isTelemetrySendingEnabled(enabledConfig(), { MARTIN_TELEMETRY_DISABLED: "true" })).toBe(false);
  });

  it("returns false when CI is set", () => {
    expect(isTelemetrySendingEnabled(enabledConfig(), { CI: "true" })).toBe(false);
  });

  it("returns false when MARTIN_TELEMETRY_DEBUG is set", () => {
    expect(isTelemetrySendingEnabled(enabledConfig(), { MARTIN_TELEMETRY_DEBUG: "1" })).toBe(false);
  });

  it("disable immediately stops sending (enabled flipped to false)", () => {
    const was = enabledConfig();
    const after = { ...was, enabled: false };
    expect(isTelemetrySendingEnabled(after, {})).toBe(false);
  });
});

// ─── telemetryEnvironmentDisabled ────────────────────────────────────────────

describe("telemetryEnvironmentDisabled", () => {
  it("returns false for empty env", () => {
    expect(telemetryEnvironmentDisabled({})).toBe(false);
  });

  it("detects DO_NOT_TRACK", () => {
    expect(telemetryEnvironmentDisabled({ DO_NOT_TRACK: "1" })).toBe(true);
  });

  it("detects MARTIN_TELEMETRY_DISABLED", () => {
    expect(telemetryEnvironmentDisabled({ MARTIN_TELEMETRY_DISABLED: "true" })).toBe(true);
  });

  it("detects CI", () => {
    expect(telemetryEnvironmentDisabled({ CI: "true" })).toBe(true);
  });

  it("treats '0' as falsy", () => {
    expect(telemetryEnvironmentDisabled({ DO_NOT_TRACK: "0" })).toBe(false);
  });

  it("treats 'false' as falsy", () => {
    expect(telemetryEnvironmentDisabled({ CI: "false" })).toBe(false);
  });
});

// ─── assertAllowedTelemetryPayload — key allowlist ────────────────────────────

describe("assertAllowedTelemetryPayload — key allowlist", () => {
  it("passes for empty payload on install_initialized", () => {
    expect(() => assertAllowedTelemetryPayload("install_initialized", {})).not.toThrow();
  });

  it("passes for allowed keys on run_completed", () => {
    expect(() => assertAllowedTelemetryPayload("run_completed", {
      durationMs: 1000, command: "run", receiptGenerated: true, recoveryOccurred: false
    })).not.toThrow();
  });

  it("throws for disallowed key", () => {
    expect(() => assertAllowedTelemetryPayload("run_completed", {
      durationMs: 1000, sensitiveData: "secret"
    })).toThrow("Unsupported telemetry payload key: sensitiveData");
  });

  it("throws for source code or task content", () => {
    expect(() => assertAllowedTelemetryPayload("run_started", {
      command: "run", repoContents: "my code"
    })).toThrow();
  });

  it("blocks email field on run_started", () => {
    expect(() => assertAllowedTelemetryPayload("run_started", {
      command: "run", email: "user@example.com"
    })).toThrow();
  });

  it("blocks sessionId on run_completed", () => {
    expect(() => assertAllowedTelemetryPayload("run_completed", {
      durationMs: 1000, sessionId: "sid-123"
    })).toThrow();
  });

  it("blocks workspace or org identity on run_started", () => {
    expect(() => assertAllowedTelemetryPayload("run_started", {
      command: "run", workspaceId: "ws-123"
    })).toThrow();
  });

  it("remote_experience_clicked allows only experienceId and experienceType", () => {
    expect(() => assertAllowedTelemetryPayload("remote_experience_clicked", {
      experienceId: "exp-1", experienceType: "dashboard_invite"
    })).not.toThrow();
  });

  it("blocks claimToken on remote_experience_clicked", () => {
    expect(() => assertAllowedTelemetryPayload("remote_experience_clicked", {
      experienceId: "exp-1", claimToken: "secret-token"
    })).toThrow();
  });
});

// ─── assertAllowedTelemetryPayload — command value enforcement ────────────────

describe("assertAllowedTelemetryPayload — command value enforcement", () => {
  it("passes with allowed command category 'run'", () => {
    expect(() => assertAllowedTelemetryPayload("run_started", { command: "run" })).not.toThrow();
    expect(() => assertAllowedTelemetryPayload("run_completed", {
      durationMs: 0, command: "run", receiptGenerated: false, recoveryOccurred: false
    })).not.toThrow();
    expect(() => assertAllowedTelemetryPayload("run_failed", {
      durationMs: 0, command: "run", reason: "unknown"
    })).not.toThrow();
  });

  it("rejects arbitrary task text in command field", () => {
    expect(() => assertAllowedTelemetryPayload("run_started", {
      command: "fix login bug in src/auth.ts"
    })).toThrow(/Unsupported telemetry command category/);
  });

  it("rejects file path in command field", () => {
    expect(() => assertAllowedTelemetryPayload("run_started", {
      command: "run src/private/customer.ts"
    })).toThrow(/Unsupported telemetry command category/);
  });

  it("rejects prompt content in command field", () => {
    expect(() => assertAllowedTelemetryPayload("run_started", {
      command: "--prompt secret token abc"
    })).toThrow(/Unsupported telemetry command category/);
  });

  it("rejects empty string as command category", () => {
    expect(() => assertAllowedTelemetryPayload("run_started", {
      command: ""
    })).toThrow(/Unsupported telemetry command category/);
  });
});

// ─── assertAllowedTelemetryPayload — scalar type validation ──────────────────

describe("assertAllowedTelemetryPayload — scalar type validation", () => {
  it("rejects non-finite durationMs", () => {
    expect(() => assertAllowedTelemetryPayload("run_completed", {
      durationMs: Infinity, command: "run", receiptGenerated: false, recoveryOccurred: false
    })).toThrow(/Invalid durationMs/);
  });

  it("rejects negative durationMs", () => {
    expect(() => assertAllowedTelemetryPayload("run_completed", {
      durationMs: -1, command: "run", receiptGenerated: false, recoveryOccurred: false
    })).toThrow(/Invalid durationMs/);
  });

  it("rejects non-boolean receiptGenerated", () => {
    expect(() => assertAllowedTelemetryPayload("run_completed", {
      durationMs: 100, command: "run", receiptGenerated: "yes", recoveryOccurred: false
    })).toThrow(/receiptGenerated must be boolean/);
  });

  it("rejects non-boolean recoveryOccurred", () => {
    expect(() => assertAllowedTelemetryPayload("run_completed", {
      durationMs: 100, command: "run", receiptGenerated: false, recoveryOccurred: 1
    })).toThrow(/recoveryOccurred must be boolean/);
  });

  it("rejects non-boolean enabled on telemetry_changed", () => {
    expect(() => assertAllowedTelemetryPayload("telemetry_changed", {
      enabled: "true"
    })).toThrow(/enabled must be boolean/);
  });

  it("rejects non-boolean connected on control_plane_connected", () => {
    expect(() => assertAllowedTelemetryPayload("control_plane_connected", {
      connected: 1
    })).toThrow(/connected must be boolean/);
  });
});

// ─── toTelemetryFailureReason ─────────────────────────────────────────────────

describe("toTelemetryFailureReason", () => {
  it("maps known reason codes", () => {
    expect(toTelemetryFailureReason("provider_unavailable")).toBe("provider_unavailable");
    expect(toTelemetryFailureReason("verification_failed")).toBe("verification_failed");
    expect(toTelemetryFailureReason("budget_exit")).toBe("budget_exit");
    expect(toTelemetryFailureReason("policy_blocked")).toBe("policy_blocked");
    expect(toTelemetryFailureReason("persistence_failed")).toBe("persistence_failed");
  });

  it("defaults unknown codes to 'unknown'", () => {
    expect(toTelemetryFailureReason("some_new_code")).toBe("unknown");
    expect(toTelemetryFailureReason(undefined)).toBe("unknown");
  });
});

// ─── sendProductEvent ─────────────────────────────────────────────────────────

describe("sendProductEvent", () => {
  const baseInput = {
    endpoint: "https://example.com/events",
    config: enabledConfig(),
    event: "run_started" as const,
    payload: { command: "run" },
    cliVersion: "0.6.8",
  };

  it("returns false on fresh install (default config — no disclosure yet)", async () => {
    const result = await sendProductEvent({
      ...baseInput,
      config: DEFAULT_TELEMETRY_CONFIG,
    });
    expect(result).toBe(false);
  });

  it("returns false when config.enabled is false", async () => {
    const result = await sendProductEvent({
      ...baseInput,
      config: enabledConfig({ enabled: false }),
    });
    expect(result).toBe(false);
  });

  it("returns false when noticeShown=false and userChoseExplicitly=false", async () => {
    const result = await sendProductEvent({
      ...baseInput,
      config: enabledConfig({ noticeShown: false, userChoseExplicitly: false }),
    });
    expect(result).toBe(false);
  });

  it("returns false when installId is null", async () => {
    const result = await sendProductEvent({
      ...baseInput,
      config: enabledConfig({ installId: null }),
    });
    expect(result).toBe(false);
  });

  it("returns true when fetch returns 204", async () => {
    const fetchImpl = async () => new Response(null, { status: 204 });
    const result = await sendProductEvent({ ...baseInput, fetchImpl });
    expect(result).toBe(true);
  });

  it("returns false for 400 response", async () => {
    const fetchImpl = async () => new Response("bad request", { status: 400 });
    const result = await sendProductEvent({ ...baseInput, fetchImpl });
    expect(result).toBe(false);
  });

  it("returns false for 500 response", async () => {
    const fetchImpl = async () => new Response("error", { status: 500 });
    const result = await sendProductEvent({ ...baseInput, fetchImpl });
    expect(result).toBe(false);
  });

  it("returns false when fetch throws (network error)", async () => {
    const fetchImpl = async () => { throw new Error("network failure"); };
    const result = await sendProductEvent({ ...baseInput, fetchImpl });
    expect(result).toBe(false);
  });

  it("never throws even on catastrophic failure", async () => {
    const fetchImpl = async (): Promise<Response> => { throw new TypeError("crash"); };
    await expect(sendProductEvent({ ...baseInput, fetchImpl })).resolves.toBe(false);
  });

  it("suppresses when env has DO_NOT_TRACK", async () => {
    const fetchImpl = async () => new Response(null, { status: 204 });
    const result = await sendProductEvent({ ...baseInput, fetchImpl, env: { DO_NOT_TRACK: "1" } });
    expect(result).toBe(false);
  });

  it("suppresses when env has CI", async () => {
    const fetchImpl = async () => new Response(null, { status: 204 });
    const result = await sendProductEvent({ ...baseInput, fetchImpl, env: { CI: "true" } });
    expect(result).toBe(false);
  });

  it("suppresses payload with disallowed key", async () => {
    const fetchImpl = async () => new Response(null, { status: 204 });
    const result = await sendProductEvent({
      ...baseInput,
      payload: { command: "run", secret: "oops" },
      fetchImpl,
    });
    expect(result).toBe(false);
  });

  it("rejects arbitrary command string — does not transmit", async () => {
    const fetchImpl = async () => new Response(null, { status: 204 });
    const result = await sendProductEvent({
      ...baseInput,
      payload: { command: "fix login bug in auth.ts" },
      fetchImpl,
    });
    expect(result).toBe(false);
  });

  it("does not include email in any sent envelope", async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(null, { status: 204 });
    };
    await sendProductEvent({ ...baseInput, fetchImpl });
    expect(sentBody["email"]).toBeUndefined();
    expect(sentBody["payload"] as Record<string, unknown>).not.toHaveProperty("email");
  });

  it("does not include repo name, path, or workspace identity", async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(null, { status: 204 });
    };
    await sendProductEvent({ ...baseInput, fetchImpl });
    expect(sentBody["workspaceId"]).toBeUndefined();
    expect(sentBody["orgId"]).toBeUndefined();
    expect(sentBody["repoName"]).toBeUndefined();
    expect(sentBody["filePath"]).toBeUndefined();
    expect(sentBody["taskText"]).toBeUndefined();
  });

  it("does not transmit when MARTIN_TELEMETRY_DEBUG is set (logs to stderr instead)", async () => {
    let networkCalled = false;
    const fetchImpl = async () => { networkCalled = true; return new Response(null, { status: 204 }); };
    const result = await sendProductEvent({
      ...baseInput,
      fetchImpl,
      env: { MARTIN_TELEMETRY_DEBUG: "1" },
    });
    expect(networkCalled).toBe(false);
    expect(result).toBe(false);
  });
});

// ─── assertAllowedTelemetryPayload — experienceType enum ─────────────────────

describe("assertAllowedTelemetryPayload — experienceType enum", () => {
  it("passes for all valid experience types", () => {
    const validTypes = [
      "security_notice",
      "migration_notice",
      "update_notice",
      "announcement",
      "beta_invite",
      "dashboard_invite",
      "design_partner_invite",
    ];
    for (const experienceType of validTypes) {
      expect(() => assertAllowedTelemetryPayload("remote_experience_clicked", {
        experienceId: "exp-abc", experienceType,
      })).not.toThrow();
    }
  });

  it("rejects arbitrary string not in the enum", () => {
    expect(() => assertAllowedTelemetryPayload("remote_experience_clicked", {
      experienceId: "exp-abc", experienceType: "anything_else",
    })).toThrow(/Unsupported experienceType/);
  });

  it("rejects empty experienceType", () => {
    expect(() => assertAllowedTelemetryPayload("remote_experience_clicked", {
      experienceId: "exp-abc", experienceType: "",
    })).toThrow(/Unsupported experienceType/);
  });

  it("rejects non-string experienceType", () => {
    expect(() => assertAllowedTelemetryPayload("remote_experience_clicked", {
      experienceId: "exp-abc", experienceType: 42,
    })).toThrow(/Unsupported experienceType/);
  });
});

// ─── assertAllowedTelemetryPayload — experienceId contract ───────────────────

describe("assertAllowedTelemetryPayload — experienceId contract", () => {
  it("passes for a normal server-assigned slug", () => {
    expect(() => assertAllowedTelemetryPayload("remote_experience_clicked", {
      experienceId: "exp-dashboard-abc123", experienceType: "dashboard_invite",
    })).not.toThrow();
  });

  it("passes at the 64-character limit", () => {
    const maxId = "x".repeat(64);
    expect(() => assertAllowedTelemetryPayload("remote_experience_clicked", {
      experienceId: maxId, experienceType: "announcement",
    })).not.toThrow();
  });

  it("rejects empty experienceId", () => {
    expect(() => assertAllowedTelemetryPayload("remote_experience_clicked", {
      experienceId: "", experienceType: "dashboard_invite",
    })).toThrow(/Invalid experienceId/);
  });

  it("rejects experienceId longer than 64 characters", () => {
    const tooLong = "x".repeat(65);
    expect(() => assertAllowedTelemetryPayload("remote_experience_clicked", {
      experienceId: tooLong, experienceType: "dashboard_invite",
    })).toThrow(/Invalid experienceId/);
  });

  it("rejects spaces and path-like characters in experienceId", () => {
    for (const experienceId of ["dashboard invite", "repo/path", "../secret"]) {
      expect(() => assertAllowedTelemetryPayload("remote_experience_clicked", {
        experienceId, experienceType: "dashboard_invite",
      })).toThrow(/Invalid experienceId/);
    }
  });

  it("rejects non-string experienceId", () => {
    expect(() => assertAllowedTelemetryPayload("remote_experience_clicked", {
      experienceId: 12345, experienceType: "dashboard_invite",
    })).toThrow(/Invalid experienceId/);
  });
});

// ─── assertAllowedTelemetryPayload — telemetry_changed source contract ────────

describe("assertAllowedTelemetryPayload — telemetry_changed source contract", () => {
  it("allows enabled-only telemetry_changed payload", () => {
    expect(() => assertAllowedTelemetryPayload("telemetry_changed", {
      enabled: true,
    })).not.toThrow();
  });

  it("rejects source because the shipped CLI does not emit it", () => {
    expect(() => assertAllowedTelemetryPayload("telemetry_changed", {
      enabled: true, source: "martin-cli",
    })).toThrow(/Unsupported telemetry payload key: source/);
  });
});

// ─── assertAllowedTelemetryPayload — run_failed reason enum ──────────────────

describe("assertAllowedTelemetryPayload — run_failed reason enum", () => {
  it("passes for all valid failure reasons", () => {
    const validReasons = [
      "provider_unavailable",
      "verification_failed",
      "budget_exit",
      "policy_blocked",
      "persistence_failed",
      "unknown",
    ];
    for (const reason of validReasons) {
      expect(() => assertAllowedTelemetryPayload("run_failed", {
        durationMs: 500, command: "run", reason,
      })).not.toThrow();
    }
  });

  it("rejects raw exception text", () => {
    expect(() => assertAllowedTelemetryPayload("run_failed", {
      durationMs: 500, command: "run", reason: "Error: ENOENT no such file",
    })).toThrow(/Unsupported failure reason/);
  });

  it("rejects arbitrary string not in the enum", () => {
    expect(() => assertAllowedTelemetryPayload("run_failed", {
      durationMs: 500, command: "run", reason: "some_new_reason",
    })).toThrow(/Unsupported failure reason/);
  });

  it("rejects empty reason string", () => {
    expect(() => assertAllowedTelemetryPayload("run_failed", {
      durationMs: 500, command: "run", reason: "",
    })).toThrow(/Unsupported failure reason/);
  });
});
