import { type DeliveryMessage } from "@martin/contracts";
import { parseMessageSelectionResponse } from "./message-schema.js";

const DEFAULT_ENDPOINT = "https://api.martinloop.com/v1/messages/select";
const REQUEST_TIMEOUT_MS = 4_000;

export interface MessageSelectRequest {
  installId?: string;
  clientVersion: string;
  clientKind: "cli" | "mcp";
  /** Enum signal — never a transcript or raw content */
  trigger?: "first_verified_run" | "milestone_reached" | "version_check";
}

export interface MessageClientOptions {
  endpoint?: string;
  timeoutMs?: number;
}

/**
 * Fetch a server-selected message from the Control Plane.
 * Returns null on any network failure, timeout, or validation error.
 * Never throws — the primary command must never be affected.
 */
export async function fetchSelectedMessage(
  request: MessageSelectRequest,
  options: MessageClientOptions = {}
): Promise<DeliveryMessage | null> {
  const endpoint = options.endpoint ?? process.env["MARTIN_MESSAGE_ENDPOINT"] ?? DEFAULT_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  let controller: AbortController | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    controller = new AbortController();
    timeoutId = setTimeout(() => controller!.abort(), timeoutMs);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const raw = await response.text();
    const result = parseMessageSelectionResponse(raw);
    if (!result.ok) return null;

    return result.message ?? null;
  } catch {
    return null;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
