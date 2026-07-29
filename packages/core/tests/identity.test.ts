// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createLocalIdentityAuthority,
  hasIdentityScope,
  issueIdentityToken,
  verifyIdentityToken
} from "../src/index.js";

describe("local identity authority", () => {
  it("issues and verifies a portable local role token", () => {
    const authority = createLocalIdentityAuthority({ keyId: "local-role-test" });
    const token = issueIdentityToken({
      authority,
      claims: {
        subject: "agent:worker-1",
        issuer: "martin-local",
        role: "worker",
        scopes: ["repo:read", "repo:write"],
        issuedAt: "2026-06-07T18:00:00.000Z",
        expiresAt: "2026-06-07T19:00:00.000Z",
        workspaceId: "ws_runtime",
        sessionId: "session_001"
      }
    });

    const attestation = verifyIdentityToken({
      token,
      publicKeyPem: authority.publicKeyPem,
      now: "2026-06-07T18:30:00.000Z"
    });

    expect(attestation.valid).toBe(true);
    expect(attestation.reason).toContain("verified successfully");
    expect(hasIdentityScope(token, "repo:write")).toBe(true);
    expect(hasIdentityScope(token, "repo:admin")).toBe(false);
  });

  it("fails verification when claims are tampered after signing", () => {
    const authority = createLocalIdentityAuthority({ keyId: "local-role-test" });
    const token = issueIdentityToken({
      authority,
      claims: {
        subject: "agent:reviewer-1",
        issuer: "martin-local",
        role: "reviewer",
        scopes: ["repo:read"],
        issuedAt: "2026-06-07T18:00:00.000Z"
      }
    });

    const tampered = {
      ...token,
      claims: {
        ...token.claims,
        scopes: ["repo:read", "repo:write"]
      }
    };

    const attestation = verifyIdentityToken({
      token: tampered,
      publicKeyPem: authority.publicKeyPem,
      now: "2026-06-07T18:10:00.000Z"
    });

    expect(attestation.valid).toBe(false);
    expect(attestation.reason).toContain("signature verification failed");
  });

  it("fails verification when the token is expired", () => {
    const authority = createLocalIdentityAuthority({ keyId: "local-role-test" });
    const token = issueIdentityToken({
      authority,
      claims: {
        subject: "agent:verifier-1",
        issuer: "martin-local",
        role: "verifier",
        scopes: ["verify:run"],
        issuedAt: "2026-06-07T18:00:00.000Z",
        expiresAt: "2026-06-07T18:05:00.000Z"
      }
    });

    const attestation = verifyIdentityToken({
      token,
      publicKeyPem: authority.publicKeyPem,
      now: "2026-06-07T18:06:00.000Z"
    });

    expect(attestation.valid).toBe(false);
    expect(attestation.reason).toContain("expired");
  });
});
