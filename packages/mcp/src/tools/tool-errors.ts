import type { MartinErrorCategory } from "@martin/contracts";

export type ToolFailureCode =
  | "attempt_not_found"
  | "engine_unavailable"
  | "invalid_arguments"
  | "invalid_json"
  | "invalid_path"
  | "invalid_selector"
  | "no_loop_records"
  | "policy_blocked"
  | "store_unreadable"
  | "tool_execution_failed"
  | "unknown_tool"
  | "unsupported_operation";

export type ToolFailureCategory = MartinErrorCategory;

export interface ToolFailure {
  code: ToolFailureCode;
  category: ToolFailureCategory;
  message: string;
  suggestion?: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface MartinToolErrorOptions {
  category?: ToolFailureCategory;
  suggestion?: string;
  retryable?: boolean;
  exposeMessage?: boolean;
  details?: Record<string, unknown>;
}

export class MartinToolError extends Error {
  readonly code: ToolFailureCode;
  readonly category: ToolFailureCategory;
  readonly suggestion?: string;
  readonly retryable: boolean;
  readonly exposeMessage: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: ToolFailureCode, message: string, options: MartinToolErrorOptions = {}) {
    super(message);
    this.name = "MartinToolError";
    this.code = code;
    this.category = options.category ?? "transient";
    this.suggestion = options.suggestion;
    this.retryable = options.retryable ?? false;
    this.exposeMessage = options.exposeMessage ?? true;
    this.details = options.details;
  }
}

const SENSITIVE_MESSAGE_PATTERN = /([A-Za-z]:\\|\/|policy\.rego|policy\.wasm|\.pem|\.env)/u;

export function sanitizePotentiallySensitiveMessage(message: string): string {
  return SENSITIVE_MESSAGE_PATTERN.test(message) ? "Tool execution failed." : message;
}

export function sanitizeToolErrorMessage(error: unknown): string {
  if (error instanceof MartinToolError) {
    return error.exposeMessage
      ? sanitizePotentiallySensitiveMessage(error.message)
      : "Tool execution failed.";
  }

  const message = error instanceof Error ? error.message : String(error);
  return sanitizePotentiallySensitiveMessage(message);
}

export function toToolFailure(error: unknown): ToolFailure {
  if (error instanceof MartinToolError) {
    return {
      code: error.code,
      category: error.category,
      message: sanitizeToolErrorMessage(error),
      ...(error.suggestion ? { suggestion: error.suggestion } : {}),
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {})
    };
  }

  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = sanitizeToolErrorMessage(error);

  if (error instanceof SyntaxError || /JSON/u.test(rawMessage)) {
    return {
      code: "invalid_json",
      category: "invalid_input",
      message,
      suggestion: "Provide a valid JSON-serialized LoopRecord.",
      retryable: false
    };
  }

  if (/No loop records found\./u.test(rawMessage)) {
    return {
      code: "no_loop_records",
      category: "not_found",
      message: "No loop records found.",
      suggestion:
        "Run martin_run first or point file, loopId, or runsDir at a populated Martin runs location.",
      retryable: false
    };
  }

  if (/Attempt .* not found\./u.test(rawMessage)) {
    return {
      code: "attempt_not_found",
      category: "not_found",
      message,
      suggestion: "Choose a valid attemptIndex for the selected Martin run.",
      retryable: false
    };
  }

  if (/Provide exactly one/u.test(rawMessage)) {
    return {
      code: "invalid_selector",
      category: "invalid_input",
      message,
      suggestion: "Choose exactly one selector: loopJson, file, loopId, or latest.",
      retryable: false
    };
  }

  if (/Unknown tool/u.test(rawMessage)) {
    return {
      code: "unknown_tool",
      category: "invalid_input",
      message,
      suggestion: "Refresh the tool list and call one of the advertised Martin tools.",
      retryable: false
    };
  }

  if (/is not available on PATH/u.test(rawMessage)) {
    return {
      code: "engine_unavailable",
      category: "environment",
      message,
      suggestion: "Install the requested CLI or set MARTIN_LIVE=false for a no-spend proof run.",
      retryable: false
    };
  }

  if (
    /Unknown arguments/u.test(rawMessage) ||
    /Tool arguments must be an object\./u.test(rawMessage) ||
    /^Invalid /u.test(rawMessage)
  ) {
    return {
      code:
        /Invalid (allowedPaths|deniedPaths|file|loopId|runsDir|workingDirectory)\./u.test(
          rawMessage
        )
          ? "invalid_path"
          : "invalid_arguments",
      category: "invalid_input",
      message,
      suggestion: "Check the tool schema and resend only supported, in-scope values.",
      retryable: false
    };
  }

  if (/Unable to read Martin runs store\./u.test(rawMessage)) {
    return {
      code: "store_unreadable",
      category: "store_unreadable",
      message,
      suggestion: "Check runsDir permissions and confirm the selected Martin run store is readable.",
      retryable: false
    };
  }

  return {
    code: "tool_execution_failed",
    category: "transient",
    message,
    suggestion: "Review the tool inputs and environment, then retry when the underlying issue is fixed.",
    retryable: true
  };
}

export function invalidArgumentsError(message: string, suggestion?: string): MartinToolError {
  return new MartinToolError("invalid_arguments", message, {
    category: "invalid_input",
    suggestion
  });
}

export function invalidPathError(message: string, suggestion?: string): MartinToolError {
  return new MartinToolError("invalid_path", message, {
    category: "invalid_input",
    suggestion
  });
}

export function invalidSelectorError(message: string, suggestion?: string): MartinToolError {
  return new MartinToolError("invalid_selector", message, {
    category: "invalid_input",
    suggestion
  });
}

export function noLoopRecordsError(message = "No loop records found."): MartinToolError {
  return new MartinToolError("no_loop_records", message, {
    category: "not_found",
    suggestion:
      "Run martin_run first or point file, loopId, or runsDir at a populated Martin runs location."
  });
}

export function attemptNotFoundError(attemptIndex: number): MartinToolError {
  return new MartinToolError("attempt_not_found", `Attempt ${attemptIndex} not found.`, {
    category: "not_found",
    suggestion: "Choose an attemptIndex that exists in the selected Martin run."
  });
}

export function storeUnreadableError(message = "Unable to read Martin runs store."): MartinToolError {
  return new MartinToolError("store_unreadable", message, {
    category: "store_unreadable",
    suggestion: "Check runsDir permissions and confirm the selected Martin run store is readable."
  });
}

export function unsupportedOperationError(message: string, suggestion?: string): MartinToolError {
  return new MartinToolError("unsupported_operation", message, {
    category: "invalid_input",
    suggestion
  });
}
