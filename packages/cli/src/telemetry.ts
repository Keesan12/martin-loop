// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { martinFilePath } from "./home-dir.js";

// ─── State ────────────────────────────────────────────────────────────────────

export interface TelemetryConfigV1 {
  schemaVersion: 1;
  enabled: boolean;
  noticeShown: boolean;
  installId: string | null;
  initializedEventSent: boolean;
  /** Whether the user has made an explicit preference choice (on/off command). */
  userChoseExplicitly: boolean;
}

// Telemetry is ON by default (opt-out model). No event is sent until the
// one-time disclosure has been shown on an interactive terminal. The user
// may disable at any time via `martin telemetry off` or the kill-switch env vars.
export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfigV1 = {
  schemaVersion: 1,
  enabled: true,
  noticeShown: false,
  installId: null,
  initializedEventSent: false,
  userChoseExplicitly: false,
};

function telemetryConfigPath(): string {
  return martinFilePath("telemetry.json");
}

export async function readTelemetryConfig(): Promise<TelemetryConfigV1> {
  try {
    const raw = await fs.readFile(telemetryConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<TelemetryConfigV1>;
    if (parsed.schemaVersion !== 1) return { ...DEFAULT_TELEMETRY_CONFIG };
    // If userChoseExplicitly is already present the config was written by this
    // version — preserve it exactly. Otherwise this is a legacy config: any
    // existing file was written after a user action (Y/N prompt, telemetry on,
    // telemetry off, or opt-in initialization), so treat it as an explicit
    // preference and preserve the existing enabled value.
    const userChoseExplicitly =
      typeof parsed.userChoseExplicitly === "boolean"
        ? parsed.userChoseExplicitly
        : true; // legacy file → treat as explicit preference
    return {
      schemaVersion: 1,
      enabled: parsed.enabled === true,
      noticeShown: parsed.noticeShown === true,
      installId: typeof parsed.installId === "string" ? parsed.installId : null,
      initializedEventSent: parsed.initializedEventSent === true,
      userChoseExplicitly,
    };
  } catch {
    return { ...DEFAULT_TELEMETRY_CONFIG };
  }
}

export async function writeTelemetryConfig(config: TelemetryConfigV1): Promise<void> {
  const target = telemetryConfigPath();
  const directory = path.dirname(target);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await fs.rename(temporary, target);
}

// ─── Environment controls ─────────────────────────────────────────────────────

function envTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

export function telemetryEnvironmentDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    envTruthy(env["MARTIN_TELEMETRY_DISABLED"]) ||
    envTruthy(env["DO_NOT_TRACK"]) ||
    envTruthy(env["CI"])
  );
}

export function isTelemetrySendingEnabled(
  config: TelemetryConfigV1,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!config.enabled) return false;
  // Disclosure is required before sending — unless the user made an explicit
  // preference choice, in which case that intent is honoured immediately.
  if (!config.noticeShown && !config.userChoseExplicitly) return false;
  if (telemetryEnvironmentDisabled(env)) return false;
  if (envTruthy(env["MARTIN_TELEMETRY_DEBUG"])) return false;
  return true;
}

// ─── Notice ───────────────────────────────────────────────────────────────────

// The notice is shown whenever the user has not yet been disclosed to —
// regardless of whether telemetry is currently enabled.
export function shouldShowTelemetryNotice(input: {
  config: TelemetryConfigV1;
  interactiveTty: boolean;
  humanOutput: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return (
    !input.config.noticeShown &&
    input.interactiveTty &&
    input.humanOutput &&
    !telemetryEnvironmentDisabled(input.env ?? {})
  );
}

export const TELEMETRY_NOTICE = [
  "MartinLoop anonymous usage analytics",
  "",
  "Anonymous product telemetry is enabled by default to help improve MartinLoop.",
  "",
  "Sent:",
  "  anonymous installation/session identifiers, CLI/runtime/platform information,",
  "  coarse command category, run duration, success/failure category,",
  "  whether a receipt was generated, whether recovery occurred,",
  "  opaque remote-experience ID/type after you click an experience",
  "",
  "Never sent:",
  "  source code, prompts or task text, repository names or URLs,",
  "  file names or paths, environment variables, API keys or secrets,",
  "  receipt contents, email addresses",
  "",
  "Disable anytime:  martin telemetry off",
  "  or set:         DO_NOT_TRACK=1  |  MARTIN_TELEMETRY_DISABLED=1",
  "",
  "Inspect the exact telemetry contract:  martin telemetry explain",
].join("\n");

// Displays the one-time opt-out disclosure. Non-blocking — does not prompt
// for input. Marks noticeShown=true and persists the config so the notice
// is shown only once. Preserves existing enabled and userChoseExplicitly.
export async function renderTelemetryNotice(
  config: TelemetryConfigV1,
  output: NodeJS.WriteStream = process.stdout,
): Promise<TelemetryConfigV1> {
  output.write(`\n${TELEMETRY_NOTICE}\n\n`);
  const next: TelemetryConfigV1 = { ...config, noticeShown: true };
  await writeTelemetryConfig(next);
  return next;
}

// ─── Session / install IDs ────────────────────────────────────────────────────

const SESSION_ID = randomUUID();

export function currentTelemetrySessionId(): string {
  return SESSION_ID;
}

export async function ensureTelemetryInstallId(config: TelemetryConfigV1): Promise<TelemetryConfigV1> {
  if (config.installId) return config;
  const next: TelemetryConfigV1 = { ...config, installId: randomUUID() };
  await writeTelemetryConfig(next);
  return next;
}

// ─── Events ───────────────────────────────────────────────────────────────────

export type ProductEventName =
  | "install_initialized"
  | "run_started"
  | "run_completed"
  | "run_failed"
  | "telemetry_changed"
  | "control_plane_connected"
  | "remote_experience_clicked";

export interface ProductEventEnvelopeV1 {
  eventId: string;
  schemaVersion: 1;
  installId: string;
  sessionId: string;
  event: ProductEventName;
  cliVersion: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  emittedAt: string;
  payload: Readonly<Record<string, unknown>>;
}

// Finite set of safe command categories. Only these values may appear in the
// command payload field — arbitrary command strings, task text, and file paths
// are rejected by assertAllowedTelemetryPayload.
export type TelemetryCommandCategory = "run";
const ALLOWED_COMMAND_CATEGORIES: ReadonlySet<string> = new Set<TelemetryCommandCategory>(["run"]);

// Mirrors RemoteExperienceV1.type — only these type strings may appear in the
// remote_experience_clicked payload.
const ALLOWED_EXPERIENCE_TYPES: ReadonlySet<string> = new Set([
  "security_notice",
  "migration_notice",
  "update_notice",
  "announcement",
  "beta_invite",
  "dashboard_invite",
  "design_partner_invite",
]);

// Server-authored remote-experience IDs use the same finite slug format as the
// hosted product-events boundary. Keep the producer and ingestion contracts exact.
const EXPERIENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Mirrors TelemetryFailureReason — prevents raw exception strings from leaking
// through the reason field on run_failed.
const ALLOWED_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "provider_unavailable",
  "verification_failed",
  "budget_exit",
  "policy_blocked",
  "persistence_failed",
  "unknown",
]);

const EVENT_PAYLOAD_KEYS: Record<ProductEventName, ReadonlySet<string>> = {
  install_initialized: new Set(),
  run_started: new Set(["command"]),
  run_completed: new Set(["durationMs", "command", "receiptGenerated", "recoveryOccurred"]),
  run_failed: new Set(["durationMs", "command", "reason"]),
  telemetry_changed: new Set(["enabled"]),
  control_plane_connected: new Set(["connected"]),
  remote_experience_clicked: new Set(["experienceId", "experienceType"]),
};

export function assertAllowedTelemetryPayload(
  event: ProductEventName,
  payload: Readonly<Record<string, unknown>>
): void {
  const allowed = EVENT_PAYLOAD_KEYS[event];
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new Error(`Unsupported telemetry payload key: ${key}`);
  }
  // Validate command value — only a finite enum of safe categories is permitted.
  // This prevents arbitrary command strings, task text, or file paths from leaking.
  if ("command" in payload) {
    if (!ALLOWED_COMMAND_CATEGORIES.has(String(payload["command"]))) {
      throw new Error(`Unsupported telemetry command category: ${String(payload["command"])}`);
    }
  }
  // Validate scalar payload types.
  if ("durationMs" in payload) {
    const v = payload["durationMs"];
    if (typeof v !== "number" || !isFinite(v) || v < 0 || v > 86_400_000) {
      throw new Error(`Invalid durationMs value`);
    }
  }
  if ("receiptGenerated" in payload && typeof payload["receiptGenerated"] !== "boolean") {
    throw new Error(`receiptGenerated must be boolean`);
  }
  if ("recoveryOccurred" in payload && typeof payload["recoveryOccurred"] !== "boolean") {
    throw new Error(`recoveryOccurred must be boolean`);
  }
  if ("enabled" in payload && typeof payload["enabled"] !== "boolean") {
    throw new Error(`enabled must be boolean`);
  }
  if ("connected" in payload && typeof payload["connected"] !== "boolean") {
    throw new Error(`connected must be boolean`);
  }
  // Validate remote_experience_clicked string fields.
  if ("experienceType" in payload) {
    if (typeof payload["experienceType"] !== "string" || !ALLOWED_EXPERIENCE_TYPES.has(String(payload["experienceType"]))) {
      throw new Error(`Unsupported experienceType value`);
    }
  }
  if ("experienceId" in payload) {
    const id = payload["experienceId"];
    if (typeof id !== "string" || !EXPERIENCE_ID_PATTERN.test(id)) {
      throw new Error(`Invalid experienceId value`);
    }
  }
  // Validate run_failed.reason — must match the finite TelemetryFailureReason enum
  // to prevent arbitrary exception strings from reaching the telemetry backend.
  if ("reason" in payload) {
    if (!ALLOWED_FAILURE_REASONS.has(String(payload["reason"]))) {
      throw new Error(`Unsupported failure reason value`);
    }
  }
}

// ─── Endpoint ─────────────────────────────────────────────────────────────────

const PRODUCT_EVENTS_ENDPOINT =
  "https://tupopqvqnyyjuxseyxkr.supabase.co/functions/v1/product-events";

export function resolveProductEventsEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  return env["MARTIN_PRODUCT_EVENTS_ENDPOINT"]?.trim() || PRODUCT_EVENTS_ENDPOINT;
}

// ─── Sender ───────────────────────────────────────────────────────────────────

export async function sendProductEvent(input: {
  endpoint: string;
  config: TelemetryConfigV1;
  event: ProductEventName;
  payload: Readonly<Record<string, unknown>>;
  cliVersion: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<boolean> {
  const env = input.env ?? {};
  if (!isTelemetrySendingEnabled(input.config, env)) return false;
  if (!input.config.installId) return false;
  try { assertAllowedTelemetryPayload(input.event, input.payload); } catch { return false; }

  const envelope: ProductEventEnvelopeV1 = {
    eventId: randomUUID(),
    schemaVersion: 1,
    installId: input.config.installId,
    sessionId: currentTelemetrySessionId(),
    event: input.event,
    cliVersion: input.cliVersion,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    emittedAt: new Date().toISOString(),
    payload: input.payload,
  };

  if (envTruthy(env["MARTIN_TELEMETRY_DEBUG"])) {
    process.stderr.write(`${JSON.stringify(envelope)}\n`);
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 1500);
  try {
    const response = await (input.fetchImpl ?? fetch)(input.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": `MartinLoop-CLI/${input.cliVersion}`,
      },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
    return response.status === 204;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Initialization ───────────────────────────────────────────────────────────

export async function initializeTelemetryIfNeeded(input: {
  config: TelemetryConfigV1;
  endpoint: string;
  cliVersion: string;
}): Promise<TelemetryConfigV1> {
  let config = input.config;
  if (!isTelemetrySendingEnabled(config)) return config;
  config = await ensureTelemetryInstallId(config);
  if (config.initializedEventSent) return config;
  const sent = await sendProductEvent({
    endpoint: input.endpoint,
    config,
    event: "install_initialized",
    payload: {},
    cliVersion: input.cliVersion,
  });
  if (!sent) return config;
  const next = { ...config, initializedEventSent: true };
  await writeTelemetryConfig(next);
  return next;
}

// ─── Failure reason ───────────────────────────────────────────────────────────

export type TelemetryFailureReason =
  | "provider_unavailable"
  | "verification_failed"
  | "budget_exit"
  | "policy_blocked"
  | "persistence_failed"
  | "unknown";

export function toTelemetryFailureReason(reasonCode: string | undefined): TelemetryFailureReason {
  switch (reasonCode) {
    case "provider_unavailable":
    case "verification_failed":
    case "budget_exit":
    case "policy_blocked":
    case "persistence_failed":
      return reasonCode;
    default:
      return "unknown";
  }
}

// ─── CLI commands ─────────────────────────────────────────────────────────────

const TELEMETRY_MANIFEST = `Sent:
- random installation ID
- per-process session ID
- CLI version
- Node version
- operating system and architecture
- event name
- event timestamp
- command category
- run duration
- success/failure category
- whether a receipt was generated
- whether recovery occurred
- opaque remote-experience ID/type after a click

Never sent:
- source code
- prompts
- task text
- repository contents
- repository name
- file names
- file paths
- environment variables
- secrets
- provider/model output
- receipt contents
- event-ledger contents
- approval details
- verifier evidence
- email addresses
- workspace, project, or organization identifiers
- raw exception messages or stacks`;

export async function executeTelemetryCommand(
  action: "status" | "explain" | "on" | "off"
): Promise<number> {
  const config = await readTelemetryConfig();
  switch (action) {
    case "status": {
      const effective = isTelemetrySendingEnabled(config);
      const envDisabled = telemetryEnvironmentDisabled();
      const preferenceType = config.userChoseExplicitly ? "explicit" : "default";
      process.stdout.write(`Telemetry\n`);
      process.stdout.write(`  Stored enabled:   ${config.enabled}\n`);
      process.stdout.write(`  Notice shown:     ${config.noticeShown}\n`);
      process.stdout.write(`  Preference:       ${preferenceType}\n`);
      process.stdout.write(`  Env disabled:     ${envDisabled}\n`);
      process.stdout.write(`  Effective:        ${effective ? "sending" : "not sending"}\n`);
      return 0;
    }
    case "explain":
      process.stdout.write(`${TELEMETRY_MANIFEST}\n`);
      return 0;
    case "on":
      await writeTelemetryConfig({ ...config, enabled: true, userChoseExplicitly: true, noticeShown: true });
      process.stdout.write(`Telemetry enabled.\n`);
      return 0;
    case "off":
      await writeTelemetryConfig({ ...config, enabled: false, userChoseExplicitly: true, noticeShown: true });
      process.stdout.write(`Telemetry disabled.\n`);
      return 0;
  }
}
