export const EXTERNAL_OUTCOME_SCHEMA_VERSION = "external-outcome/1" as const;
export const EXTERNAL_OUTCOME_RESULT_SCHEMA_VERSION = "external-outcome-result/1" as const;

export const EXTERNAL_OUTCOME_LIMITS = Object.freeze({
  maxActions: 100,
  maxAssertionsPerAction: 50,
  maxContractBytes: 256 * 1024,
  maxResponseBytes: 1024 * 1024,
  maxDeadlineMs: 30_000,
  maxConcurrency: 4,
});

export type ExternalOutcomeJsonScalar = string | number | boolean | null;
export type ExternalOutcomeStatus = "passed" | "failed" | "unknown";
export type ExternalOutcomeReasonCode =
  | "passed"
  | "record_missing"
  | "value_mismatch"
  | "wrong_identity"
  | "duplicate_record"
  | "stale_record"
  | "source_unavailable"
  | "auth_denied"
  | "invalid_response"
  | "response_too_large"
  | "redirect_blocked"
  | "deadline_exceeded"
  | "cancelled";

export interface ExternalOutcomeExpectation {
  pointer: string;
  equals: ExternalOutcomeJsonScalar;
}

export interface ExternalOutcomeFreshness {
  pointer: string;
  notEquals?: ExternalOutcomeJsonScalar;
  notBefore?: string;
}

export interface ExternalOutcomeActionContract {
  actionId: string;
  claimedDone: boolean;
  source: {
    url: string;
    authEnv?: string;
  };
  recordPointer: string;
  identity: ExternalOutcomeExpectation;
  expectedCount: number;
  assertions: ExternalOutcomeExpectation[];
  freshness?: ExternalOutcomeFreshness;
}

export interface ExternalOutcomeContract {
  schemaVersion: typeof EXTERNAL_OUTCOME_SCHEMA_VERSION;
  contractId: string;
  allowedOrigins: string[];
  deadlineMs: number;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  actions: ExternalOutcomeActionContract[];
}

export interface ExternalOutcomeAssertionResult {
  pointer: string;
  passed: boolean;
  reasonCode: "passed" | "missing_pointer" | "value_mismatch" | "stale_record";
}

export interface ExternalOutcomeActionResult {
  actionId: string;
  claimedDone: boolean;
  status: ExternalOutcomeStatus;
  reasonCode: ExternalOutcomeReasonCode;
  observationCount: number;
  firstObservedAt?: string;
  lastObservedAt?: string;
  elapsedMs: number;
  source: {
    origin: string;
  };
  assertions: ExternalOutcomeAssertionResult[];
}

export interface ExternalOutcomeEvidenceReference {
  kind: "external_outcome";
  contractId: string;
  sha256: string;
  path: string;
}

export interface ExternalOutcomeResult {
  schemaVersion: typeof EXTERNAL_OUTCOME_RESULT_SCHEMA_VERSION;
  contractId: string;
  contractSha256: string;
  startedAt: string;
  completedAt: string;
  binding?: {
    runId?: string;
    attemptId?: string;
    workspaceId?: string;
  };
  aggregate: {
    claimedDone: number;
    checked: number;
    passed: number;
    failed: number;
    unknown: number;
    rejectedClaimRate: number;
    unknownClaimRate: number;
    coverage: number;
  };
  actions: ExternalOutcomeActionResult[];
}

export interface ExternalOutcomeValidationError {
  path: string;
  message: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function validateExternalOutcomeContract(value: unknown): ExternalOutcomeValidationError[] {
  const errors: ExternalOutcomeValidationError[] = [];
  if (!isRecord(value)) return [{ path: "", message: "contract must be an object" }];

  let encodedBytes = Number.POSITIVE_INFINITY;
  try {
    encodedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    errors.push({ path: "", message: "contract must be JSON-serializable" });
  }
  if (encodedBytes > EXTERNAL_OUTCOME_LIMITS.maxContractBytes) {
    errors.push({ path: "", message: `contract exceeds ${EXTERNAL_OUTCOME_LIMITS.maxContractBytes} bytes` });
  }

  if (value.schemaVersion !== EXTERNAL_OUTCOME_SCHEMA_VERSION) {
    errors.push({ path: "schemaVersion", message: `must equal ${EXTERNAL_OUTCOME_SCHEMA_VERSION}` });
  }
  validateId(value.contractId, "contractId", errors);

  if (!Array.isArray(value.allowedOrigins) || value.allowedOrigins.length === 0) {
    errors.push({ path: "allowedOrigins", message: "at least one allowed origin is required" });
  } else {
    const seen = new Set<string>();
    value.allowedOrigins.forEach((origin, index) => {
      if (typeof origin !== "string") {
        errors.push({ path: `allowedOrigins[${index}]`, message: "must be a URL origin string" });
        return;
      }
      try {
        const parsed = new URL(origin);
        if ((parsed.protocol !== "https:" && parsed.protocol !== "http:")
          || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash
          || parsed.origin !== origin.replace(/\/$/u, "")) {
          errors.push({ path: `allowedOrigins[${index}]`, message: "must be a canonical http(s) origin without path, query, fragment, or credentials" });
          return;
        }
        if (seen.has(parsed.origin)) errors.push({ path: `allowedOrigins[${index}]`, message: "duplicate origin" });
        seen.add(parsed.origin);
      } catch {
        errors.push({ path: `allowedOrigins[${index}]`, message: "must be a valid URL origin" });
      }
    });
  }

  validateInteger(value.deadlineMs, "deadlineMs", 1, EXTERNAL_OUTCOME_LIMITS.maxDeadlineMs, errors);
  validateInteger(value.pollIntervalMs, "pollIntervalMs", 25, EXTERNAL_OUTCOME_LIMITS.maxDeadlineMs, errors);
  validateInteger(value.requestTimeoutMs, "requestTimeoutMs", 25, EXTERNAL_OUTCOME_LIMITS.maxDeadlineMs, errors);
  if (typeof value.deadlineMs === "number" && typeof value.pollIntervalMs === "number" && value.pollIntervalMs > value.deadlineMs) {
    errors.push({ path: "pollIntervalMs", message: "must not exceed deadlineMs" });
  }
  if (typeof value.deadlineMs === "number" && typeof value.requestTimeoutMs === "number" && value.requestTimeoutMs > value.deadlineMs) {
    errors.push({ path: "requestTimeoutMs", message: "must not exceed deadlineMs" });
  }

  if (!Array.isArray(value.actions) || value.actions.length === 0) {
    errors.push({ path: "actions", message: "at least one action is required" });
    return errors;
  }
  if (value.actions.length > EXTERNAL_OUTCOME_LIMITS.maxActions) {
    errors.push({ path: "actions", message: `must contain at most ${EXTERNAL_OUTCOME_LIMITS.maxActions} actions` });
  }

  const actionIds = new Set<string>();
  if (!value.actions.some((candidate) => isRecord(candidate) && candidate.claimedDone === true)) {
    errors.push({ path: "actions", message: "at least one action must have claimedDone=true" });
  }
  value.actions.forEach((candidate, index) => {
    const base = `actions[${index}]`;
    if (!isRecord(candidate)) {
      errors.push({ path: base, message: "must be an object" });
      return;
    }
    validateId(candidate.actionId, `${base}.actionId`, errors);
    if (typeof candidate.actionId === "string") {
      if (actionIds.has(candidate.actionId)) errors.push({ path: `${base}.actionId`, message: "must be unique" });
      actionIds.add(candidate.actionId);
    }
    if (typeof candidate.claimedDone !== "boolean") errors.push({ path: `${base}.claimedDone`, message: "must be boolean" });

    if (!isRecord(candidate.source)) {
      errors.push({ path: `${base}.source`, message: "must be an object" });
    } else {
      if (typeof candidate.source.url !== "string") {
        errors.push({ path: `${base}.source.url`, message: "must be a URL string" });
      } else {
        try {
          const parsed = new URL(candidate.source.url);
          if (!["https:", "http:"].includes(parsed.protocol)) errors.push({ path: `${base}.source.url`, message: "only http(s) read-back URLs are supported" });
          if (parsed.username || parsed.password) errors.push({ path: `${base}.source.url`, message: "URL credentials are forbidden" });
          if (parsed.search) errors.push({ path: `${base}.source.url`, message: "query strings are forbidden; use path identity and authEnv instead" });
          if (parsed.hash) errors.push({ path: `${base}.source.url`, message: "URL fragments are forbidden" });
          if (Array.isArray(value.allowedOrigins) && !value.allowedOrigins.map((item) => {
            try { return new URL(String(item)).origin; } catch { return ""; }
          }).includes(parsed.origin)) {
            errors.push({ path: `${base}.source.url`, message: "origin is not present in allowedOrigins" });
          }
        } catch {
          errors.push({ path: `${base}.source.url`, message: "must be a valid URL" });
        }
      }
      if (candidate.source.authEnv !== undefined && (typeof candidate.source.authEnv !== "string" || !ENV_NAME.test(candidate.source.authEnv))) {
        errors.push({ path: `${base}.source.authEnv`, message: "must be a valid environment variable name" });
      }
    }

    validatePointer(candidate.recordPointer, `${base}.recordPointer`, errors);
    validateExpectation(candidate.identity, `${base}.identity`, errors);
    validateInteger(candidate.expectedCount, `${base}.expectedCount`, 1, EXTERNAL_OUTCOME_LIMITS.maxActions, errors);

    if (!Array.isArray(candidate.assertions)) {
      errors.push({ path: `${base}.assertions`, message: "must be an array" });
    } else {
      if (candidate.assertions.length > EXTERNAL_OUTCOME_LIMITS.maxAssertionsPerAction) {
        errors.push({ path: `${base}.assertions`, message: `must contain at most ${EXTERNAL_OUTCOME_LIMITS.maxAssertionsPerAction} assertions` });
      }
      candidate.assertions.forEach((assertion, assertionIndex) => validateExpectation(assertion, `${base}.assertions[${assertionIndex}]`, errors));
    }

    if (candidate.freshness !== undefined) {
      if (!isRecord(candidate.freshness)) {
        errors.push({ path: `${base}.freshness`, message: "must be an object" });
      } else {
        validatePointer(candidate.freshness.pointer, `${base}.freshness.pointer`, errors);
        const hasNotEquals = Object.prototype.hasOwnProperty.call(candidate.freshness, "notEquals");
        const hasNotBefore = candidate.freshness.notBefore !== undefined;
        if (!hasNotEquals && !hasNotBefore) errors.push({ path: `${base}.freshness`, message: "must define notEquals or notBefore" });
        if (hasNotEquals && !isScalar(candidate.freshness.notEquals)) errors.push({ path: `${base}.freshness.notEquals`, message: "must be a JSON scalar" });
        if (hasNotBefore && (typeof candidate.freshness.notBefore !== "string" || !isCanonicalIso(candidate.freshness.notBefore))) {
          errors.push({ path: `${base}.freshness.notBefore`, message: "must be a canonical ISO timestamp" });
        }
      }
    }
  });

  return errors;
}

export function resolveExternalOutcomeJsonPointer(value: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (!isValidPointer(pointer)) return { found: false };
  if (pointer === "") return { found: true, value };
  let current: unknown = value;
  for (const raw of pointer.slice(1).split("/")) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) return { found: false };
      const index = Number(segment);
      if (index >= current.length) return { found: false };
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return { found: false };
    current = current[segment];
  }
  return { found: true, value: current };
}

export function externalOutcomeValuesEqual(left: unknown, right: ExternalOutcomeJsonScalar): boolean {
  return isScalar(left) && typeof left === typeof right && Object.is(left, right);
}

function validateExpectation(value: unknown, path: string, errors: ExternalOutcomeValidationError[]): void {
  if (!isRecord(value)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  validatePointer(value.pointer, `${path}.pointer`, errors);
  if (!Object.prototype.hasOwnProperty.call(value, "equals") || !isScalar(value.equals)) {
    errors.push({ path: `${path}.equals`, message: "must be a JSON scalar" });
  }
}

function validatePointer(value: unknown, path: string, errors: ExternalOutcomeValidationError[]): void {
  if (typeof value !== "string" || !isValidPointer(value)) errors.push({ path, message: "must be an RFC 6901 JSON Pointer" });
}

function isValidPointer(value: string): boolean {
  if (value === "") return true;
  if (!value.startsWith("/")) return false;
  return !/(?:~(?![01]))/u.test(value);
}

function validateId(value: unknown, path: string, errors: ExternalOutcomeValidationError[]): void {
  if (typeof value !== "string" || !SAFE_ID.test(value)) errors.push({ path, message: "must be a stable 1-128 character identifier" });
}

function validateInteger(value: unknown, path: string, min: number, max: number, errors: ExternalOutcomeValidationError[]): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    errors.push({ path, message: `must be an integer between ${min} and ${max}` });
  }
}

function isCanonicalIso(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isScalar(value: unknown): value is ExternalOutcomeJsonScalar {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
