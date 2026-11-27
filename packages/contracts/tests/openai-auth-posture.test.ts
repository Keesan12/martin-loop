import { describe, expect, it } from "vitest";

import { isOpenAiAuthPostureReady, resolveOpenAiAuthPosture } from "../src/openai-auth-posture.js";

describe("OpenAI-compatible auth posture", () => {
  it.each([
    ["https://api.openai.com", "hosted_bearer", "hosted"],
    ["https://openrouter.ai/api", "router_bearer", "router"],
  ] as const)("classifies %s without retaining a credential", (baseUrl, posture, endpointClass) => {
    expect(resolveOpenAiAuthPosture({ baseUrl, credentialConfigured: true })).toEqual({
      posture, endpointClass, transport: "https", credentialConfigured: true,
    });
  });

  it.each(["http://localhost:11434", "http://127.0.0.1:11434", "http://[::1]:11434"])(
    "accepts loopback no-auth authority at %s",
    (baseUrl) => expect(resolveOpenAiAuthPosture({ baseUrl, credentialConfigured: false }).posture)
      .toBe("loopback_no_auth"),
  );

  it("rejects remote HTTP bearer authority", () => {
    expect(() => resolveOpenAiAuthPosture({ baseUrl: "http://router.example.test", credentialConfigured: true }))
      .toThrow(/BEARER_REQUIRES_HTTPS/u);
  });

  it("requires explicit remote no-auth authority", () => {
    expect(() => resolveOpenAiAuthPosture({ baseUrl: "https://remote.example.test", credentialConfigured: false }))
      .toThrow(/REMOTE_NO_AUTH_REQUIRES_EXPLICIT_AUTHORITY/u);
    expect(resolveOpenAiAuthPosture({
      baseUrl: "https://remote.example.test",
      credentialConfigured: false,
      configuredPosture: "remote_no_auth",
    }).posture).toBe("remote_no_auth");
  });

  it("classifies an unconfigured standard hosted endpoint without claiming readiness", () => {
    const posture = resolveOpenAiAuthPosture({
      baseUrl: "https://api.openai.com",
      credentialConfigured: false,
    });
    expect(posture).toMatchObject({ posture: "hosted_bearer", credentialConfigured: false });
    expect(isOpenAiAuthPostureReady(posture)).toBe(false);
  });
});
