import type { GetPromptResult, ListPromptsResult } from "@modelcontextprotocol/sdk/types.js";

export function listMartinPrompts(): ListPromptsResult["prompts"] {
  return [
    {
      name: "martin_review_run",
      description: "Review a Martin Loop run for governance, verification, and release-readiness evidence.",
      arguments: [
        {
          name: "loopId",
          description: "Run loopId to review.",
          required: true
        },
        {
          name: "objective",
          description: "Review objective or release question.",
          required: false
        }
      ]
    },
    {
      name: "martin_triage_failures",
      description: "Triage failed Martin runs and propose the next safest bounded action.",
      arguments: [
        {
          name: "loopId",
          description: "Optional run loopId to triage. If omitted, use latest run resources.",
          required: false
        }
      ]
    }
  ];
}

export function getMartinPrompt(name: string, args: Record<string, unknown> = {}): GetPromptResult {
  if (name === "martin_review_run") {
    const loopId = requireOptionalText(args.loopId, "loopId") ?? "latest";
    const objective = requireOptionalText(args.objective, "objective") ?? "Assess whether the run is safe to ship.";
    return {
      description: "Review Martin Loop run evidence.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Review Martin Loop run ${loopId}.`,
              `Objective: ${objective}`,
              "Use martin://runs/{loopId}, martin://runs/{loopId}/verification, and the read-only tools before making a shipping recommendation.",
              "Call out missing verifier proof, budget pressure, safety-leash violations, and whether human review is required."
            ].join("\n")
          }
        }
      ]
    };
  }

  if (name === "martin_triage_failures") {
    const loopId = requireOptionalText(args.loopId, "loopId") ?? "latest";
    return {
      description: "Triage failed Martin Loop evidence.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Triage Martin Loop run ${loopId}.`,
              "Use the run dossier, attempt evidence, and verification results.",
              "Return the smallest safe next action and do not suggest re-running until the failure class and verifier evidence are clear."
            ].join("\n")
          }
        }
      ]
    };
  }

  throw new Error("Unknown prompt.");
}

function requireOptionalText(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${name}.`);
  }
  return value.trim();
}
