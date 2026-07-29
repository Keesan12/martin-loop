// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify
} from "node:crypto";

import {
  cloneIdentityAttestation,
  cloneIdentityClaims,
  cloneIdentityToken,
  type IdentityAttestation,
  type IdentityClaims,
  type IdentityToken
} from "@martin/contracts";

export interface LocalIdentityAuthority {
  keyId: string;
  algorithm: "ed25519";
  privateKeyPem: string;
  publicKeyPem: string;
}

export function createLocalIdentityAuthority(input: {
  keyId?: string;
} = {}): LocalIdentityAuthority {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");

  return {
    keyId: input.keyId ?? `martin-local-${Date.now().toString(36)}`,
    algorithm: "ed25519",
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString()
  };
}

export function issueIdentityToken(input: {
  authority: Pick<LocalIdentityAuthority, "keyId" | "algorithm" | "privateKeyPem">;
  claims: IdentityClaims;
}): IdentityToken {
  const claims = cloneIdentityClaims(input.claims);
  const signer = createPrivateKey(input.authority.privateKeyPem);
  const payload = serializeIdentityClaims(claims);
  const signature = sign(null, payload, signer).toString("base64");

  return cloneIdentityToken({
    schemaVersion: "martin.identity.v1",
    algorithm: input.authority.algorithm,
    keyId: input.authority.keyId,
    claims,
    signature
  });
}

export function verifyIdentityToken(input: {
  token: IdentityToken;
  publicKeyPem: string;
  now?: string;
}): IdentityAttestation {
  const token = cloneIdentityToken(input.token);
  const verifier = createPublicKey(input.publicKeyPem);
  const payload = serializeIdentityClaims(token.claims);
  const verifiedAt = input.now ?? new Date().toISOString();

  if (token.schemaVersion !== "martin.identity.v1") {
    return cloneIdentityAttestation({
      valid: false,
      verifiedAt,
      reason: `Unsupported identity schema version '${token.schemaVersion}'.`,
      token
    });
  }

  const signatureValid = verify(null, payload, verifier, Buffer.from(token.signature, "base64"));
  if (!signatureValid) {
    return cloneIdentityAttestation({
      valid: false,
      verifiedAt,
      reason: "Identity signature verification failed.",
      token
    });
  }

  const expiresAt = token.claims.expiresAt ? Date.parse(token.claims.expiresAt) : undefined;
  if (expiresAt !== undefined && Number.isFinite(expiresAt) && expiresAt <= Date.parse(verifiedAt)) {
    return cloneIdentityAttestation({
      valid: false,
      verifiedAt,
      reason: "Identity token is expired.",
      token
    });
  }

  return cloneIdentityAttestation({
    valid: true,
    verifiedAt,
    reason: `Identity token for role '${token.claims.role}' verified successfully.`,
    token
  });
}

export function hasIdentityScope(token: IdentityToken, requiredScope: string): boolean {
  const required = requiredScope.trim().toLowerCase();
  if (required.length === 0) {
    return false;
  }

  return token.claims.scopes.some((scope) => scope.trim().toLowerCase() === required);
}

function serializeIdentityClaims(claims: IdentityClaims): Buffer {
  return Buffer.from(JSON.stringify(claims, sortKeys), "utf8");
}

function sortKeys(_: string, value: unknown): unknown {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = (value as Record<string, unknown>)[key];
        return sorted;
      }, {});
  }
  return value;
}
