import type { MartinAdapter, MartinAdapterRequest, MartinAdapterResult } from "@martin/core";

export interface TestAdapterOptions {
  providerId: string;
  model: string;
  responder: (request: MartinAdapterRequest) => Promise<MartinAdapterResult> | MartinAdapterResult;
}

export function createTestAdapter(options: TestAdapterOptions): MartinAdapter {
  return {
    adapterId: `test:fixture:${options.providerId}:${options.model}`,
    kind: "direct-provider",
    label: `Test fixture (${options.providerId}/${options.model})`,
    metadata: {
      providerId: options.providerId,
      model: options.model,
      transport: "http",
      capabilities: {
        preflight: true,
        usageSettlement: true,
        diffArtifacts: false,
        structuredErrors: true,
        cachingSignals: false,
        workspaceMutations: true
      }
    },
    async execute(request) {
      return options.responder(request);
    }
  };
}
