import type { MartinAdapter, MartinAdapterRequest, MartinAdapterResult } from "@martin/core";

import { createAdapterCapabilities } from "./runtime-support.js";

export interface StubAgentCliAdapterOptions {
  command: string[];
  profile?: string;
  label?: string;
  responder?: (request: MartinAdapterRequest) => Promise<MartinAdapterResult> | MartinAdapterResult;
}

export function createStubAgentCliAdapter(options: StubAgentCliAdapterOptions): MartinAdapter {
  const metadata = {
    command: options.command.join(" "),
    providerId: "agent-cli",
    model: options.profile ?? options.command[0] ?? "default",
    transport: "cli" as const,
    capabilities: createAdapterCapabilities(),
    ...(options.profile ? { profile: options.profile } : {})
  };

  return {
    adapterId: `agent-cli:${options.command.join(":")}`,
    kind: "agent-cli",
    label: options.label ?? `Stub agent CLI (${options.command.join(" ")})`,
    metadata,
    async execute(request) {
      if (options.responder) {
        return await options.responder(request);
      }

      return {
        status: "failed",
        summary: `Stub agent CLI ${options.command.join(" ")} did not execute a live session.`,
        usage: {
          actualUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
          provenance: "unavailable"
        },
        verification: {
          passed: false,
          summary: "No CLI execution was attempted."
        },
        failure: {
          message: `Agent CLI ${options.command.join(" ")} is not configured for live execution.`,
          classHint: "environment_mismatch"
        }
      };
    }
  };
}
