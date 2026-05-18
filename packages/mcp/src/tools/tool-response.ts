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

export function createToolSuccessResult<T extends object>(
  output: T,
  summary: string
): {
  content: TextContentBlock[];
  structuredContent: T;
  _meta: Record<string, unknown>;
} {
  return {
    content: [createJsonBlock(output), { type: "text", text: summary }],
    structuredContent: output,
    _meta: {
      "martinloop/summary": summary,
      "martinloop/contentVersion": "2026-05-15"
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
