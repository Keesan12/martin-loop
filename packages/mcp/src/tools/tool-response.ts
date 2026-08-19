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

export interface ToolSuccessRenderOptions {
  /** Explicit human-readable Markdown for content[0].
   *  Overrides resolveHumanArtifact fallback when provided. */
  human?: string;
  /** Include compatibility JSON block in content[]. Default: true.
   *  Set false only after real-host testing proves structuredContent alone suffices. */
  includeCompatibilityJson?: boolean;
}

export function createToolSuccessResult<T extends object>(
  output: T,
  summary: string,
  options: ToolSuccessRenderOptions = {}
): {
  content: TextContentBlock[];
  structuredContent: T;
  _meta: Record<string, unknown>;
} {
  const humanText = options.human ?? resolveHumanArtifact(output, summary);
  const content: TextContentBlock[] = [{ type: "text", text: humanText }];
  if (options.includeCompatibilityJson !== false) {
    content.push(createJsonBlock(output));
  }
  return {
    content,
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
