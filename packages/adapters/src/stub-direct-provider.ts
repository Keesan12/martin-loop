import type { MartinAdapter, MartinAdapterRequest, MartinAdapterResult } from "@martin/core";

import { createDirectProviderAdapter } from "./direct-provider.js";

export interface StubDirectProviderAdapterOptions {
  providerId: string;
  model: string;
  label?: string;
  responder?: (request: MartinAdapterRequest) => Promise<MartinAdapterResult> | MartinAdapterResult;
}

export function createStubDirectProviderAdapter(
  options: StubDirectProviderAdapterOptions
): MartinAdapter {
  return createDirectProviderAdapter({
    providerId: options.providerId,
    model: options.model,
    label: options.label ?? `Stub direct provider (${options.providerId}/${options.model})`,
    responder: options.responder
  });
}
