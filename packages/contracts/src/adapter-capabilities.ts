export type DiffVisibilityLevel = "none" | "git" | "adapter_reported";
export type VerifierCompatibility = "full" | "proof" | "unsupported";
export type SandboxExpectation =
  | "host_process"
  | "workspace_write"
  | "provider_managed"
  | "not_applicable";
export type LaunchReadiness = "path_lookup" | "configured_endpoint" | "built_in";
export type AdapterUsageSettlement = "actual" | "estimated" | "unavailable";

export interface AdapterCapabilityDescriptor {
  preflight: boolean;
  usageSettlement: AdapterUsageSettlement;
  diffVisibility: DiffVisibilityLevel;
  structuredErrors: boolean;
  cachingSignals: boolean;
  verifierCompatibility: VerifierCompatibility;
  sandboxExpectation: SandboxExpectation;
  launchReadiness: LaunchReadiness;
}

export function createAdapterCapabilityDescriptor(
  overrides: Partial<AdapterCapabilityDescriptor> = {}
): AdapterCapabilityDescriptor {
  return {
    preflight: true,
    usageSettlement: "unavailable",
    diffVisibility: "none",
    structuredErrors: false,
    cachingSignals: false,
    verifierCompatibility: "full",
    sandboxExpectation: "host_process",
    launchReadiness: "path_lookup",
    ...overrides
  };
}

export function getBuiltInEngineCapabilityDescriptor(
  engine: "claude" | "codex"
): AdapterCapabilityDescriptor {
  if (engine === "claude") {
    return createAdapterCapabilityDescriptor({
      usageSettlement: "actual",
      diffVisibility: "git",
      structuredErrors: true,
      cachingSignals: true,
      verifierCompatibility: "full",
      sandboxExpectation: "host_process",
      launchReadiness: "path_lookup"
    });
  }

  return createAdapterCapabilityDescriptor({
    usageSettlement: "estimated",
    diffVisibility: "git",
    structuredErrors: true,
    cachingSignals: false,
    verifierCompatibility: "full",
    sandboxExpectation: "workspace_write",
    launchReadiness: "path_lookup"
  });
}
