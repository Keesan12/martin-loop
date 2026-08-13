/**
 * Durable exit signals — per-kind, exclusive-create, precedence-safe.
 *
 * Each signal kind occupies its own immutable slot:
 *   <runDir>/signals/human_interrupt.json
 *   <runDir>/signals/external_event.json
 *
 * Atomic publication (crash-safe):
 *   1. Write complete JSON to a unique tmp file (wx, 0o600) in the signals dir
 *   2. Sync and close the tmp file
 *   3. Hard-link tmp to the final per-kind slot (EEXIST → already_exists)
 *   4. Unlink tmp in finally; best-effort dir sync on POSIX
 *
 * The final slot is only visible after a fully written tmp — a crash cannot
 * leave a permanently malformed final slot.
 *
 * Per-kind files let different kinds coexist — an external event filed first
 * does NOT prevent a later human interrupt.  EXIT_PRECEDENCE is always honoured.
 *
 * Real-path containment guards against symlink/junction traversal out of the
 * run store.  Diagnostics from malformed signals are propagated — never silently
 * discarded as "no signal".
 */

import { link, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExitSignalV1 } from "@martin/contracts";

const MAX_SIGNAL_BYTES = 64 * 1024;
const RUN_ID_RE = /^[A-Za-z0-9._-]{1,128}$/u;

export interface ExitSignalSource {
  poll(runId: string): Promise<SignalReadResult>;
}

export interface SignalReadResult {
  signals: readonly ExitSignalV1[];
  diagnostics: readonly SignalDiagnostic[];
}

export interface SignalDiagnostic {
  kind: "human_interrupt" | "external_event";
  error: string;
}

/**
 * Typed error surfaced by the monitor when diagnostics are detected and no
 * onDiagnostic handler is registered.  Contains safe diagnostic codes and
 * signal kinds — no absolute paths or payload secrets.
 */
export class SignalDiagnosticError extends Error {
  readonly diagnostics: readonly SignalDiagnostic[];

  constructor(diagnostics: readonly SignalDiagnostic[]) {
    const summary = diagnostics
      .map((d) => `${d.kind}: ${d.error}`)
      .join("; ");
    super(`Signal diagnostics: ${summary}`);
    this.name = "SignalDiagnosticError";
    this.diagnostics = diagnostics;
  }
}

/** Path to a per-kind signal file — safe against lexical traversal. */
export function exitSignalPath(
  runsRoot: string,
  runId: string,
  kind: "human_interrupt" | "external_event"
): string {
  assertRunId(runId);
  const root = resolve(runsRoot);
  const runDir = resolve(root, runId);
  const sep = process.platform === "win32" ? "\\" : "/";
  if (runDir !== root && !runDir.startsWith(`${root}${sep}`)) {
    throw new Error("Resolved run path escapes runs root");
  }
  const filename = kind === "human_interrupt"
    ? "human_interrupt.json"
    : "external_event.json";
  return join(runDir, "signals", filename);
}

/**
 * Write one signal of its kind atomically.  Returns "created" on success or
 * "already_exists" when that kind was already filed (first writer wins).
 * Throws on IO errors other than EEXIST on the final slot.
 *
 * Publication sequence (crash-safe):
 *   1. Validate signal and size-check the payload
 *   2. mkdir the signals directory
 *   3. realpath-check: the real signals dir must stay inside the real root
 *   4. Write complete JSON to a unique tmp file (wx, 0o600)
 *   5. Sync and close the tmp file
 *   6. Hard-link tmp to the final per-kind slot (EEXIST → already_exists)
 *   7. Unlink tmp in finally; best-effort dir sync on POSIX
 */
export async function writeExitSignal(
  runsRoot: string,
  signal: ExitSignalV1
): Promise<"created" | "already_exists"> {
  validateExitSignal(signal);

  const payload = `${JSON.stringify(signal)}\n`;
  if (Buffer.byteLength(payload, "utf8") > MAX_SIGNAL_BYTES) {
    throw new Error("Exit signal payload exceeds 64 KiB");
  }

  const finalPath = exitSignalPath(runsRoot, signal.runId, signal.kind);
  const sigDir = dirname(finalPath);

  await mkdir(sigDir, { recursive: true });

  // Real-path containment: the real signals directory must stay inside the
  // real run store root.  This catches symlink/junction escapes that lexical
  // resolve() cannot detect.
  const realRoot = await realpath(resolve(runsRoot));
  const realSigDir = await realpath(sigDir);
  if (!isContained(realRoot, realSigDir)) {
    throw new Error("Signal directory escapes the run store");
  }

  // Atomic publication via unique tmp file + hard-link.
  // Both tmp and final are in the same directory, so they are on the same
  // filesystem — hard-link is always available.
  const tmpPath = join(sigDir, `.tmp-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(tmpPath, "wx", 0o600);
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (err) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
      handle = undefined;
    }
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }

  // Claim the final slot atomically — link() fails with EEXIST if slot is
  // already occupied, preserving first-signal-wins without replacing the file.
  let outcome: "created" | "already_exists";
  try {
    await link(tmpPath, finalPath);
    outcome = "created";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      outcome = "already_exists";
    } else {
      throw err;
    }
  } finally {
    await unlink(tmpPath).catch(() => undefined);
    // Best-effort directory sync so the new entry is durable on POSIX.
    // Windows directories cannot be opened with O_RDONLY — skip.
    if (process.platform !== "win32") {
      const dh = await open(sigDir, "r").catch(() => undefined);
      if (dh !== undefined) {
        await dh.sync().catch(() => undefined);
        await dh.close().catch(() => undefined);
      }
    }
  }

  return outcome;
}

/**
 * Read all present signals for a run (both kinds).  Returns a structured
 * result with any parse diagnostics rather than throwing on malformed files.
 */
export async function readAllExitSignals(
  runsRoot: string,
  runId: string
): Promise<SignalReadResult> {
  const kinds: Array<"human_interrupt" | "external_event"> = [
    "human_interrupt",
    "external_event"
  ];
  const signals: ExitSignalV1[] = [];
  const diagnostics: SignalDiagnostic[] = [];

  for (const kind of kinds) {
    const result = await readOneSignal(runsRoot, runId, kind);
    if (result.signal !== undefined) signals.push(result.signal);
    if (result.diagnostic !== undefined) diagnostics.push(result.diagnostic);
  }

  return { signals, diagnostics };
}

/** Read a single signal kind; returns undefined when absent. */
export async function readExitSignal(
  runsRoot: string,
  runId: string,
  kind: "human_interrupt" | "external_event"
): Promise<ExitSignalV1 | undefined> {
  const { signal } = await readOneSignal(runsRoot, runId, kind);
  return signal;
}

export function createFileExitSignalSource(runsRoot: string): ExitSignalSource {
  return {
    poll: async (runId) => readAllExitSignals(runsRoot, runId)
  };
}

/**
 * Polls for any exit signal and calls onSignal with the full set when any
 * new signal appears.  Returns a dispose function — MUST be called on every
 * return/throw path in the run harness (invariant: one interval per run).
 *
 * Diagnostics (malformed signals, containment failures) are routed to
 * onDiagnostic when provided; otherwise surfaced as a SignalDiagnosticError
 * through onError so callers always learn about corruption rather than
 * silently treating it as "no signal".
 */
export function startExitSignalMonitor(input: {
  source?: ExitSignalSource;
  runId: string;
  controller: AbortController;
  pollIntervalMs?: number;
  onSignal: (signals: readonly ExitSignalV1[]) => void;
  onDiagnostic?: (diagnostics: readonly SignalDiagnostic[]) => void;
  onError: (error: Error) => void;
}): () => void {
  if (input.source === undefined) return () => undefined;
  const intervalMs = input.pollIntervalMs ?? 250;
  let polling = false;
  let lastCount = 0;

  const timer = setInterval(() => {
    if (polling || input.controller.signal.aborted) return;
    polling = true;
    void input.source!
      .poll(input.runId)
      .then(({ signals, diagnostics }) => {
        if (input.controller.signal.aborted) return;
        // Surface diagnostics without aborting the run
        if (diagnostics.length > 0) {
          if (input.onDiagnostic !== undefined) {
            input.onDiagnostic(diagnostics);
          } else {
            input.onError(new SignalDiagnosticError(diagnostics));
          }
        }
        // Only fire onSignal when new signals appear
        if (signals.length > lastCount) {
          lastCount = signals.length;
          input.onSignal(signals);
          input.controller.abort(signals);
        }
      })
      .catch((err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        input.onError(e);
        input.controller.abort(e);
      })
      .finally(() => { polling = false; });
  }, intervalMs);

  timer.unref?.();
  return () => clearInterval(timer);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

async function readOneSignal(
  runsRoot: string,
  runId: string,
  kind: "human_interrupt" | "external_event"
): Promise<{ signal?: ExitSignalV1; diagnostic?: SignalDiagnostic }> {
  assertRunId(runId);
  const finalPath = exitSignalPath(runsRoot, runId, kind);
  const sigDir = dirname(finalPath);

  // Real-path containment for reads: signals dir must stay inside the run store.
  // ENOENT on the signals dir means no signals have been written — return absent.
  let realSigDir: string;
  try {
    realSigDir = await realpath(sigDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    return {
      diagnostic: {
        kind,
        error: `containment check failed [${(err as NodeJS.ErrnoException).code ?? "ERR"}]`
      }
    };
  }
  const realRoot = await realpath(resolve(runsRoot));
  if (!isContained(realRoot, realSigDir)) {
    return { diagnostic: { kind, error: "signal directory escapes the run store" } };
  }

  // lstat: reject symlinks and surface size violations before reading.
  // With atomic publication, the final file is always a complete hardlinked
  // inode — a size=0 or a symlink indicates tampering.
  let size: number;
  try {
    const lstats = await lstat(finalPath);
    if (lstats.isSymbolicLink()) {
      return { diagnostic: { kind, error: "signal file is a symbolic link" } };
    }
    size = lstats.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    return {
      diagnostic: {
        kind,
        error: `stat error [${(err as NodeJS.ErrnoException).code ?? "ERR"}]`
      }
    };
  }

  if (size > MAX_SIGNAL_BYTES) {
    return { diagnostic: { kind, error: "signal file exceeds 64 KiB" } };
  }

  let text: string;
  try {
    text = await readFile(finalPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    return {
      diagnostic: {
        kind,
        error: `read error [${(err as NodeJS.ErrnoException).code ?? "ERR"}]`
      }
    };
  }

  // With atomic publication the final file should always contain valid JSON.
  // A parse failure indicates file corruption — surface as diagnostic.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { diagnostic: { kind, error: "signal file contains invalid JSON" } };
  }

  try {
    validateExitSignal(parsed as ExitSignalV1);
    return { signal: parsed as ExitSignalV1 };
  } catch (err) {
    return { diagnostic: { kind, error: String(err) } };
  }
}

function validateExitSignal(signal: ExitSignalV1): void {
  if (signal.schemaVersion !== "exit-signal/1") {
    throw new Error(`Unsupported exit signal schema: ${String(signal.schemaVersion)}`);
  }
  assertRunId(signal.runId);
  if (signal.kind !== "human_interrupt" && signal.kind !== "external_event") {
    throw new Error(`Invalid exit signal kind: ${String(signal.kind)}`);
  }
  if (!signal.requestedBy?.trim() || !Number.isFinite(Date.parse(signal.requestedAt))) {
    throw new Error("Exit signal requester and timestamp are required");
  }
  if (signal.kind === "external_event" && signal.externalEvent === undefined) {
    throw new Error("external_event signal requires externalEvent evidence");
  }
  if (signal.externalEvent !== undefined) {
    const ev = signal.externalEvent;
    if (!ev.source?.trim() || !ev.event?.trim()) {
      throw new Error("External event source and event are required");
    }
    if (!["satisfied", "superseded", "cancelled"].includes(ev.disposition)) {
      throw new Error(`Invalid external event disposition: ${String(ev.disposition)}`);
    }
    if (!Number.isFinite(Date.parse(ev.observedAt))) {
      throw new Error("External event observedAt must be an ISO timestamp");
    }
  }
}

function assertRunId(runId: string): void {
  if (
    runId === "." ||
    runId === ".." ||
    !RUN_ID_RE.test(runId) ||
    basename(runId) !== runId
  ) {
    throw new Error(`Invalid run id: ${JSON.stringify(runId)}`);
  }
}

/** True when candidate equals root or is a strict descendant under root. */
function isContained(root: string, candidate: string): boolean {
  const sep = process.platform === "win32" ? "\\" : "/";
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}
