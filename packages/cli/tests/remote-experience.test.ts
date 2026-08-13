// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import {
  parseRemoteExperience,
  fetchRemoteExperience,
  resolveRemoteExperienceEndpoint,
  recordRemoteExperienceDelivered,
  isRemoteExperienceOnCooldown,
  type RemoteExperienceRequest,
} from "../src/remote-experience.js";

const PRODUCT_EVENTS_ENDPOINT = "https://tupopqvqnyyjuxseyxkr.supabase.co/functions/v1/product-events";

const VALID_REMOTE = {
  schemaVersion: 1,
  id: "test-123",
  class: "engagement",
  type: "announcement",
  title: "Test announcement",
  body: "Body text here.",
  cooldownKey: "test-ck",
};

const genericRequest: RemoteExperienceRequest = {
  schemaVersion: 1,
  cliVersion: "0.4.5",
  nodeVersion: "v22.0.0",
  platform: "linux",
  arch: "x64",
};

// ─── parseRemoteExperience ────────────────────────────────────────────────────

describe("parseRemoteExperience", () => {
  it("returns null for null input", () => {
    expect(parseRemoteExperience(null)).toBeNull();
  });

  it("returns null for non-object", () => {
    expect(parseRemoteExperience("string")).toBeNull();
    expect(parseRemoteExperience(42)).toBeNull();
  });

  it("returns null for wrong schemaVersion", () => {
    expect(parseRemoteExperience({ ...VALID_REMOTE, schemaVersion: 2 })).toBeNull();
  });

  it("returns null for unknown type", () => {
    expect(parseRemoteExperience({ ...VALID_REMOTE, type: "unknown_type" })).toBeNull();
  });

  it("returns null for title exceeding max length", () => {
    expect(parseRemoteExperience({ ...VALID_REMOTE, title: "x".repeat(121) })).toBeNull();
  });

  it("returns null for body exceeding max length", () => {
    expect(parseRemoteExperience({ ...VALID_REMOTE, body: "x".repeat(1201) })).toBeNull();
  });

  it("returns null for expired experience", () => {
    const pastDate = new Date(Date.now() - 1000).toISOString();
    expect(parseRemoteExperience({ ...VALID_REMOTE, expiresAt: pastDate })).toBeNull();
  });

  it("accepts a valid future expiresAt", () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    const result = parseRemoteExperience({ ...VALID_REMOTE, expiresAt: futureDate });
    expect(result).not.toBeNull();
    expect(result?.expiresAt).toBe(futureDate);
  });

  it("returns null for disallowed action URL host", () => {
    expect(parseRemoteExperience({
      ...VALID_REMOTE,
      action: { label: "Click", url: "https://evil.com/page" },
    })).toBeNull();
  });

  it("accepts valid martinloop.com action URL", () => {
    const result = parseRemoteExperience({
      ...VALID_REMOTE,
      action: { label: "Open", url: "https://martinloop.com/dashboard" },
    });
    expect(result?.action?.url).toBe("https://martinloop.com/dashboard");
  });

  it("accepts valid required and engagement classes", () => {
    expect(parseRemoteExperience({ ...VALID_REMOTE, class: "required" })?.class).toBe("required");
    expect(parseRemoteExperience({ ...VALID_REMOTE, class: "engagement" })?.class).toBe("engagement");
  });

  it("returns null for control characters in title", () => {
    expect(parseRemoteExperience({ ...VALID_REMOTE, title: "Bad\u0000Title" })).toBeNull();
  });
});

// ─── resolveRemoteExperienceEndpoint ─────────────────────────────────────────

describe("resolveRemoteExperienceEndpoint", () => {
  it("does not return the product-events Supabase URL", () => {
    const endpoint = resolveRemoteExperienceEndpoint();
    expect(endpoint).not.toBe(PRODUCT_EVENTS_ENDPOINT);
  });

  it("returns empty string when env var is not set", () => {
    const saved = process.env["MARTIN_REMOTE_EXPERIENCE_ENDPOINT"];
    delete process.env["MARTIN_REMOTE_EXPERIENCE_ENDPOINT"];
    // Re-evaluate the function (it reads process.env at call time)
    expect(resolveRemoteExperienceEndpoint()).toBe("");
    if (saved !== undefined) process.env["MARTIN_REMOTE_EXPERIENCE_ENDPOINT"] = saved;
  });
});

// ─── fetchRemoteExperience ────────────────────────────────────────────────────

describe("fetchRemoteExperience", () => {
  it("returns null when endpoint is empty", async () => {
    const result = await fetchRemoteExperience(genericRequest, { endpoint: "" });
    expect(result).toBeNull();
  });

  it("returns null when fetch throws (network error)", async () => {
    const fetchImpl = async (): Promise<Response> => { throw new Error("network down"); };
    const result = await fetchRemoteExperience(genericRequest, { endpoint: "https://example.com", fetchImpl });
    expect(result).toBeNull();
  });

  it("returns null on non-ok response (400)", async () => {
    const fetchImpl = async () => new Response("bad", { status: 400 });
    const result = await fetchRemoteExperience(genericRequest, { endpoint: "https://example.com", fetchImpl });
    expect(result).toBeNull();
  });

  it("returns null on 404", async () => {
    const fetchImpl = async () => new Response("not found", { status: 404 });
    const result = await fetchRemoteExperience(genericRequest, { endpoint: "https://example.com", fetchImpl });
    expect(result).toBeNull();
  });

  it("returns null on 500", async () => {
    const fetchImpl = async () => new Response("error", { status: 500 });
    const result = await fetchRemoteExperience(genericRequest, { endpoint: "https://example.com", fetchImpl });
    expect(result).toBeNull();
  });

  it("returns null on AbortError (timeout)", async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    const result = await fetchRemoteExperience(genericRequest, { endpoint: "https://example.com", fetchImpl });
    expect(result).toBeNull();
  });

  it("returns parsed experience on 200 with valid body", async () => {
    const fetchImpl = async () => new Response(JSON.stringify(VALID_REMOTE), { status: 200 });
    const result = await fetchRemoteExperience(genericRequest, { endpoint: "https://example.com", fetchImpl });
    expect(result?.id).toBe("test-123");
  });

  it("returns null when response body fails validation (bad schema)", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ schemaVersion: 99 }), { status: 200 });
    const result = await fetchRemoteExperience(genericRequest, { endpoint: "https://example.com", fetchImpl });
    expect(result).toBeNull();
  });

  it("generic request contains no installId when not provided", async () => {
    let sentBody: unknown;
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify(VALID_REMOTE), { status: 200 });
    };
    await fetchRemoteExperience(genericRequest, { endpoint: "https://example.com", fetchImpl });
    expect((sentBody as Record<string, unknown>)["installId"]).toBeUndefined();
    expect((sentBody as Record<string, unknown>)["sessionId"]).toBeUndefined();
  });

  it("request with installId sends it", async () => {
    let sentBody: unknown;
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify(VALID_REMOTE), { status: 200 });
    };
    const requestWithId: RemoteExperienceRequest = { ...genericRequest, installId: "inst-abc" };
    await fetchRemoteExperience(requestWithId, { endpoint: "https://example.com", fetchImpl });
    expect((sentBody as Record<string, unknown>)["installId"]).toBe("inst-abc");
    expect((sentBody as Record<string, unknown>)["sessionId"]).toBeUndefined();
  });
});

// ─── delivery ledger ──────────────────────────────────────────────────────────

describe("delivery ledger", () => {
  it("isRemoteExperienceOnCooldown returns false for unknown key", async () => {
    const result = await isRemoteExperienceOnCooldown("never-delivered-" + Date.now());
    expect(result).toBe(false);
  });

  it("recordRemoteExperienceDelivered does not throw", async () => {
    await expect(recordRemoteExperienceDelivered("test-key-" + Date.now())).resolves.not.toThrow();
  });

  it("isRemoteExperienceOnCooldown respects future nowMs for recorded key", async () => {
    const key = "cooldown-test-" + Date.now();
    const now = Date.now();
    await recordRemoteExperienceDelivered(key, now);
    // Check 1 second later — still on cooldown
    const onCooldown = await isRemoteExperienceOnCooldown(key, now + 1000);
    expect(onCooldown).toBe(true);
  });

  it("isRemoteExperienceOnCooldown is false after cooldown window expires", async () => {
    const key = "expired-" + Date.now();
    const oldTime = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
    await recordRemoteExperienceDelivered(key, oldTime);
    const onCooldown = await isRemoteExperienceOnCooldown(key, Date.now());
    expect(onCooldown).toBe(false);
  });
});
