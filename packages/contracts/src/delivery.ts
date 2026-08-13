/**
 * R4 Delivery — M1 Contract
 *
 * Shared with Lane B (Control Plane). Do not modify unilaterally.
 * The server selects one message; the client never downloads the catalog.
 */

export const DELIVERY_MESSAGE_SCHEMA_VERSION = "delivery-message/1" as const;
export const DELIVERY_RECORD_SCHEMA_VERSION = "delivery-record/1" as const;
export const MESSAGE_SELECTION_RESPONSE_SCHEMA_VERSION = "martin-message-selection/1" as const;

export const ALLOWED_ACTION_TYPES = [
  "upgrade_cli",
  "upgrade_mcp",
  "submit_feedback",
  "open_release_notes",
  "dismiss",
  "view_spend_report",
  "view_run_explain",
] as const;

export type ActionType = (typeof ALLOWED_ACTION_TYPES)[number];

export type MessageKind = "update" | "feedback_request" | "milestone";

export interface DeliveryMessage {
  schemaVersion: typeof DELIVERY_MESSAGE_SCHEMA_VERSION;
  id: string;
  revision: number;
  kind: MessageKind;
  title: string;
  body: string;
  action: {
    type: ActionType;
    url?: string;
    targetVersion?: string;
  };
  expiresAt: string;
  cooldownHours: number;
}

export interface MessageSelectionResponse {
  schemaVersion: typeof MESSAGE_SELECTION_RESPONSE_SCHEMA_VERSION;
  message?: DeliveryMessage;
}

/** Local cooldown/dismissal state — persisted in .martin/delivery-record.json */
export interface DeliveryRecord {
  schemaVersion: typeof DELIVERY_RECORD_SCHEMA_VERSION;
  lastMessageId?: string;
  lastShownAtEpochMs?: number;
  dismissedIds: string[];
  cooldownUntilEpochMs?: number;
  cachedMessage?: DeliveryMessage;
  cachedAtEpochMs?: number;
}

/** Structured update field for --json and MCP responses */
export interface UpdateAvailableField {
  targetVersion: string;
  kind: "cli" | "mcp";
  message?: string;
}
