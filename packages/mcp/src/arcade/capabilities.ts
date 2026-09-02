export const MARTIN_ARCADE_UI_EXTENSION_ID = "io.modelcontextprotocol/ui";
export const MARTIN_ARCADE_MIME_TYPE = "text/html;profile=mcp-app";
export const MARTIN_ARCADE_RESOURCE_URI = "ui://martinloop/arcade/index.html";
export const MARTIN_ARCADE_FALLBACK_TEXT =
  "MartinLoop Arcade is available in an interactive terminal with --arcade.";

interface ClientCapabilitiesLike {
  extensions?: Record<string, { mimeTypes?: unknown } | undefined>;
}

export function supportsMartinArcadeApp(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== "object") return false;
  const extension = (capabilities as ClientCapabilitiesLike).extensions?.[MARTIN_ARCADE_UI_EXTENSION_ID];
  return Array.isArray(extension?.mimeTypes) && extension.mimeTypes.includes(MARTIN_ARCADE_MIME_TYPE);
}

export function buildArcadeToolDefinitions(capabilities: unknown) {
  const arcadeMeta = supportsMartinArcadeApp(capabilities)
    ? { ui: { resourceUri: MARTIN_ARCADE_RESOURCE_URI } }
    : undefined;

  return [
    {
      name: "martin_arcade",
      description:
        "Open the presentation-only MartinLoop Arcade when the host supports MCP Apps. The Arcade cannot change governed execution or evidence.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {}
      },
      ...(arcadeMeta ? { _meta: arcadeMeta } : {})
    },
    {
      name: "martin_arcade_status",
      description:
        "Read the read-only evidence projection used by the Arcade view. Provide loopId for one exact run or omit it to load the latest run. Use only for Arcade rendering; use martin_status for budget pressure or martin_run_dossier for full evidence. This tool reads persisted evidence and never changes run state.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          loopId: {
            type: "string",
            description: "Optional MartinLoop run identifier. Omit it to read the latest persisted run."
          }
        }
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          loopId: { type: "string", description: "Run identifier represented by this Arcade snapshot." },
          lifecycleState: { type: "string", description: "Current persisted lifecycle state." },
          completed: { type: "boolean", description: "Whether the run is outside an active lifecycle state." },
          displayOutcome: {
            anyOf: [
              { type: "string", enum: ["VERIFIED", "STOPPED", "NEEDS REVIEW"] },
              { type: "null" }
            ],
            description: "Terminal verified-handoff outcome, or null while the run is active."
          },
          verification: {
            type: "object",
            additionalProperties: true,
            description: "Persisted verifier evidence summary."
          },
          receiptIntegrity: {
            type: "object",
            additionalProperties: true,
            description: "Persisted receipt-integrity verdict."
          },
          attempts: { type: "integer", minimum: 0, description: "Number of recorded attempts." },
          cost: {
            type: "object",
            additionalProperties: false,
            properties: {
              actualUsd: { type: "number" },
              provenance: { type: "string" }
            },
            required: ["actualUsd", "provenance"]
          },
          budget: {
            type: "object",
            additionalProperties: false,
            properties: {
              maxUsd: { type: "number" },
              remainingUsd: { type: "number" }
            },
            required: ["maxUsd", "remainingUsd"]
          },
          warnings: {
            type: "array",
            items: { type: "string" },
            description: "Evidence or interpretation warnings for the Arcade view."
          }
        },
        required: [
          "loopId",
          "lifecycleState",
          "completed",
          "displayOutcome",
          "verification",
          "receiptIntegrity",
          "attempts",
          "cost",
          "budget",
          "warnings"
        ]
      },
      _meta: { ui: { visibility: ["app"] } }
    }
  ] as const;
}
