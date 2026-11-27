const RESERVED_LIVE_MODEL_SENTINELS = new Set([
  "auto",
  "proof",
  "stub",
  "fallback",
  "simulation",
  "default",
]);

export type ConcreteLiveModelRejectionReason =
  | "model_required"
  | "model_must_be_string"
  | "model_outer_whitespace"
  | "model_reserved_sentinel";

export type ConcreteLiveModelValidation =
  | { valid: true; model: string }
  | { valid: false; reason: ConcreteLiveModelRejectionReason };

/**
 * Validate an explicit live-model identifier without normalizing accepted input.
 *
 * Lower-casing and trimming are used only to decide whether a value is invalid.
 * A valid model identifier is returned byte-for-byte as supplied.
 */
export function validateConcreteLiveModel(value: unknown): ConcreteLiveModelValidation {
  if (value === undefined || value === null || value === "") {
    return { valid: false, reason: "model_required" };
  }
  if (typeof value !== "string") {
    return { valid: false, reason: "model_must_be_string" };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: "model_required" };
  }
  if (trimmed !== value) {
    return { valid: false, reason: "model_outer_whitespace" };
  }
  if (RESERVED_LIVE_MODEL_SENTINELS.has(trimmed.toLowerCase())) {
    return { valid: false, reason: "model_reserved_sentinel" };
  }

  return { valid: true, model: value };
}

export function assertConcreteLiveModel(value: unknown): string {
  const result = validateConcreteLiveModel(value);
  if (!result.valid) {
    throw new TypeError(`Explicit live model is invalid: ${result.reason}`);
  }
  return result.model;
}
