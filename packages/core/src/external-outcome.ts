import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  EXTERNAL_OUTCOME_LIMITS,
  EXTERNAL_OUTCOME_RESULT_SCHEMA_VERSION,
  externalOutcomeValuesEqual,
  resolveExternalOutcomeJsonPointer,
  validateExternalOutcomeContract,
  type ExternalOutcomeActionContract,
  type ExternalOutcomeActionResult,
  type ExternalOutcomeAssertionResult,
  type ExternalOutcomeContract,
  type ExternalOutcomeEvidenceReference,
  type ExternalOutcomeReasonCode,
  type ExternalOutcomeResult,
} from "@martin/contracts";

export class ExternalOutcomeContractError extends Error {
  readonly errors: Array<{ path: string; message: string }>;

  constructor(errors: Array<{ path: string; message: string }>) {
    super(errors.map((item) => `${item.path || "<root>"}: ${item.message}`).join("; "));
    this.name = "ExternalOutcomeContractError";
    this.errors = errors;
  }
}

export class ExternalOutcomePolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ExternalOutcomePolicyError";
    this.code = code;
  }
}

export interface VerifyExternalOutcomesOptions {
  env?: NodeJS.ProcessEnv;
  allowLocal?: boolean;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface WriteExternalOutcomeEvidenceOptions {
  runsRoot: string;
  runId?: string;
}

export interface ExternalOutcomeEvidenceWrite {
  path: string;
  relativePath: string;
  sha256: string;
  reference: ExternalOutcomeEvidenceReference;
}

type Observation =
  | { kind: "payload"; payload: unknown; observedAt: string }
  | { kind: "missing"; observedAt: string }
  | { kind: "transient"; reasonCode: "source_unavailable" | "deadline_exceeded"; observedAt: string }
  | { kind: "terminal_unknown"; reasonCode: ExternalOutcomeReasonCode; observedAt: string };

type Evaluation =
  | { state: "passed"; assertions: ExternalOutcomeAssertionResult[] }
  | { state: "failed"; reasonCode: ExternalOutcomeReasonCode; assertions: ExternalOutcomeAssertionResult[] }
  | { state: "unknown"; reasonCode: "invalid_response"; assertions: ExternalOutcomeAssertionResult[] }
  | { state: "pending"; reasonCode: "record_missing" | "wrong_identity"; assertions: ExternalOutcomeAssertionResult[] };

export function hashExternalOutcomeContract(contract: ExternalOutcomeContract): string {
  return createHash("sha256").update(canonicalJson(contract)).digest("hex");
}

export async function verifyExternalOutcomes(
  contract: ExternalOutcomeContract,
  options: VerifyExternalOutcomesOptions = {},
): Promise<ExternalOutcomeResult> {
  const errors = validateExternalOutcomeContract(contract);
  if (errors.length > 0) throw new ExternalOutcomeContractError(errors);

  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const startedWall = now();
  const startedMono = performance.now();
  const deadlineMono = startedMono + contract.deadlineMs;
  const binding = readBinding(env);
  const states = contract.actions.map((action) => createPollState(action, startedMono));

  while (states.some((state) => state.result === undefined) && performance.now() < deadlineMono) {
    if (options.signal?.aborted) {
      for (const state of states) {
        if (!state.result) state.result = finishPollState(state, "unknown", "cancelled", []);
      }
      break;
    }

    const current = performance.now();
    const due = states
      .filter((state) => state.result === undefined && state.nextPollAt <= current)
      .slice(0, EXTERNAL_OUTCOME_LIMITS.maxConcurrency);

    if (due.length === 0) {
      const nextAt = Math.min(
        deadlineMono,
        ...states.filter((state) => state.result === undefined).map((state) => state.nextPollAt),
      );
      await wait(Math.max(0, nextAt - performance.now()), options.signal);
      continue;
    }

    await Promise.all(due.map(async (state) => {
      const remaining = Math.max(1, deadlineMono - performance.now());
      const observation = await observe(state.action, contract.allowedOrigins, {
        env,
        allowLocal: options.allowLocal === true,
        signal: options.signal,
        timeoutMs: Math.min(contract.requestTimeoutMs, remaining),
        now,
      });
      state.observationCount += 1;
      state.firstObservedAt ??= observation.observedAt;
      state.lastObservedAt = observation.observedAt;

      if (observation.kind === "terminal_unknown") {
        state.result = finishPollState(state, "unknown", observation.reasonCode, []);
        return;
      }
      if (observation.kind === "transient") {
        state.lastTransient = observation.reasonCode;
        state.nextPollAt = performance.now() + contract.pollIntervalMs;
        return;
      }
      if (observation.kind === "missing") {
        state.lastPending = { state: "pending", reasonCode: "record_missing", assertions: [] };
        state.nextPollAt = performance.now() + contract.pollIntervalMs;
        return;
      }

      const evaluated = evaluatePayload(state.action, observation.payload);
      if (evaluated.state === "passed") {
        state.result = finishPollState(state, "passed", "passed", evaluated.assertions);
      } else if (evaluated.state === "failed") {
        state.result = finishPollState(state, "failed", evaluated.reasonCode, evaluated.assertions);
      } else if (evaluated.state === "unknown") {
        state.result = finishPollState(state, "unknown", evaluated.reasonCode, evaluated.assertions);
      } else {
        state.lastPending = evaluated;
        state.nextPollAt = performance.now() + contract.pollIntervalMs;
      }
    }));
  }

  for (const state of states) {
    if (state.result) continue;
    if (options.signal?.aborted) {
      state.result = finishPollState(state, "unknown", "cancelled", []);
    } else if (state.lastPending) {
      state.result = finishPollState(state, "failed", state.lastPending.reasonCode, state.lastPending.assertions);
    } else {
      state.result = finishPollState(
        state,
        "unknown",
        state.observationCount === 0 ? "deadline_exceeded" : state.lastTransient,
        [],
      );
    }
  }

  const results = states.map((state) => state.result!);
  const claimed = results.filter((item) => item.claimedDone);
  return {
    schemaVersion: EXTERNAL_OUTCOME_RESULT_SCHEMA_VERSION,
    contractId: contract.contractId,
    contractSha256: hashExternalOutcomeContract(contract),
    startedAt: startedWall.toISOString(),
    completedAt: now().toISOString(),
    ...(binding ? { binding } : {}),
    aggregate: buildAggregate(claimed),
    actions: results,
  };
}

function buildAggregate(claimed: ExternalOutcomeActionResult[]): ExternalOutcomeResult["aggregate"] {
  const claimedDone = claimed.length;
  const passed = claimed.filter((item) => item.status === "passed").length;
  const failed = claimed.filter((item) => item.status === "failed").length;
  const unknown = claimed.filter((item) => item.status === "unknown").length;
  const checked = claimed.filter((item) => item.observationCount > 0).length;
  return {
    claimedDone,
    checked,
    passed,
    failed,
    unknown,
    rejectedClaimRate: claimedDone > 0 ? failed / claimedDone : 0,
    unknownClaimRate: claimedDone > 0 ? unknown / claimedDone : 0,
    coverage: claimedDone > 0 ? checked / claimedDone : 0,
  };
}

export async function writeExternalOutcomeEvidence(
  result: ExternalOutcomeResult,
  options: WriteExternalOutcomeEvidenceOptions,
): Promise<ExternalOutcomeEvidenceWrite> {
  const runsRoot = resolve(options.runsRoot);
  const safeContractId = result.contractId.replace(/[^A-Za-z0-9._-]/gu, "_");
  const stamp = result.startedAt.replaceAll(/[^0-9]/gu, "").slice(0, 17);
  const fileName = `${safeContractId}-${result.contractSha256.slice(0, 16)}-${stamp}.json`;
  const directory = options.runId
    ? join(runsRoot, options.runId, "external-outcomes")
    : join(runsRoot, "external-outcomes", "standalone");
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const path = join(directory, fileName);
  const bytes = `${JSON.stringify(result, null, 2)}\n`;
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temp, path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const relativePath = options.runId
    ? relative(join(runsRoot, options.runId), path).replaceAll("\\", "/")
    : relative(runsRoot, path).replaceAll("\\", "/");

  return {
    path,
    relativePath,
    sha256,
    reference: {
      kind: "external_outcome",
      contractId: result.contractId,
      sha256,
      path: relativePath,
    },
  };
}

interface ActionPollState {
  action: ExternalOutcomeActionContract;
  source: { origin: string };
  startedMono: number;
  nextPollAt: number;
  observationCount: number;
  firstObservedAt?: string;
  lastObservedAt?: string;
  lastPending?: Extract<Evaluation, { state: "pending" }>;
  lastTransient: "source_unavailable" | "deadline_exceeded";
  result?: ExternalOutcomeActionResult;
}

function createPollState(action: ExternalOutcomeActionContract, startedMono: number): ActionPollState {
  const parsed = new URL(action.source.url);
  return {
    action,
    source: {
      origin: parsed.origin,
    },
    startedMono,
    nextPollAt: startedMono,
    observationCount: 0,
    lastTransient: "source_unavailable",
  };
}

function finishPollState(
  state: ActionPollState,
  status: "passed" | "failed" | "unknown",
  reasonCode: ExternalOutcomeReasonCode,
  assertions: ExternalOutcomeAssertionResult[],
): ExternalOutcomeActionResult {
  return {
    actionId: state.action.actionId,
    claimedDone: state.action.claimedDone,
    status,
    reasonCode,
    observationCount: state.observationCount,
    ...(state.firstObservedAt ? { firstObservedAt: state.firstObservedAt } : {}),
    ...(state.lastObservedAt ? { lastObservedAt: state.lastObservedAt } : {}),
    elapsedMs: Math.max(0, Math.round(performance.now() - state.startedMono)),
    source: state.source,
    assertions,
  };
}

async function observe(
  action: ExternalOutcomeActionContract,
  allowedOrigins: string[],
  options: {
    env: NodeJS.ProcessEnv;
    allowLocal: boolean;
    signal?: AbortSignal;
    timeoutMs: number;
    now: () => Date;
  },
): Promise<Observation> {
  const observedAt = options.now().toISOString();
  if (action.source.authEnv && !options.env[action.source.authEnv]) {
    return { kind: "terminal_unknown", reasonCode: "auth_denied", observedAt };
  }

  let response: { statusCode: number; body: string };
  try {
    response = await readJsonOverPinnedGet(action.source.url, {
      allowedOrigins,
      authToken: action.source.authEnv ? options.env[action.source.authEnv] : undefined,
      allowLocal: options.allowLocal,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    if (error instanceof ExternalOutcomePolicyError) throw error;
    const code = error instanceof Error ? error.message : String(error);
    if (code === "response_too_large") return { kind: "terminal_unknown", reasonCode: "response_too_large", observedAt };
    if (options.signal?.aborted) return { kind: "terminal_unknown", reasonCode: "cancelled", observedAt };
    return { kind: "transient", reasonCode: code === "deadline_exceeded" ? "deadline_exceeded" : "source_unavailable", observedAt };
  }

  if (response.statusCode === 401 || response.statusCode === 403) {
    return { kind: "terminal_unknown", reasonCode: "auth_denied", observedAt };
  }
  if (response.statusCode >= 300 && response.statusCode < 400) {
    return { kind: "terminal_unknown", reasonCode: "redirect_blocked", observedAt };
  }
  if (response.statusCode === 404) {
    return { kind: "missing", observedAt };
  }
  if (response.statusCode === 408 || response.statusCode === 425 || response.statusCode === 429 || response.statusCode >= 500) {
    return { kind: "transient", reasonCode: "source_unavailable", observedAt };
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    return { kind: "terminal_unknown", reasonCode: "invalid_response", observedAt };
  }

  try {
    return { kind: "payload", payload: JSON.parse(response.body), observedAt };
  } catch {
    return { kind: "terminal_unknown", reasonCode: "invalid_response", observedAt };
  }
}

function evaluatePayload(action: ExternalOutcomeActionContract, payload: unknown): Evaluation {
  const recordsRef = resolveExternalOutcomeJsonPointer(payload, action.recordPointer);
  if (!recordsRef.found) {
    return { state: "unknown", reasonCode: "invalid_response", assertions: [] };
  }

  const records = Array.isArray(recordsRef.value)
    ? recordsRef.value
    : (recordsRef.value && typeof recordsRef.value === "object" && action.expectedCount === 1)
      ? [recordsRef.value]
      : null;
  if (!records) {
    return { state: "unknown", reasonCode: "invalid_response", assertions: [] };
  }
  const identityObservations = records.map((record) => ({
    record,
    identity: resolveExternalOutcomeJsonPointer(record, action.identity.pointer),
  }));
  if (records.length > 0 && identityObservations.every((item) => !item.identity.found)) {
    return { state: "unknown", reasonCode: "invalid_response", assertions: [] };
  }
  const matches = identityObservations
    .filter((item) => item.identity.found && externalOutcomeValuesEqual(item.identity.value, action.identity.equals))
    .map((item) => item.record);

  if (matches.length === 0) {
    return {
      state: "pending",
      reasonCode: records.length === 0 ? "record_missing" : "wrong_identity",
      assertions: [],
    };
  }
  if (matches.length > action.expectedCount) {
    return { state: "failed", reasonCode: "duplicate_record", assertions: [] };
  }
  if (matches.length < action.expectedCount) {
    return { state: "pending", reasonCode: "record_missing", assertions: [] };
  }

  const assertionResults: ExternalOutcomeAssertionResult[] = [];
  for (const assertion of action.assertions) {
    let passed = true;
    let missing = false;
    for (const record of matches) {
      const observed = resolveExternalOutcomeJsonPointer(record, assertion.pointer);
      if (!observed.found) {
        missing = true;
        passed = false;
        break;
      }
      if (!externalOutcomeValuesEqual(observed.value, assertion.equals)) {
        passed = false;
        break;
      }
    }
    assertionResults.push({
      pointer: assertion.pointer,
      passed,
      reasonCode: passed ? "passed" : missing ? "missing_pointer" : "value_mismatch",
    });
  }
  if (assertionResults.some((item) => item.reasonCode === "missing_pointer")) {
    return { state: "unknown", reasonCode: "invalid_response", assertions: assertionResults };
  }
  if (assertionResults.some((item) => !item.passed)) {
    return { state: "failed", reasonCode: "value_mismatch", assertions: assertionResults };
  }

  if (action.freshness) {
    for (const record of matches) {
      const observed = resolveExternalOutcomeJsonPointer(record, action.freshness.pointer);
      if (!observed.found) {
        return {
          state: "unknown",
          reasonCode: "invalid_response",
          assertions: [...assertionResults, { pointer: action.freshness.pointer, passed: false, reasonCode: "missing_pointer" }],
        };
      }
      if (Object.prototype.hasOwnProperty.call(action.freshness, "notEquals")
        && externalOutcomeValuesEqual(observed.value, action.freshness.notEquals!)) {
        return {
          state: "failed",
          reasonCode: "stale_record",
          assertions: [...assertionResults, { pointer: action.freshness.pointer, passed: false, reasonCode: "stale_record" }],
        };
      }
      if (action.freshness.notBefore) {
        if (typeof observed.value !== "string") {
          return { state: "unknown", reasonCode: "invalid_response", assertions: assertionResults };
        }
        const observedTime = Date.parse(observed.value);
        if (!Number.isFinite(observedTime) || observedTime < Date.parse(action.freshness.notBefore)) {
          return { state: "failed", reasonCode: "stale_record", assertions: assertionResults };
        }
      }
    }
  }

  return { state: "passed", assertions: assertionResults };
}

async function readJsonOverPinnedGet(
  rawUrl: string,
  options: {
    allowedOrigins: string[];
    authToken?: string;
    allowLocal: boolean;
    signal?: AbortSignal;
    timeoutMs: number;
  },
): Promise<{ statusCode: number; body: string }> {
  const url = new URL(rawUrl);
  const normalizedAllowedOrigins = options.allowedOrigins.map((origin) => new URL(origin).origin);
  if (!normalizedAllowedOrigins.includes(url.origin)) {
    throw new ExternalOutcomePolicyError("origin_not_allowed", "External outcome source origin is not allowlisted.");
  }
  if (url.username || url.password) {
    throw new ExternalOutcomePolicyError("url_credentials_forbidden", "External outcome URLs cannot contain credentials.");
  }
  if (url.protocol !== "https:" && !(options.allowLocal && url.protocol === "http:")) {
    throw new ExternalOutcomePolicyError("https_required", "External outcome read-back requires HTTPS unless local/staging access is explicitly enabled.");
  }

  const pinned = await resolvePinnedAddress(url.hostname, options.allowLocal);
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Cache-Control": "no-cache",
    "User-Agent": "MartinLoop-ExternalOutcome/1",
  };
  if (options.authToken) headers.Authorization = `Bearer ${options.authToken}`;

  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    const settleResolve = (value: { statusCode: number; body: string }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    };
    const onAbort = () => req.destroy(new Error("cancelled"));
    const requestOptions: any = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers,
      timeout: Math.max(1, Math.floor(options.timeoutMs)),
      agent: false,
      lookup: (_hostname: string, _lookupOptions: unknown, callback: (error: NodeJS.ErrnoException | null, address?: string, family?: number) => void) => {
        callback(null, pinned.address, pinned.family);
      },
    };
    const req = transport(requestOptions, (res) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > EXTERNAL_OUTCOME_LIMITS.maxResponseBytes) {
          req.destroy(new Error("response_too_large"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      res.on("end", () => settleResolve({
        statusCode: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      res.on("error", settleReject);
    });
    const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
    req.once("timeout", () => req.destroy(new Error("deadline_exceeded")));
    req.once("error", settleReject);
    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) onAbort();
    }
    req.end();
  });
}

async function resolvePinnedAddress(hostname: string, allowLocal: boolean): Promise<{ address: string; family: number }> {
  const normalizedHostname = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const literalFamily = isIP(normalizedHostname);
  const addresses = literalFamily
    ? [{ address: normalizedHostname, family: literalFamily }]
    : await lookup(normalizedHostname, { all: true, verbatim: true });

  if (addresses.length === 0) throw new ExternalOutcomePolicyError("dns_resolution_failed", "External outcome source did not resolve.");
  if (!allowLocal && addresses.some(({ address }) => isPrivateOrSpecialAddress(address))) {
    throw new ExternalOutcomePolicyError("private_target_blocked", "External outcome source resolves to a private, local, metadata, or reserved address.");
  }
  const selected = addresses[0]!;
  return { address: selected.address, family: selected.family };
}

function isPrivateOrSpecialAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    const [a = 0, b = 0, c = 0] = octets;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224;
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    const mappedDotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(normalized)?.[1];
    if (mappedDotted && isIP(mappedDotted) === 4) {
      return isPrivateOrSpecialAddress(mappedDotted);
    }
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(normalized);
    if (mappedHex?.[1] && mappedHex[2]) {
      const high = Number.parseInt(mappedHex[1], 16);
      const low = Number.parseInt(mappedHex[2], 16);
      const mappedIpv4 = [
        (high >> 8) & 0xff,
        high & 0xff,
        (low >> 8) & 0xff,
        low & 0xff,
      ].join(".");
      return isPrivateOrSpecialAddress(mappedIpv4);
    }
    return normalized === "::"
      || normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || /^fe[89ab]/u.test(normalized)
      || normalized.startsWith("ff")
      || normalized.startsWith("2001:db8:");
  }
  return true;
}

async function wait(durationMs: number, signal?: AbortSignal): Promise<void> {
  if (durationMs <= 0 || signal?.aborted) return;
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(done, durationMs);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function readBinding(env: NodeJS.ProcessEnv): ExternalOutcomeResult["binding"] | undefined {
  const runId = env.MARTIN_RUN_ID?.trim();
  const attemptId = env.MARTIN_ATTEMPT_ID?.trim();
  const workspaceId = env.MARTIN_WORKSPACE_ID?.trim();
  if (!runId && !attemptId && !workspaceId) return undefined;
  return {
    ...(runId ? { runId } : {}),
    ...(attemptId ? { attemptId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
