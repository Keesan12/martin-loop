import type { MartinAdapter, MartinAdapterRequest, MartinAdapterResult } from "@martin/core";

import { createAdapterCapabilities } from "./runtime-support.js";

export interface DirectProviderAdapterOptions {
  providerId: string;
  model: string;
  label?: string;
  transport?: "http" | "routed_http";
  capabilities?: Partial<NonNullable<MartinAdapter["metadata"]["capabilities"]>>;
  responder?: (request: MartinAdapterRequest) => Promise<MartinAdapterResult> | MartinAdapterResult;
}

export function createDirectProviderAdapter(
  options: DirectProviderAdapterOptions
): MartinAdapter {
  return {
    adapterId: `direct:${options.providerId}:${options.model}`,
    kind: "direct-provider",
    label: options.label ?? `Direct provider (${options.providerId}/${options.model})`,
    metadata: {
      providerId: options.providerId,
      model: options.model,
      transport: options.transport ?? "http",
      capabilities: createAdapterCapabilities({
        usageSettlement: true,
        structuredErrors: true,
        ...options.capabilities
      })
    },
    async execute(request) {
      if (options.responder) {
        return await options.responder(request);
      }

      return {
        status: "failed",
        summary: `Direct provider ${options.providerId}/${options.model} is not configured for live inference.`,
        usage: {
          actualUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
          provenance: "unavailable"
        },
        verification: {
          passed: false,
          summary: "No live provider request was attempted."
        },
        failure: {
          message: `Direct provider ${options.providerId}/${options.model} is not configured for live inference. environment_mismatch`
        }
      };
    }
  };
}
