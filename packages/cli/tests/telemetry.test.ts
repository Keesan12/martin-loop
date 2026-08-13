// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import {
  shouldShowTelemetryNotice,
  isTelemetrySendingEnabled,
  telemetryEnvironmentDisabled,
  assertAllowedTelemetryPayload,
  toTelemetryFailureReason,
  sendProductEvent,
  DEFAULT_TELEMETRY_CONFIG,
  type TelemetryConfigV1,
} from "../src/telemetry.js";

function enabledConfig(overrides: Partial<TelemetryConfigV1> = {}): TelemetryConfigV1 {
  return {
    schemaVersion: 1,
    enabled: true,
    noticeShown: true,
    installId: "test-install-id",
    initializedEventSent: true,
    ...overrides,
  };
}

// ─── fresh-install defaults ───────────────────────────────────────────────────

describe("DEFAULT_TELEMETRY_CONFIG", () => {
  it("has telemetry disabled by default (opt-in model)", () => {
    expect(DEFAULT_TELEMETRY_CONFIG.enabled).toBe(false);
  });

  it("has noticeShown false on fresh install", () => {
    expect(DEFAULT_TELEMETRY_CONFIG.noticeShown).toBe(false);
  });

  it("no event is sent on fresh install (enabled=false blocks sending)", () => {
    expect(isTelemetrySendingEnabled(DEFAULT_TELEMETRY_CONFIG, {})).toBe(false);
  });

  it("no event is sent even after notice shown if user did not accept", () => {
    const afterNoticeDeclined: TelemetryConfigV1 = {
      ...DEFAULT_TELEMETRY_CONFIG,
      noticeShown: true,
      enabled: false,
    };
    expect(isTelemetrySendingEnabled(afterNoticeDeclined, {})).toBe(false);
  });

  it("events are sent only after notice shown AND user explicitly accepted", () => {
    const afterAccept: TelemetryConfigV1 = {
      ...DEFAULT_TELEMETRY_CONFIG,
      noticeShown: true,
      enabled: true,
      installId: "inst-123",
      initializedEventSent: true,
    };
    expect(isTelemetrySendingEnabled(afterAccept, {})).toBe(true);
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

  it("shows even when enabled is false (notice is the opt-in invitation)", () => {
    expect(shouldShowTelemetryNotice({
      config: { ...DEFAULT_TELEMETRY_CONFIG, enabled: false, noticeShown: false },
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

// ─── isTelemetrySendingEnabled ────────────────────────────────────────────────

describe("isTelemetrySendingEnabled", () => {
  it("returns true when all conditions met", () => {
    expect(isTelemetrySendingEnabled(enabledConfig(), {})).toBe(true);
  });

  it("returns false when enabled is false", () => {
    expect(isTelemetrySendingEnabled(enabledConfig({ enabled: false }), {})).toBe(false);
  });

  it("returns false when noticeShown is false (consent not given)", () => {
    expect(isTelemetrySendingEnabled(enabledConfig({ noticeShown: false }), {})).toBe(false);
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

// ─── assertAllowedTelemetryPayload ────────────────────────────────────────────

describe("assertAllowedTelemetryPayload", () => {
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
    cliVersion: "0.5.0",
  };

  it("returns false on fresh install (default config — no consent)", async () => {
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

  it("returns false when noticeShown is false (no consent)", async () => {
    const result = await sendProductEvent({
      ...baseInput,
      config: enabledConfig({ noticeShown: false }),
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

  it("does not include raw install path or machine identity", async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(null, { status: 204 });
    };
    await sendProductEvent({ ...baseInput, fetchImpl });
    expect(sentBody["workspaceId"]).toBeUndefined();
    expect(sentBody["orgId"]).toBeUndefined();
    expect(sentBody["repoName"]).toBeUndefined();
  });
});
