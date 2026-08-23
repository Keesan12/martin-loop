import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  MARTIN_ARCADE_FALLBACK_TEXT,
  MARTIN_ARCADE_MIME_TYPE,
  MARTIN_ARCADE_RESOURCE_URI,
  buildArcadeToolDefinitions,
  supportsMartinArcadeApp
} from "../src/arcade/capabilities.js";
import { listArcadeResources, readArcadeResource } from "../src/arcade/resource.js";
import { readArcadeStatus } from "../src/arcade/status.js";
import { createMartinMcpServer } from "../src/server.js";

const appCapabilities = {
  extensions: {
    "io.modelcontextprotocol/ui": {
      mimeTypes: [MARTIN_ARCADE_MIME_TYPE]
    }
  }
};

function makeDossier(lifecycleState: string, outcome: "VERIFIED" | "STOPPED" | "NEEDS REVIEW") {
  return {
    loop: {
      loopId: "loop_arcade_001",
      lifecycleState,
      attempts: 1,
      costUsd: 0.42,
      costProvenance: "provider_reported",
      remainingBudgetUsd: 1.58
    },
    budget: { maxUsd: 2, softLimitUsd: 1.5, maxIterations: 2, maxTokens: 10_000 },
    cost: { actualUsd: 0.42, avoidedUsd: 0, tokensIn: 100, tokensOut: 50, provenance: "provider_reported" },
    receiptIntegrity: { state: "verified", reason: "Receipt hash chain verified." },
    attempts: [{ index: 1, artifactFiles: [] }],
    verification: { status: "passed", warnings: [] },
    verifiedHandoff: { outcome },
    warnings: []
  };
}

describe("Arcade MCP App capability contract", () => {
  it("advertises the app resource only to clients that negotiate the MCP Apps MIME type", () => {
    expect(supportsMartinArcadeApp(appCapabilities)).toBe(true);
    expect(supportsMartinArcadeApp({ extensions: {} })).toBe(false);

    const supported = buildArcadeToolDefinitions(appCapabilities);
    const unsupported = buildArcadeToolDefinitions({});
    const supportedArcade = supported.find((tool) => tool.name === "martin_arcade");
    const unsupportedArcade = unsupported.find((tool) => tool.name === "martin_arcade");

    expect(supportedArcade?._meta).toMatchObject({ ui: { resourceUri: MARTIN_ARCADE_RESOURCE_URI } });
    expect(unsupportedArcade?._meta).toBeUndefined();
    expect(listArcadeResources(appCapabilities).resources).toEqual([
      expect.objectContaining({ uri: MARTIN_ARCADE_RESOURCE_URI, mimeType: MARTIN_ARCADE_MIME_TYPE })
    ]);
    expect(listArcadeResources({}).resources).toEqual([]);
  });

  it("preserves a meaningful terminal fallback and hides the status tool from model discovery", () => {
    const tools = buildArcadeToolDefinitions({});
    expect(MARTIN_ARCADE_FALLBACK_TEXT).toBe(
      "MartinLoop Arcade is available in an interactive terminal with --arcade."
    );
    expect(tools.find((tool) => tool.name === "martin_arcade_status")?._meta).toEqual({
      ui: { visibility: ["app"] }
    });
    expect(tools.find((tool) => tool.name === "martin_arcade_status")?.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { loopId: { type: "string" } }
    });
  });

  it("reads a self-contained ui resource without writing to stdout", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const result = await readArcadeResource(MARTIN_ARCADE_RESOURCE_URI);
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0]).toMatchObject({
        uri: MARTIN_ARCADE_RESOURCE_URI,
        mimeType: MARTIN_ARCADE_MIME_TYPE
      });
      expect(result.contents[0]?.text).toContain("MartinLoop Arcade");
      expect(result.contents[0]?.text).toContain("data-martin-arcade-app");
      expect(result.contents[0]?.text).not.toMatch(/https?:\/\//u);
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });
});

describe("Arcade read-only status authority", () => {
  it.each(["created", "running", "verifying"])(
    "does not display a terminal outcome while lifecycle is %s",
    async (lifecycleState) => {
      const dossier = makeDossier(lifecycleState, "NEEDS REVIEW");
      const reader = vi.fn(async () => dossier as never);
      const snapshot = await readArcadeStatus({}, reader);

      expect(reader).toHaveBeenCalledWith({ latest: true });
      expect(snapshot.displayOutcome).toBeNull();
      expect(snapshot.completed).toBe(false);
      expect(dossier.verifiedHandoff.outcome).toBe("NEEDS REVIEW");
    }
  );

  it.each(["VERIFIED", "STOPPED", "NEEDS REVIEW"] as const)(
    "passes through authoritative terminal outcome %s without mutation",
    async (outcome) => {
      const dossier = makeDossier("completed", outcome);
      const reader = vi.fn(async () => dossier as never);
      const snapshot = await readArcadeStatus({ loopId: "loop_arcade_001" }, reader);

      expect(reader).toHaveBeenCalledWith({ loopId: "loop_arcade_001" });
      expect(snapshot.displayOutcome).toBe(outcome);
      expect(snapshot.completed).toBe(true);
      expect(dossier.verifiedHandoff.outcome).toBe(outcome);
      expect(snapshot).not.toHaveProperty("pause");
      expect(snapshot).not.toHaveProperty("cancel");
      expect(snapshot).not.toHaveProperty("resume");
    }
  );
});

describe("Arcade MCP protocol integration", () => {
  it.each([
    ["supported", appCapabilities, true],
    ["unsupported", {}, false]
  ] as const)("preserves discovery and fallback for %s clients", async (_label, capabilities, supported) => {
    const server = createMartinMcpServer();
    const client = new Client(
      { name: "arcade-contract-test", version: "0.0.0" },
      { capabilities: capabilities as never }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const tools = await client.listTools();
      const resources = await client.listResources();
      const arcade = tools.tools.find((tool) => tool.name === "martin_arcade");

      expect(tools.tools.map((tool) => tool.name)).toContain("martin_preflight");
      expect(arcade).toBeDefined();
      expect(arcade?._meta?.ui).toEqual(
        supported ? { resourceUri: MARTIN_ARCADE_RESOURCE_URI } : undefined
      );
      expect(resources.resources.some((resource) => resource.uri === MARTIN_ARCADE_RESOURCE_URI)).toBe(supported);

      const opened = await client.callTool({ name: "martin_arcade", arguments: {} });
      expect(opened.content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "text", text: MARTIN_ARCADE_FALLBACK_TEXT })])
      );
      expect(opened.structuredContent).toEqual({
        available: supported,
        resourceUri: supported ? MARTIN_ARCADE_RESOURCE_URI : null
      });

      if (supported) {
        const resource = await client.readResource({ uri: MARTIN_ARCADE_RESOURCE_URI });
        expect(resource.contents[0]).toMatchObject({
          uri: MARTIN_ARCADE_RESOURCE_URI,
          mimeType: MARTIN_ARCADE_MIME_TYPE
        });
      }
    } finally {
      await clientTransport.close().catch(() => {});
      await serverTransport.close().catch(() => {});
    }
  });
});
