export const OPENAI_AUTH_POSTURES = [
  "hosted_bearer",
  "router_bearer",
  "loopback_no_auth",
  "remote_no_auth",
] as const;

export type OpenAiAuthPostureKind = (typeof OPENAI_AUTH_POSTURES)[number];
export type OpenAiEndpointClass = "hosted" | "router" | "loopback" | "remote";
export type OpenAiTransport = "http" | "https";

/** Non-secret authority safe for logs, receipts, and persisted run metadata. */
export interface OpenAiAuthPosture {
  posture: OpenAiAuthPostureKind;
  endpointClass: OpenAiEndpointClass;
  transport: OpenAiTransport;
  credentialConfigured: boolean;
}

export interface ResolveOpenAiAuthPostureInput {
  baseUrl: string;
  credentialConfigured: boolean;
  /** The only supported explicit no-auth authority for a remote endpoint. */
  configuredPosture?: OpenAiAuthPostureKind;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]";
}

export function resolveOpenAiAuthPosture(input: ResolveOpenAiAuthPostureInput): OpenAiAuthPosture {
  const endpoint = new URL(input.baseUrl);
  const transport: OpenAiTransport = endpoint.protocol === "https:" ? "https" : "http";
  const loopback = isLoopbackHostname(endpoint.hostname);

  if (input.configuredPosture !== undefined && input.configuredPosture !== "remote_no_auth") {
    throw new Error(
      "INVALID_OPENAI_AUTH_POSTURE: only remote_no_auth may be configured explicitly; bearer posture is derived from the endpoint and credential presence."
    );
  }

  if (input.credentialConfigured) {
    if (transport !== "https") {
      throw new Error("OPENAI_BEARER_REQUIRES_HTTPS: bearer credentials may only be sent to a remote HTTPS endpoint.");
    }
    if (input.configuredPosture === "remote_no_auth") {
      throw new Error("OPENAI_AUTH_POSTURE_CONFLICT: remote_no_auth cannot be combined with a bearer credential.");
    }
    const hosted = endpoint.hostname.toLowerCase() === "api.openai.com";
    return {
      posture: hosted ? "hosted_bearer" : "router_bearer",
      endpointClass: hosted ? "hosted" : "router",
      transport,
      credentialConfigured: true,
    };
  }

  if (loopback) {
    if (input.configuredPosture === "remote_no_auth") {
      throw new Error("OPENAI_AUTH_POSTURE_CONFLICT: loopback endpoints use loopback_no_auth authority.");
    }
    return {
      posture: "loopback_no_auth",
      endpointClass: "loopback",
      transport,
      credentialConfigured: false,
    };
  }

  if (endpoint.hostname.toLowerCase() === "api.openai.com" && input.configuredPosture === undefined) {
    return {
      posture: "hosted_bearer",
      endpointClass: "hosted",
      transport,
      credentialConfigured: false,
    };
  }

  if (input.configuredPosture !== "remote_no_auth") {
    throw new Error(
      "OPENAI_REMOTE_NO_AUTH_REQUIRES_EXPLICIT_AUTHORITY: set MARTIN_OPENAI_AUTH_POSTURE=remote_no_auth to authorize a remote endpoint without credentials."
    );
  }

  return {
    posture: "remote_no_auth",
    endpointClass: "remote",
    transport,
    credentialConfigured: false,
  };
}

export function isOpenAiAuthPostureReady(posture: OpenAiAuthPosture): boolean {
  return posture.posture === "hosted_bearer" || posture.posture === "router_bearer"
    ? posture.credentialConfigured
    : !posture.credentialConfigured;
}
