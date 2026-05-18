import type { MartinErrorCategory, MartinOutputMode } from "@martin/contracts";

const EXIT_CODES: Record<MartinErrorCategory, number> = {
  invalid_input: 2,
  environment: 3,
  auth: 4,
  not_found: 5,
  store_unreadable: 6,
  verification_failed: 7,
  policy_blocked: 8,
  budget_exit: 9,
  transient: 10
};

export interface CliFailurePayload {
  ok: false;
  category: MartinErrorCategory;
  message: string;
  suggestion?: string;
  details?: Record<string, unknown>;
}

export interface CliSuccessPayload<T = unknown> {
  ok: true;
  data: T;
  warnings?: string[];
}

export interface CliRenderInput<T = unknown> {
  data: T;
  human: string | string[];
  quiet?: string;
  warnings?: string[];
}

export class CliCommandError extends Error {
  readonly category: MartinErrorCategory;
  readonly suggestion?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    category: MartinErrorCategory,
    message: string,
    options: {
      suggestion?: string;
      details?: Record<string, unknown>;
    } = {}
  ) {
    super(message);
    this.name = "CliCommandError";
    this.category = category;
    this.suggestion = options.suggestion;
    this.details = options.details;
  }
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function renderCliSuccess(
  mode: MartinOutputMode,
  input: CliRenderInput
): { exitCode: number; stdout: string; stderr: string } {
  if (mode === "json") {
    const payload =
      typeof input.data === "object" && input.data !== null
        ? {
            ...input.data,
            ...(input.warnings?.length ? { warnings: input.warnings } : {})
          }
        : {
            data: input.data,
            ...(input.warnings?.length ? { warnings: input.warnings } : {})
          };
    return {
      exitCode: 0,
      stdout: formatJson(payload),
      stderr: ""
    };
  }

  if (mode === "quiet") {
    return {
      exitCode: 0,
      stdout: input.quiet ?? "",
      stderr: ""
    };
  }

  const lines = Array.isArray(input.human) ? input.human : [input.human];
  const warnings = input.warnings?.map((warning) => `Warning: ${warning}`) ?? [];
  return {
    exitCode: 0,
    stdout: [...lines, ...(warnings.length > 0 ? ["", ...warnings] : [])].join("\n"),
    stderr: ""
  };
}

export function renderCliError(
  mode: MartinOutputMode,
  error: unknown
): { exitCode: number; stdout: string; stderr: string } {
  const failure = toCliFailurePayload(error);

  if (mode === "json") {
    return {
      exitCode: EXIT_CODES[failure.category],
      stdout: formatJson(failure),
      stderr: ""
    };
  }

  const message = failure.suggestion
    ? `Error [${failure.category}]: ${failure.message}\nSuggestion: ${failure.suggestion}`
    : `Error [${failure.category}]: ${failure.message}`;

  return {
    exitCode: EXIT_CODES[failure.category],
    stdout: "",
    stderr: message
  };
}

function toCliFailurePayload(error: unknown): CliFailurePayload {
  if (error instanceof CliCommandError) {
    return {
      ok: false,
      category: error.category,
      message: error.message,
      ...(error.suggestion ? { suggestion: error.suggestion } : {}),
      ...(error.details ? { details: error.details } : {})
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    category: "transient",
    message
  };
}
