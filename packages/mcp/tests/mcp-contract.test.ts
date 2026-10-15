import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createLoopRecord, VERIFIED_HANDOFF_OUTCOMES } from "@martin/contracts";

import { readArcadeStatus } from "../src/arcade/status.js";
import { createMartinMcpServer } from "../src/server.js";
import { validateToolInput } from "../src/server-validation.js";
import { martinPreflightTool } from "../src/tools/preflight.js";

// Contract between what the server advertises in tools/list and what its handlers accept and
// return. Every advertised input property must be accepted, and every structured result must
// validate against the advertised output schema.

interface AdvertisedTool {
  name: string;
  inputSchema: { properties?: Record<string, JsonSchema>; required?: string[] };
  outputSchema?: Record<string, unknown>;
}
interface JsonSchema { type?: string | string[]; enum?: unknown[]; items?: JsonSchema; anyOf?: JsonSchema[] }

let tools: AdvertisedTool[] = [];
const validator = new AjvJsonSchemaValidator();

beforeAll(async () => {
  const server = createMartinMcpServer({ toolProfile: "full" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "contract-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  tools = (await client.listTools()).tools as AdvertisedTool[];
  await client.close();
});

afterAll(() => {
  tools = [];
});

function sampleValue(name: string, schema: JsonSchema): unknown {
  if (schema.enum?.length) return schema.enum[0];
  if (schema.anyOf?.length) return sampleValue(name, schema.anyOf[0] ?? {});
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "boolean": return false;
    case "integer":
    case "number": return 1;
    case "array": return [sampleValue(name, schema.items ?? { type: "string" })];
    case "object": return {};
    default: return name === "loopId" ? "loop_contract" : `sample-${name}`;
  }
}

function requiredArgs(tool: AdvertisedTool): Record<string, unknown> {
  const properties = tool.inputSchema.properties ?? {};
  return Object.fromEntries((tool.inputSchema.required ?? []).map((key) => [key, sampleValue(key, properties[key] ?? {})]));
}

describe("advertised MCP input schemas", () => {
  it("advertises tools", () => {
    expect(tools.length).toBeGreaterThan(10);
  });

  it("accepts every advertised property of every tool", () => {
    const rejected: string[] = [];
    // Arcade tools are validated by their own handler, not validateToolInput.
    for (const tool of tools.filter((t) => !t.name.startsWith("martin_arcade"))) {
      for (const [property, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
        const args = { ...requiredArgs(tool), [property]: sampleValue(property, schema) };
        try {
          validateToolInput(tool.name as Parameters<typeof validateToolInput>[0], args);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/Unknown arguments|Unknown tool/u.test(message)) rejected.push(`${tool.name}.${property}: ${message}`);
        }
      }
    }
    expect(rejected).toEqual([]);
  });
});

describe("every safely callable tool returns output that matches its advertised schema", () => {
  const originalEnv = { runs: process.env.MARTIN_RUNS_DIR, workspace: process.env.MARTIN_MCP_WORKSPACE_ROOT, live: process.env.MARTIN_LIVE };
  let workspace = "";
  let client: Client;
  const loopId = "loop_contract_calls";

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "martin-mcp-contract-"));
    const runsDir = path.join(workspace, "runs");
    const repoRoot = path.join(workspace, "repo");
    await mkdir(path.join(runsDir, loopId), { recursive: true });
    await mkdir(repoRoot, { recursive: true });
    process.env.MARTIN_RUNS_DIR = runsDir;
    process.env.MARTIN_MCP_WORKSPACE_ROOT = workspace;
    process.env.MARTIN_LIVE = "false";
    const loop = {
      ...createLoopRecord({
        workspaceId: "ws_contract",
        projectId: "proj_contract",
        task: { title: "Contract run", objective: "Contract run", verificationPlan: ["npm test"], repoRoot }
      }),
      loopId,
      status: "failed",
      lifecycleState: "failed"
    };
    await writeFile(path.join(runsDir, loopId, "loop-record.json"), `${JSON.stringify(loop, null, 2)}\n`, "utf8");

    const server = createMartinMcpServer({ toolProfile: "full" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "contract-calls", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    // Real hosts list tools first; the client then validates structured output against each
    // advertised outputSchema. Without this the output contract is never checked.
    await client.listTools();
  });

  afterAll(async () => {
    await client?.close();
    for (const [key, value] of [["MARTIN_RUNS_DIR", originalEnv.runs], ["MARTIN_MCP_WORKSPACE_ROOT", originalEnv.workspace], ["MARTIN_LIVE", originalEnv.live]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  });

  const sel = { loopId };
  const calls: Array<[string, Record<string, unknown>]> = [
    ["martin_doctor", {}],
    ["martin_plan", { objective: "Add subtract", verificationPlan: ["npm test"] }],
    ["martin_preflight", { objective: "Add subtract", engine: "codex", verificationPlan: ["npm test"] }],
    ["martin_estimate", { objective: "Add subtract", engine: "codex", budgetUsd: 1 }],
    ["martin_list_runs", { limit: 5 }],
    ["martin_triage_runs", { limit: 5, includeHealthy: true }],
    ["martin_get_run", sel],
    ["martin_status", sel],
    ["martin_logs", { ...sel, limit: 5 }],
    ["martin_get_verification_results", sel],
    ["martin_run_dossier", sel],
    ["martin_dossier", { ...sel, format: "json" }],
    ["martin_dossier", { ...sel, format: "md" }],
    ["martin_eval", sel],
    ["martin_pr_summary", { ...sel, format: "md" }],
    ["martin_create_pr", { ...sel, title: "Preview only", base: "main", execute: false }],
    ["martin_review_pr", { ...sel, prBody: "Review body" }],
    ["martin_pause", { ...sel, reason: "contract test", requestedBy: "tester" }],
    ["martin_continue", { ...sel, reason: "contract test", requestedBy: "tester" }],
    ["martin_cancel", { ...sel, reason: "contract test", requestedBy: "tester" }]
  ];

  it.each(calls)("%s returns schema-valid output for %j", async (name, args) => {
    let failure = "";
    try {
      await client.callTool({ name, arguments: args });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).not.toMatch(/Structured content does not match|Unknown arguments/u);
  });
});

describe("advertised MCP output schemas", () => {
  function outputSchemaOf(name: string): Record<string, unknown> {
    const schema = tools.find((tool) => tool.name === name)?.outputSchema;
    expect(schema, `${name} advertises an output schema`).toBeDefined();
    return schema as Record<string, unknown>;
  }

  it("accepts a preflight result that carries Codex host diagnostics", async () => {
    const originalLive = process.env.MARTIN_LIVE;
    process.env.MARTIN_LIVE = "false";
    let real: Awaited<ReturnType<typeof martinPreflightTool>>;
    try {
      real = await martinPreflightTool({ objective: "Add subtract", engine: "codex", verificationPlan: ["npm test"] });
    } finally {
      if (originalLive === undefined) delete process.env.MARTIN_LIVE;
      else process.env.MARTIN_LIVE = originalLive;
    }
    // On a live Codex host the handler adds codexDiagnostics (see MartinPreflightOutput).
    const result = {
      ...real,
      execution: {
        ...real.execution,
        codexDiagnostics: {
          selectedPath: "/usr/bin/codex",
          hostPlatform: "linux",
          installKind: "npm",
          nativeInstallValid: true,
          invocationMode: "direct",
          sandboxMode: "workspace-write",
          sandboxCompatible: true,
          nativeDependencyStatus: "present",
          nativeDependencyPackage: "@openai/codex-linux-x64",
          launchReady: true,
          summary: "Codex launch probe passed.",
          remediation: "None.",
          candidateProbeResults: [
            { path: "/usr/bin/codex", installKind: "npm", invocationMode: "direct", nativeInstallValid: true, sandboxCompatible: true }
          ]
        }
      }
    };

    const outcome = validator.getValidator(outputSchemaOf("martin_preflight") as never)(result);
    expect(outcome.errorMessage ?? "").toBe("");
    expect(outcome.valid).toBe(true);
  });

  it.each([...VERIFIED_HANDOFF_OUTCOMES, null])(
    "accepts a real arcade status whose outcome is %s",
    async (outcome) => {
      const dossier = {
        loop: { loopId: "loop_contract", lifecycleState: outcome === null ? "running" : "completed", remainingBudgetUsd: 1.5 },
        budget: { maxUsd: 2, softLimitUsd: 1.5, maxIterations: 2, maxTokens: 10_000 },
        cost: { actualUsd: 0.5, avoidedUsd: 0, tokensIn: 10, tokensOut: 5, provenance: "provider_reported" },
        receiptIntegrity: { state: "verified" },
        attempts: [{ index: 1 }],
        verification: { status: "passed", warnings: [] },
        verifiedHandoff: { outcome: outcome ?? "STOPPED" },
        warnings: []
      };
      const status = await readArcadeStatus({ loopId: "loop_contract" }, async () => dossier as never);
      const result = validator.getValidator(outputSchemaOf("martin_arcade_status") as never)(status);
      expect(result.errorMessage ?? "").toBe("");
    }
  );
});
