import type { ToolFailure } from "./tool-errors.js";

interface TextContentBlock {
  type: "text";
  text: string;
}

function createJsonBlock(output: object): TextContentBlock {
  return {
    type: "text",
    text: JSON.stringify(output, null, 2)
  };
}

function resolveHumanArtifact(output: object, summary: string): string {
  const rendered = "rendered" in output ? output.rendered : undefined;
  return typeof rendered === "string" && rendered.trim().length > 0 ? rendered : summary;
}

export function createToolSuccessResult<T extends object>(
  output: T,
  summary: string
): {
  content: TextContentBlock[];
  structuredContent: T;
  _meta: Record<string, unknown>;
} {
  return {
    content: [
      { type: "text", text: resolveHumanArtifact(output, summary) },
      createJsonBlock(output)
    ],
    structuredContent: output,
    _meta: {
      "martinloop/summary": summary,
      "martinloop/contentVersion": "2026-08-18"
    }
  };
}

export function createToolErrorResult(
  failure: ToolFailure
): {
  content: TextContentBlock[];
  isError: true;
  _meta: Record<string, unknown>;
} {
  const content: TextContentBlock[] = [
    { type: "text", text: `Tool error: ${failure.message}` }
  ];

  if (failure.suggestion) {
    content.push({ type: "text", text: `Suggestion: ${failure.suggestion}` });
  }

  return {
    content,
    isError: true,
    _meta: {
      "martinloop/error": failure,
      "martinloop/errorCode": failure.code,
      "martinloop/errorCategory": failure.category,
      "martinloop/retryable": failure.retryable
    }
  };
}
