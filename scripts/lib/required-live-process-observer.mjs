import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const schemaVersion = "martin.required-live.provider-process.v1";
const environmentKeys = {
  executablePath: "MARTIN_QUALIFICATION_NATIVE_CODEX",
  traceDir: "MARTIN_QUALIFICATION_PROCESS_TRACES",
  captureId: "MARTIN_QUALIFICATION_CAPTURE_ID",
  sourceSha: "MARTIN_QUALIFICATION_SOURCE_SHA",
};

function pathKey(path) {
  if (typeof path !== "string" || !isAbsolute(path)) return undefined;
  const canonical = resolve(path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function attemptWorkspaceKey(path) {
  const lexical = pathKey(path);
  if (lexical === undefined) return undefined;
  try {
    return pathKey(realpathSync(path));
  } catch (error) {
    // Retained attempts may refer to a cleaned workspace. In that case,
    // only its exact recorded spelling can establish the binding.
    return error?.code === "ENOENT" ? lexical : undefined;
  }
}

function stableTime(value) {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

function positivePid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function completeIdentity(record, authority) {
  const executable = pathKey(authority.executablePath);
  return record.schemaVersion === schemaVersion
    && record.captureId === authority.captureId
    && record.sourceSha === authority.sourceSha
    && executable !== undefined && pathKey(record.executablePath) === executable
    && pathKey(record.cwd) !== undefined
    && positivePid(record.providerProcessId) && positivePid(record.parentProcessId)
    && record.providerProcessId !== record.parentProcessId
    && Number.isFinite(stableTime(record.launchedAt));
}

function atomicRecord(path, record) {
  const partial = `${path}.partial`;
  writeFileSync(partial, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(partial, path);
}

export async function launchObservedProvider({ args, cwd, executablePath, traceDir, captureId, sourceSha }) {
  if (!pathKey(cwd) || !pathKey(executablePath) || !pathKey(traceDir)
      || typeof captureId !== "string" || !captureId || !/^[a-f0-9]{40}$/u.test(sourceSha)) {
    throw new Error("Provider process capture authority is incomplete.");
  }
  const executable = realpathSync(executablePath);
  const workspace = realpathSync(cwd);
  const captureRoot = realpathSync(traceDir);
  const workspaceSource = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
  if (workspaceSource !== sourceSha) throw new Error("Provider workspace source does not match capture authority.");

  const env = { ...process.env };
  for (const key of Object.values(environmentKeys)) delete env[key];
  const invocationId = randomUUID();
  const launchPath = join(captureRoot, `${invocationId}.start.json`);
  const completionPath = join(captureRoot, `${invocationId}.end.json`);
  let started;
  let sessionId;
  let sessionCount = 0;
  let journalError;
  const child = spawn(executable, args, {
    cwd: workspace, env, windowsHide: true, stdio: ["inherit", "pipe", "inherit"],
  });
  child.stdout.pipe(process.stdout, { end: false });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.includes('"thread.started"')) return;
    try {
      const event = JSON.parse(line);
      if (event?.type !== "thread.started") return;
      sessionCount += 1;
      if (typeof event.thread_id === "string" && event.thread_id) sessionId = event.thread_id;
    } catch {
      // The adapter independently validates every provider JSONL event.
    }
  });

  child.once("spawn", () => {
    started = {
      schemaVersion, captureId, invocationId, sourceSha,
      executablePath: executable, cwd: workspace,
      parentProcessId: process.pid, providerProcessId: child.pid,
      launchedAt: new Date().toISOString(),
    };
    try {
      atomicRecord(launchPath, started);
    } catch (error) {
      journalError = error;
      child.kill();
    }
  });
  const forwardSignal = (signal) => child.kill(signal);
  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);
  try {
    return await new Promise((promiseResolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (journalError) return reject(journalError);
        if (!started) return reject(new Error("Provider spawn could not be observed."));
        const completed = {
          ...started, completedAt: new Date().toISOString(), exitCode: code, signal,
          ...(sessionCount === 1 && sessionId ? { sessionId } : {}),
        };
        try {
          atomicRecord(completionPath, completed);
          return promiseResolve(code ?? 1);
        } catch (error) {
          return reject(error);
        }
      });
    });
  } finally {
    process.off("SIGINT", forwardSignal);
    process.off("SIGTERM", forwardSignal);
    lines.close();
  }
}

export async function readProviderProcessObservations(authority, { allowRunning = false } = {}) {
  const entries = await readdir(authority.traceDir, { withFileTypes: true });
  const starts = new Map();
  const ends = new Map();
  for (const entry of entries) {
    const match = /^([a-f0-9-]{36})\.(start|end)\.json$/u.exec(entry.name);
    if (!match) continue;
    if (!entry.isFile()) throw new Error("Provider process observation must be a regular file.");
    const record = JSON.parse(readFileSync(join(authority.traceDir, entry.name), "utf8"));
    if (!record || match[1] !== record.invocationId || !completeIdentity(record, authority)) {
      throw new Error("Provider process observation does not bind to capture authority.");
    }
    (match[2] === "start" ? starts : ends).set(record.invocationId, record);
  }
  const completed = [];
  for (const [invocationId, start] of starts) {
    const end = ends.get(invocationId);
    if (!end && allowRunning) {
      completed.push(start);
      continue;
    }
    if (!end || Object.entries(start).some(([key, value]) => end[key] !== value)
        || !(stableTime(end.completedAt) >= stableTime(start.launchedAt))
        || !(Number.isSafeInteger(end.exitCode) || (end.exitCode === null && typeof end.signal === "string"))) {
      throw new Error("Provider process launch has no matching observed completion.");
    }
    completed.push(end);
  }
  if (!allowRunning && [...ends.keys()].some((invocationId) => !starts.has(invocationId))) {
    throw new Error("Provider process completion has no matching observed launch.");
  }
  return completed;
}

export function bindProviderProcessObservations(records, attempts, authority) {
  const invocationIds = new Set();
  const providerPids = new Set();
  for (const record of records) {
    if (!completeIdentity(record, authority) || invocationIds.has(record.invocationId)) {
      throw new Error("Duplicate or unbound provider process observation.");
    }
    if (providerPids.has(record.providerProcessId)) throw new Error("Provider PID reused across observations.");
    invocationIds.add(record.invocationId);
    providerPids.add(record.providerProcessId);
  }
  const claimed = new Set();
  return attempts.map((attempt) => {
    const cwd = attemptWorkspaceKey(attempt.cwd);
    const started = stableTime(attempt.startedAt);
    const completed = stableTime(attempt.completedAt);
    const matches = records.filter((record) =>
      cwd !== undefined && pathKey(record.cwd) === cwd
      && attempt.sourceSha === record.sourceSha
      && typeof attempt.sessionId === "string" && attempt.sessionId && record.sessionId === attempt.sessionId
      && stableTime(record.launchedAt) >= started && stableTime(record.completedAt) <= completed
      && stableTime(record.completedAt) >= stableTime(record.launchedAt));
    if (matches.length !== 1 || claimed.has(matches[0].invocationId)) {
      throw new Error(`Provider process observation missing or ambiguous for ${attempt.childRunId}.`);
    }
    claimed.add(matches[0].invocationId);
    return { ...matches[0], childRunId: attempt.childRunId, attemptId: attempt.attemptId };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const authority = Object.fromEntries(
    Object.entries(environmentKeys).map(([key, name]) => [key, process.env[name]]),
  );
  const args = process.argv.slice(2);
  // Readiness and version probes use the same CLI but do not execute a paid JSONL turn.
  if (args.includes("exec") && args.includes("--json") && !args.includes("--help")) {
    process.exitCode = await launchObservedProvider({ ...authority, cwd: process.cwd(), args });
  } else {
    if (!pathKey(authority.executablePath)) throw new Error("Provider executable authority is missing.");
    const child = spawn(authority.executablePath, args, { windowsHide: true, stdio: "inherit" });
    process.exitCode = await new Promise((promiseResolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => promiseResolve(code ?? 1));
    });
  }
}
