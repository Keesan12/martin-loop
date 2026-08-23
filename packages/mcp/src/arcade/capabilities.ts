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
      description: "Read authoritative MartinLoop evidence for the Arcade view without changing run state.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { loopId: { type: "string" } }
      },
      _meta: { ui: { visibility: ["app"] } }
    }
  ] as const;
}
