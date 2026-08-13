import {
  ALLOWED_ACTION_TYPES,
  DELIVERY_MESSAGE_SCHEMA_VERSION,
  MESSAGE_SELECTION_RESPONSE_SCHEMA_VERSION,
  type DeliveryMessage,
  type MessageSelectionResponse,
} from "@martin/contracts";

const MAX_RESPONSE_BYTES = 8_192;
const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 500;
const MAX_ID_LENGTH = 128;

const ALLOWED_ACTION_SET = new Set<string>(ALLOWED_ACTION_TYPES);

export type ValidationError =
  | "schema_version_unknown"
  | "schema_unknown_kind"
  | "schema_unknown_action_type"
  | "schema_invalid_id"
  | "schema_invalid_date"
  | "schema_invalid_cooldown"
  | "schema_url_not_https"
  | "schema_text_too_long"
  | "schema_response_too_large"
  | "schema_malformed";

export interface ParseResult {
  ok: true;
  message: DeliveryMessage | undefined;
}

export interface ParseFailure {
  ok: false;
  error: ValidationError;
  detail?: string;
}

/**
 * Parse and validate a raw response body from the message selection endpoint.
 * Returns ok:false on any violation — caller must render nothing and log the error.
 */
export function parseMessageSelectionResponse(
  raw: string
): ParseResult | ParseFailure {
  if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
    return { ok: false, error: "schema_response_too_large" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "schema_malformed" };
  }

  if (!isObject(parsed)) {
    return { ok: false, error: "schema_malformed" };
  }

  if (parsed["schemaVersion"] !== MESSAGE_SELECTION_RESPONSE_SCHEMA_VERSION) {
    return { ok: false, error: "schema_version_unknown", detail: String(parsed["schemaVersion"]) };
  }

  if (!("message" in parsed) || parsed["message"] === undefined || parsed["message"] === null) {
    return { ok: true, message: undefined };
  }

  const result = validateMessage(parsed["message"]);
  if (!result.ok) return result;

  return { ok: true, message: result.message };
}

function validateMessage(raw: unknown): ParseResult | ParseFailure {
  if (!isObject(raw)) {
    return { ok: false, error: "schema_malformed" };
  }

  if (raw["schemaVersion"] !== DELIVERY_MESSAGE_SCHEMA_VERSION) {
    return { ok: false, error: "schema_version_unknown", detail: String(raw["schemaVersion"]) };
  }

  const id = raw["id"];
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH || !/^[\w\-.:]+$/.test(id)) {
    return { ok: false, error: "schema_invalid_id" };
  }

  const kind = raw["kind"];
  if (kind !== "update" && kind !== "feedback_request" && kind !== "milestone") {
    return { ok: false, error: "schema_unknown_kind", detail: String(kind) };
  }

  const revision = raw["revision"];
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) {
    return { ok: false, error: "schema_malformed", detail: "revision" };
  }

  const title = raw["title"];
  if (typeof title !== "string" || title.length === 0 || title.length > MAX_TITLE_LENGTH) {
    return { ok: false, error: "schema_text_too_long", detail: "title" };
  }

  const body = raw["body"];
  if (typeof body !== "string" || body.length === 0 || body.length > MAX_BODY_LENGTH) {
    return { ok: false, error: "schema_text_too_long", detail: "body" };
  }

  const action = raw["action"];
  if (!isObject(action)) {
    return { ok: false, error: "schema_malformed", detail: "action" };
  }

  const actionType = action["type"];
  if (typeof actionType !== "string" || !ALLOWED_ACTION_SET.has(actionType)) {
    return { ok: false, error: "schema_unknown_action_type", detail: String(actionType) };
  }

  if ("url" in action && action["url"] !== undefined) {
    if (typeof action["url"] !== "string" || !action["url"].startsWith("https://")) {
      return { ok: false, error: "schema_url_not_https" };
    }
  }

  if ("targetVersion" in action && action["targetVersion"] !== undefined) {
    if (typeof action["targetVersion"] !== "string") {
      return { ok: false, error: "schema_malformed", detail: "targetVersion" };
    }
  }

  const expiresAt = raw["expiresAt"];
  if (typeof expiresAt !== "string" || isNaN(Date.parse(expiresAt))) {
    return { ok: false, error: "schema_invalid_date", detail: "expiresAt" };
  }

  const cooldownHours = raw["cooldownHours"];
  if (
    typeof cooldownHours !== "number" ||
    !Number.isFinite(cooldownHours) ||
    cooldownHours < 0 ||
    cooldownHours > 8760
  ) {
    return { ok: false, error: "schema_invalid_cooldown" };
  }

  const message: DeliveryMessage = {
    schemaVersion: DELIVERY_MESSAGE_SCHEMA_VERSION,
    id,
    revision,
    kind,
    title,
    body,
    action: {
      type: actionType as DeliveryMessage["action"]["type"],
      ...(action["url"] !== undefined ? { url: action["url"] as string } : {}),
      ...(action["targetVersion"] !== undefined ? { targetVersion: action["targetVersion"] as string } : {}),
    },
    expiresAt,
    cooldownHours,
  };

  return { ok: true, message };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
