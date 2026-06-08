export type IdentityAlgorithm = "ed25519";

export type IdentityRole =
  | "governor"
  | "verifier"
  | "worker"
  | "reviewer"
  | "observer";

export interface IdentityClaims {
  subject: string;
  issuer: string;
  role: IdentityRole;
  scopes: string[];
  issuedAt: string;
  expiresAt?: string;
  workspaceId?: string;
  sessionId?: string;
  metadata?: Record<string, string>;
}

export interface IdentityToken {
  schemaVersion: "martin.identity.v1";
  algorithm: IdentityAlgorithm;
  keyId: string;
  claims: IdentityClaims;
  signature: string;
}

export interface IdentityAttestation {
  valid: boolean;
  verifiedAt: string;
  reason: string;
  token: IdentityToken;
}

export function cloneIdentityClaims(claims: IdentityClaims): IdentityClaims {
  return {
    subject: claims.subject,
    issuer: claims.issuer,
    role: claims.role,
    scopes: [...claims.scopes],
    issuedAt: claims.issuedAt,
    ...(claims.expiresAt ? { expiresAt: claims.expiresAt } : {}),
    ...(claims.workspaceId ? { workspaceId: claims.workspaceId } : {}),
    ...(claims.sessionId ? { sessionId: claims.sessionId } : {}),
    ...(claims.metadata ? { metadata: { ...claims.metadata } } : {})
  };
}

export function cloneIdentityToken(token: IdentityToken): IdentityToken {
  return {
    schemaVersion: token.schemaVersion,
    algorithm: token.algorithm,
    keyId: token.keyId,
    claims: cloneIdentityClaims(token.claims),
    signature: token.signature
  };
}

export function cloneIdentityAttestation(
  attestation: IdentityAttestation
): IdentityAttestation {
  return {
    valid: attestation.valid,
    verifiedAt: attestation.verifiedAt,
    reason: attestation.reason,
    token: cloneIdentityToken(attestation.token)
  };
}
