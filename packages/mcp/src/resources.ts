import type {
  ListResourceTemplatesResult,
  ListResourcesResult,
  ReadResourceResult
} from "@modelcontextprotocol/sdk/types.js";

import { buildRunDossier, getAttempt, listRunSummaries, loadSelectedRun } from "./tools/cockpit-support.js";
import { getVerificationResultsTool } from "./tools/get-verification-results.js";

export interface ResourceReadOptions {
  runsDir?: string;
}

export function listMartinResources(): ListResourcesResult["resources"] {
  return [
    {
      uri: "martin://runs/summary",
      name: "Martin run summary",
      description: "Read-only summary of recent governed Martin Loop runs.",
      mimeType: "application/json"
    },
    {
      uri: "martin://runs/latest",
      name: "Latest Martin run",
      description: "Read-only dossier for the newest run in the local run store.",
      mimeType: "application/json"
    }
  ];
}

export function listMartinResourceTemplates(): ListResourceTemplatesResult["resourceTemplates"] {
  return [
    {
      uriTemplate: "martin://runs/{loopId}",
      name: "Martin run dossier",
      description: "Read-only run dossier by loopId.",
      mimeType: "application/json"
    },
    {
      uriTemplate: "martin://runs/{loopId}/attempts/{attemptIndex}",
      name: "Martin run attempt",
      description: "Read-only attempt evidence for a run.",
      mimeType: "application/json"
    },
    {
      uriTemplate: "martin://runs/{loopId}/verification",
      name: "Martin verification results",
      description: "Verifier results extracted from a run ledger.",
      mimeType: "application/json"
    }
  ];
}

export async function readMartinResource(uri: string, options: ResourceReadOptions = {}): Promise<ReadResourceResult> {
  const parsed = new URL(uri);
  if (parsed.protocol !== "martin:") {
    throw new Error("Unsupported resource URI.");
  }

  const segments = parsed.pathname.split("/").filter(Boolean);

  if (parsed.hostname === "runs" && segments.length === 1 && segments[0] === "summary") {
    return asJsonResource(uri, await listRunSummaries({ runsDir: options.runsDir }));
  }

  if (parsed.hostname === "runs" && segments.length === 1 && segments[0] === "latest") {
    const loop = await loadSelectedRun({ latest: true, runsDir: options.runsDir });
    return asJsonResource(uri, buildRunDossier(loop));
  }

  if (parsed.hostname !== "runs" || segments.length < 1) {
    throw new Error("Unknown resource URI.");
  }

  const [loopId, child, attemptIndex] = segments;
  if (!loopId || !/^[A-Za-z0-9._-]+$/u.test(loopId)) {
    throw new Error("Invalid loopId.");
  }

  if (!child) {
    const loop = await loadSelectedRun({ loopId, runsDir: options.runsDir });
    return asJsonResource(uri, buildRunDossier(loop));
  }

  if (child === "attempts") {
    const parsedAttempt = Number(attemptIndex);
    if (!Number.isInteger(parsedAttempt) || parsedAttempt <= 0) {
      throw new Error("Invalid attemptIndex.");
    }
    const loop = await loadSelectedRun({ loopId, runsDir: options.runsDir });
    return asJsonResource(uri, getAttempt(loop, parsedAttempt));
  }

  if (child === "verification") {
    return asJsonResource(uri, await getVerificationResultsTool({ loopId, runsDir: options.runsDir }));
  }

  throw new Error("Unknown resource URI.");
}

function asJsonResource(uri: string, value: unknown): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}
