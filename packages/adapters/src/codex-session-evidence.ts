import { createHash } from "node:crypto";
import { open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface CodexTokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

interface CodexSessionBinding {
  threadId: string;
  workingDirectory: string;
  startedAt: number;
  completedAt: number;
  usage?: CodexTokenUsage;
}

type CodexSessionEvidence =
  | { state: "missing" }
  | { state: "invalid" }
  | { state: "bound"; sessionId: string; turnId: string; model: string; usage: CodexTokenUsage; sha256: string };

const SESSION_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const MAX_ROLLOUT_BYTES = 32 * 1024 * 1024;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function readCodexTokenUsage(value: unknown): CodexTokenUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const input = usage["input_tokens"];
  const output = usage["output_tokens"];
  const cached = usage["cached_input_tokens"] ?? 0;
  const reasoning = usage["reasoning_output_tokens"] ?? 0;
  const isTokenCount = (count: unknown): count is number =>
    typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
  if (!isTokenCount(input) || !isTokenCount(output) || !isTokenCount(cached) || !isTokenCount(reasoning)
    || cached > input || reasoning > output) return undefined;
  return { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning };
}

function sessionDays(startedAt: number, completedAt: number): Set<string> {
  const days = new Set<string>();
  for (const time of [startedAt, completedAt]) {
    const date = new Date(time);
    days.add(date.toISOString().slice(0, 10).replaceAll("-", sep));
    days.add(join(
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ));
  }
  return days;
}

function isInside(directory: string, path: string): boolean {
  const child = relative(directory, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Bind one fresh rollout to the new thread emitted by the provider subprocess. */
export async function readCodexSessionEvidence(input: CodexSessionBinding): Promise<CodexSessionEvidence> {
  if (!SESSION_ID.test(input.threadId)) return { state: "missing" };
  const configuredHome = process.env["CODEX_HOME"]?.trim();
  if (configuredHome && !isAbsolute(configuredHome)) return { state: "invalid" };
  try {
    const root = await realpath(join(configuredHome || join(homedir(), ".codex"), "sessions"));
    const cwd = await realpath(input.workingDirectory).catch((error: unknown) => {
      // A retained attempt can be inspected after its worktree was cleaned up.
      if (isMissing(error)) return resolve(input.workingDirectory);
      throw error;
    });
    if (isInside(cwd, root)) return { state: "invalid" };
    const paths: string[] = [];
    for (const day of sessionDays(input.startedAt, input.completedAt)) {
      const folder = join(root, day);
      try {
        if (!isInside(root, await realpath(folder))) return { state: "invalid" };
        for (const entry of await readdir(folder, { withFileTypes: true })) {
          if (!entry.name.startsWith("rollout-") || !entry.name.endsWith(`-${input.threadId}.jsonl`)) continue;
          if (!entry.isFile()) return { state: "invalid" };
          paths.push(join(folder, entry.name));
        }
      } catch (error) {
        if (!isMissing(error)) return { state: "invalid" };
      }
    }
    if (paths.length === 0) return { state: "missing" };
    if (paths.length !== 1) return { state: "invalid" };
    const path = paths[0]!;
    if (!isInside(root, await realpath(path))) return { state: "invalid" };
    const file = await open(path, "r");
    let bytes: Buffer;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_ROLLOUT_BYTES) return { state: "invalid" };
      bytes = await file.readFile();
    } finally {
      await file.close();
    }
    return await inspectRollout(bytes, input, cwd);
  } catch (error) {
    return { state: isMissing(error) ? "missing" : "invalid" };
  }
}

async function sameWorkingDirectory(value: unknown, boundCwd: string): Promise<boolean> {
  if (typeof value !== "string" || !isAbsolute(value)) return false;
  // Preserve exact lexical matches after the workspace has been cleaned up.
  if (relative(boundCwd, resolve(value)) === "") return true;
  // A different spelling must resolve to the exact bound directory.
  const physical = await realpath(value).catch(() => undefined);
  return physical !== undefined && relative(boundCwd, physical) === "";
}

async function inspectRollout(bytes: Buffer, input: CodexSessionBinding, boundCwd: string): Promise<CodexSessionEvidence> {
  const rows = bytes.toString("utf8").split(/\r?\n/u).filter(Boolean).map((line) => asRecord(JSON.parse(line)));
  const evidence = rows.flatMap((row, index) => {
    const payload = asRecord(row?.["payload"]);
    return row && payload ? [{ type: row["type"], payload, timestamp: row["timestamp"], index }] : [];
  });
  if (evidence.length !== rows.length) return { state: "invalid" };

  const meta = evidence.filter((row) => row.type === "session_meta");
  const context = evidence.filter((row) => row.type === "turn_context");
  const messages = evidence.filter((row) => row.type === "event_msg");
  const started = messages.filter((row) => row.payload["type"] === "task_started");
  const completed = messages.filter((row) => row.payload["type"] === "task_complete");
  if (meta.length !== 1 || meta[0]?.index !== 0 || context.length !== 1 || started.length !== 1 || completed.length !== 1) {
    return { state: "invalid" };
  }
  const session = meta[0];
  const turnStart = started[0]!;
  const turnContext = context[0]!;
  const turnEnd = completed[0]!;
  const turnId = turnStart.payload["turn_id"];
  const model = turnContext.payload["model"];
  const inLaunchWindow = (value: unknown): boolean => {
    const time = typeof value === "string" ? Date.parse(value) : NaN;
    return time >= input.startedAt && time <= input.completedAt;
  };
  if (session.payload["id"] !== input.threadId
    || (session.payload["session_id"] !== undefined && session.payload["session_id"] !== input.threadId)
    || session.payload["source"] !== "exec"
    || typeof turnId !== "string" || !SESSION_ID.test(turnId)
    || turnContext.payload["turn_id"] !== turnId || turnEnd.payload["turn_id"] !== turnId
    || !(turnStart.index < turnContext.index && turnContext.index < turnEnd.index)
    || ![session.payload["timestamp"], session.timestamp, turnStart.timestamp, turnContext.timestamp, turnEnd.timestamp]
      .every(inLaunchWindow)
    || typeof model !== "string" || model.trim().length === 0) return { state: "invalid" };
  if (messages.some((row) => ["model_reroute", "turn_aborted", "task_failed"].includes(String(row.payload["type"])))) {
    return { state: "invalid" };
  }
  const lastTokenRow = messages.filter((row) =>
    row.payload["type"] === "token_count" && row.index > turnContext.index && row.index < turnEnd.index).at(-1);
  const usage = readCodexTokenUsage(asRecord(lastTokenRow?.payload["info"])?.["total_token_usage"]);
  if (!usage || !inLaunchWindow(lastTokenRow?.timestamp)) return { state: "invalid" };
  if (input.usage && (
    usage.input_tokens !== input.usage.input_tokens || usage.output_tokens !== input.usage.output_tokens
    || usage.cached_input_tokens !== input.usage.cached_input_tokens
    || usage.reasoning_output_tokens !== input.usage.reasoning_output_tokens
  )) return { state: "invalid" };
  for (const cwd of new Set([session.payload["cwd"], turnContext.payload["cwd"]])) {
    if (!await sameWorkingDirectory(cwd, boundCwd)) return { state: "invalid" };
  }
  return {
    state: "bound",
    sessionId: input.threadId,
    turnId,
    model,
    usage,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}
