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
}

// Telemetry is OFF by default. The user must explicitly opt in via the
// interactive notice (Y) or `martin telemetry on`. No event is sent before
// explicit acceptance.
export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfigV1 = {
  schemaVersion: 1,
  enabled: false,
  noticeShown: false,
  installId: null,
  initializedEventSent: false,
};

function telemetryConfigPath(): string {
  return martinFilePath("telemetry.json");
}

export async function readTelemetryConfig(): Promise<TelemetryConfigV1> {
  try {
    const raw = await fs.readFile(telemetryConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<TelemetryConfigV1>;
    if (parsed.schemaVersion !== 1) return { ...DEFAULT_TELEMETRY_CONFIG };
    return {
      schemaVersion: 1,
      // Honour persisted preference. If the field is absent (upgrading from
      // an old config written before the field existed), default to false so
      // existing installs remain in a known-off state until they re-consent.
      enabled: parsed.enabled === true,
      noticeShown: parsed.noticeShown === true,
      installId: typeof parsed.installId === "string" ? parsed.installId : null,
      initializedEventSent: parsed.initializedEventSent === true,
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
  return (
    config.enabled &&
    config.noticeShown &&
    !telemetryEnvironmentDisabled(env) &&
    !envTruthy(env["MARTIN_TELEMETRY_DEBUG"])
  );
}

// ─── Notice ───────────────────────────────────────────────────────────────────

// The notice is shown whenever the user has not yet been asked — regardless
// of whether telemetry is currently enabled. This allows the notice to act as
// the explicit opt-in invitation even on a fresh install (where enabled=false).
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
  "Help improve MartinLoop by sharing minimal anonymous usage data?",
  "It never sends code, prompts, repository contents, file paths,",
  "environment variables, secrets, or receipt contents.",
  "",
  "Inspect exactly what would be sent:",
  "  martin telemetry explain",
].join("\n");

// Reads a single Y/N keypress to obtain explicit consent.
// Returns true if the user pressed Y (opt in), false for N or timeout.
async function readTelemetryConsentKey(
  input: NodeJS.ReadStream = process.stdin
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!input.isTTY) { resolve(false); return; }
    const prev = input.isRaw;
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf-8");
    const timeout = setTimeout(() => { cleanup(); resolve(false); }, 30_000);
    const onData = (key: string) => {
      if (key === "\u0003") { cleanup(); process.exit(0); }
      cleanup();
      resolve(key.toLowerCase() === "y");
    };
    const cleanup = () => {
      clearTimeout(timeout);
      input.removeListener("data", onData);
      try { input.setRawMode(prev ?? false); } catch { /* ignore */ }
      input.pause();
    };
    input.on("data", onData);
  });
}

// Displays the opt-in notice and prompts Y/N. Marks noticeShown regardless
// of the user's choice; only sets enabled=true on Y. An informational notice
// alone is not consent — the user must press Y.
export async function renderTelemetryNotice(
  config: TelemetryConfigV1,
  output: NodeJS.WriteStream = process.stdout,
  inputStream: NodeJS.ReadStream = process.stdin
): Promise<TelemetryConfigV1> {
  output.write(`\n${TELEMETRY_NOTICE}\n\n`);
  output.write(`  Enable analytics? [Y/n]  > `);
  const accepted = await readTelemetryConsentKey(inputStream);
  output.write(`${accepted ? "Y" : "N"}\n\n`);
  const next: TelemetryConfigV1 = { ...config, noticeShown: true, enabled: accepted };
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

const EVENT_PAYLOAD_KEYS: Record<ProductEventName, ReadonlySet<string>> = {
  install_initialized: new Set(),
  run_started: new Set(["command"]),
  run_completed: new Set(["durationMs", "command", "receiptGenerated", "recoveryOccurred"]),
  run_failed: new Set(["durationMs", "command", "reason"]),
  telemetry_changed: new Set(["enabled", "source"]),
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
      process.stdout.write(`Telemetry\n`);
      process.stdout.write(`  Stored enabled:   ${config.enabled}\n`);
      process.stdout.write(`  Notice shown:     ${config.noticeShown}\n`);
      process.stdout.write(`  Env disabled:     ${envDisabled}\n`);
      process.stdout.write(`  Effective:        ${effective ? "sending" : "not sending"}\n`);
      return 0;
    }
    case "explain":
      process.stdout.write(`${TELEMETRY_MANIFEST}\n`);
      return 0;
    case "on":
      await writeTelemetryConfig({ ...config, enabled: true });
      process.stdout.write(`Telemetry enabled. A first-run notice will appear if not already shown.\n`);
      return 0;
    case "off":
      await writeTelemetryConfig({ ...config, enabled: false });
      process.stdout.write(`Telemetry disabled.\n`);
      return 0;
  }
}
