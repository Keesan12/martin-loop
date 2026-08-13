// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import path from "node:path";
import { martinFilePath } from "./home-dir.js";

export interface RemoteExperienceV1 {
  schemaVersion: 1;
  id: string;
  class: "required" | "engagement";
  type:
    | "security_notice"
    | "migration_notice"
    | "update_notice"
    | "announcement"
    | "beta_invite"
    | "dashboard_invite"
    | "design_partner_invite";
  title: string;
  body: string;
  action?: { label: string; url: string };
  expiresAt?: string;
  cooldownKey: string;
}

/**
 * Generic request fields always sent.
 * When telemetry is disabled or installId is null, only these fields are included.
 * Never includes sessionId, run counts, repo data, scores, or workspace identifiers.
 */
export interface RemoteExperienceRequest {
  schemaVersion: 1;
  cliVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  /** Only included when telemetry is active and installId is available. */
  installId?: string;
}

const REMOTE_TYPES = new Set([
  "security_notice",
  "migration_notice",
  "update_notice",
  "announcement",
  "beta_invite",
  "dashboard_invite",
  "design_partner_invite",
]);

const REMOTE_ACTION_HOSTS = new Set([
  "martinloop.com",
  "www.martinloop.com",
  "app.martinloop.com",
]);

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
}

export function parseRemoteExperience(
  value: unknown,
  nowMs = Date.now()
): RemoteExperienceV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const input = value as Record<string, unknown>;

  if (input.schemaVersion !== 1) return null;
  if (typeof input.id !== "string" || input.id.length > 128) return null;
  if (input.class !== "required" && input.class !== "engagement") return null;
  if (typeof input.type !== "string" || !REMOTE_TYPES.has(input.type)) return null;
  if (typeof input.title !== "string" || input.title.length > 120) return null;
  if (typeof input.body !== "string" || input.body.length > 1200) return null;
  if (hasControlCharacters(input.title) || hasControlCharacters(input.body)) return null;
  if (typeof input.cooldownKey !== "string" || input.cooldownKey.length > 128) return null;

  let expiresAt: string | undefined;
  if (input.expiresAt !== undefined) {
    if (typeof input.expiresAt !== "string") return null;
    const parsed = Date.parse(input.expiresAt);
    if (!Number.isFinite(parsed) || parsed <= nowMs) return null;
    expiresAt = input.expiresAt;
  }

  let action: RemoteExperienceV1["action"];
  if (input.action !== undefined) {
    if (!input.action || typeof input.action !== "object" || Array.isArray(input.action)) return null;
    const raw = input.action as Record<string, unknown>;
    if (typeof raw.label !== "string" || raw.label.length > 80 || typeof raw.url !== "string") return null;
    let parsedUrl: URL;
    try { parsedUrl = new URL(raw.url); } catch { return null; }
    if (parsedUrl.protocol !== "https:" || !REMOTE_ACTION_HOSTS.has(parsedUrl.hostname)) return null;
    action = { label: raw.label, url: raw.url };
  }

  return {
    schemaVersion: 1,
    id: input.id,
    class: input.class,
    type: input.type as RemoteExperienceV1["type"],
    title: input.title,
    body: input.body,
    cooldownKey: input.cooldownKey,
    ...(expiresAt ? { expiresAt } : {}),
    ...(action ? { action } : {}),
  };
}

// ─── Endpoint ─────────────────────────────────────────────────────────────────

/**
 * Returns the remote-experience endpoint (separate from product-events telemetry).
 * Configured via MARTIN_REMOTE_EXPERIENCE_ENDPOINT. Returns "" when not set.
 * fetchRemoteExperience returns null when the endpoint is empty.
 */
export function resolveRemoteExperienceEndpoint(): string {
  return process.env["MARTIN_REMOTE_EXPERIENCE_ENDPOINT"]?.trim() ?? "";
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

export async function fetchRemoteExperience(
  request: Readonly<RemoteExperienceRequest>,
  options: { endpoint: string; timeoutMs?: number; fetchImpl?: typeof fetch }
): Promise<RemoteExperienceV1 | null> {
  if (!options.endpoint) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 1500);

  try {
    const response = await (options.fetchImpl ?? fetch)(options.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": `MartinLoop-CLI/${request.cliVersion}`,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) return null;
    const body = await response.json();
    return parseRemoteExperience(body);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Delivery ledger ──────────────────────────────────────────────────────────

const DELIVERY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface DeliveryLedger {
  schemaVersion: 1;
  deliveries: Record<string, number>; // cooldownKey → epoch ms
  dismissed: Record<string, true>;    // dismissKey → permanent suppression
}

function deliveryLedgerPath(): string {
  return martinFilePath("remote-experience-delivered.json");
}

async function readDeliveryLedger(): Promise<DeliveryLedger> {
  try {
    const raw = await fs.readFile(deliveryLedgerPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DeliveryLedger>;
    if (parsed.schemaVersion !== 1 || !parsed.deliveries || typeof parsed.deliveries !== "object") {
      return { schemaVersion: 1, deliveries: {}, dismissed: {} };
    }
    return {
      schemaVersion: 1,
      deliveries: parsed.deliveries,
      dismissed: (parsed.dismissed && typeof parsed.dismissed === "object" && !Array.isArray(parsed.dismissed))
        ? parsed.dismissed as Record<string, true>
        : {},
    };
  } catch {
    return { schemaVersion: 1, deliveries: {}, dismissed: {} };
  }
}

async function writeDeliveryLedger(ledger: DeliveryLedger): Promise<void> {
  const target = deliveryLedgerPath();
  const directory = path.dirname(target);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  await fs.rename(temporary, target);
}

/**
 * Returns true when the cooldownKey was delivered within the cooldown window.
 * Safe to call even if the ledger file does not exist.
 */
export async function isRemoteExperienceOnCooldown(
  cooldownKey: string,
  nowMs = Date.now()
): Promise<boolean> {
  const ledger = await readDeliveryLedger();
  const deliveredAt = ledger.deliveries[cooldownKey];
  return typeof deliveredAt === "number" && nowMs - deliveredAt < DELIVERY_COOLDOWN_MS;
}

/**
 * Records that an experience was delivered. Call AFTER the experience has been
 * displayed to the user — never at fetch or selection time.
 */
export async function recordRemoteExperienceDelivered(
  cooldownKey: string,
  nowMs = Date.now()
): Promise<void> {
  try {
    const ledger = await readDeliveryLedger();
    ledger.deliveries[cooldownKey] = nowMs;
    await writeDeliveryLedger(ledger);
  } catch { /* delivery recording failures must never affect the run result */ }
}

/**
 * Returns true when the dismissKey has been permanently dismissed (user pressed N).
 */
export async function isRemoteExperienceDismissed(dismissKey: string): Promise<boolean> {
  const ledger = await readDeliveryLedger();
  return ledger.dismissed[dismissKey] === true;
}

/**
 * Permanently suppresses an experience by dismissKey. Used when the user presses N.
 * Does not affect required notices.
 */
export async function recordRemoteExperienceDismissed(dismissKey: string): Promise<void> {
  try {
    const ledger = await readDeliveryLedger();
    ledger.dismissed[dismissKey] = true;
    await writeDeliveryLedger(ledger);
  } catch { /* dismissal recording failures must never affect the run result */ }
}
