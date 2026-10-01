import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const AUDIT_VERSION = "0.1.0";
const VERIFY_RE = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|type-check|check|build|verify)\b|\b(npx\s+)?(jest|vitest|mocha|ava|playwright\s+test|cypress\s+run|tsc|eslint)\b|\bpytest\b|\bpython\d?\s+-m\s+(pytest|unittest)\b|\bgo\s+(test|vet|build)\b|\bcargo\s+(test|build|check|clippy)\b|\bmvn\s+(test|verify)\b|\bgradle\w*\s+test\b|\bmake\s+(test|check)\b|\brspec\b|\bphpunit\b|\bdotnet\s+test\b|\bruff\b|\bmypy\b/u;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

type OutputMode = "human" | "json" | "quiet";
type PriceTuple = readonly [number, number, number, number];
type AuditOptions = {
  days?: number;
  project?: string;
  directory?: string;
  share: boolean;
  offline: boolean;
  help?: boolean;
};
type CliResult = { exitCode: number; stdout: string; stderr: string };
type PriceRecord = {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
};
type Turn = { usd: number; priced: boolean };
type AuditEvent = { kind: "turn"; usd: number } | { kind: "verify"; cmd: string; failed: boolean };
type Session = {
  id: string;
  project: string;
  first: number | null;
  last: number | null;
  turns: Turn[];
  calls: Map<string, string>;
  events: AuditEvent[];
  reportedCost: number | null;
  edits: number;
};
type Score = {
  id: string;
  project: string;
  start: number | null;
  end: number | null;
  usd: number;
  loopUsd: number;
  loops: number;
  attempts: number;
  maxAttempts: number;
  stuck: number;
  verifies: number;
  edits: number;
  endedRed: boolean;
  unverified: boolean;
};
type Summary = {
  tool: "martinloop-audit";
  version: string;
  sessions: number;
  sessionsWithEdits: number;
  from: string | null;
  to: string | null;
  spendUsd: number;
  loopTaxUsd: number;
  loopTaxPct: number;
  fixLoops: number;
  failedVerifierRuns: number;
  longestLoop: number;
  stuckLoops: number;
  sessionsEndedOnRed: number;
  sessionsEditedWithoutVerifier: number;
  pricing: "LiteLLM public prices" | "bundled prices";
  costNote: string;
};

const FALLBACK: Readonly<Record<string, PriceTuple>> = {
  "opus-5-5": [4e-6, 20e-6, 0.2e-6, 5e-6],
  "opus-5": [5e-6, 25e-6, 0.5e-6, 6.25e-6],
  "opus-4-5": [5e-6, 25e-6, 0.5e-6, 6.25e-6],
  "opus-4": [15e-6, 75e-6, 1.5e-6, 18.75e-6],
  "sonnet-5": [2e-6, 10e-6, 0.2e-6, 2.5e-6],
  "sonnet-4-6": [3e-6, 15e-6, 0.3e-6, 3.75e-6],
  "sonnet-4-5": [3e-6, 15e-6, 0.3e-6, 3.75e-6],
  "sonnet-4": [3e-6, 15e-6, 0.3e-6, 3.75e-6],
  "haiku-4-5": [1e-6, 5e-6, 0.1e-6, 1.25e-6],
  "haiku": [0.8e-6, 4e-6, 0.08e-6, 1e-6],
};

const HELP = [
  "martin-loop audit " + AUDIT_VERSION,
  "Measure how much of your Claude Code spend goes to fix-and-retry loops.",
  "",
  "Usage: npx -y martin-loop@latest audit [options]",
  "",
  "  --days <n>        Only sessions from the last n days (default: all)",
  "  --project <text>  Only projects whose path contains <text>",
  "  --dir <path>      Claude Code config dir (default: ~/.claude and ~/.config/claude)",
  "  --json            Machine-readable output",
  "  --share           Write loop-tax-card.svg and loop-tax.md to the current directory",
  "  --offline         Use bundled prices only; make no pricing request",
  "",
  "Session data is read and analyzed locally. By default MartinLoop may fetch the",
  "public LiteLLM model-price list; no session contents are sent. Use --offline for",
  "zero network access.",
].join("\n");

function priceFor(model: string, live: Record<string, PriceRecord>): PriceTuple | null {
  const normalized = model.replace(/-\d{8}$/u, "");
  const record = live[model] ?? live[normalized];
  if (record?.input_cost_per_token !== undefined) {
    const input = record.input_cost_per_token;
    return [
      input,
      record.output_cost_per_token ?? 0,
      record.cache_read_input_token_cost ?? input * 0.1,
      record.cache_creation_input_token_cost ?? input * 1.25,
    ];
  }
  const key = Object.keys(FALLBACK).sort((a, b) => b.length - a.length).find((candidate) => normalized.includes(candidate));
  return key === undefined ? null : FALLBACK[key] ?? null;
}

function usageCost(model: string, usage: Record<string, unknown>, live: Record<string, PriceRecord>): Turn {
  const price = priceFor(model, live);
  if (price === null) return { usd: 0, priced: false };
  const n = (key: string): number => typeof usage[key] === "number" ? Number(usage[key]) : 0;
  return {
    usd:
      n("input_tokens") * price[0] +
      n("output_tokens") * price[1] +
      n("cache_read_input_tokens") * price[2] +
      n("cache_creation_input_tokens") * price[3],
    priced: true,
  };
}

async function loadPrices(offline: boolean): Promise<Record<string, PriceRecord>> {
  if (offline) return {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(
      "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
      { signal: controller.signal },
    );
    if (!response.ok) return {};
    const parsed: unknown = await response.json();
    return parsed !== null && typeof parsed === "object" ? parsed as Record<string, PriceRecord> : {};
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

function roots(directory?: string): string[] {
  const env = process.env["CLAUDE_CONFIG_DIR"];
  const envRoots = env ? env.split(path.delimiter).filter(Boolean) : [];
  const candidates = directory
    ? [directory]
    : [...envRoots, path.join(homedir(), ".claude"), path.join(homedir(), ".config", "claude")];
  return [...new Set(candidates)].map((root) => path.join(root, "projects")).filter(existsSync);
}

function filesUnder(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) filesUnder(full, out);
    else if (entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function parseFile(
  file: string,
  since: number | null,
  prices: Record<string, PriceRecord>,
  seenTurnKeys: Set<string>,
  seenToolUseIds: Set<string>,
  seenVerifierKeys: Set<string>,
): Session[] {
  const sessions = new Map<string, Session>();
  const getSession = (id: string, row: Record<string, unknown>): Session => {
    const current = sessions.get(id);
    if (current) return current;
    const created: Session = {
      id,
      project: typeof row["cwd"] === "string" ? row["cwd"] : path.basename(path.dirname(file)),
      first: null,
      last: null,
      turns: [],
      calls: new Map(),
      events: [],
      reportedCost: null,
      edits: 0,
    };
    sessions.set(id, created);
    return created;
  };

  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let row: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (value === null || typeof value !== "object") continue;
      row = value as Record<string, unknown>;
    } catch {
      continue;
    }
    const id = row["sessionId"];
    if (typeof id !== "string" || id.length === 0) continue;
    const parsedTs = typeof row["timestamp"] === "string" ? Date.parse(row["timestamp"]) : Number.NaN;
    const ts = Number.isFinite(parsedTs) ? parsedTs : null;
    if (since !== null && ts !== null && ts < since) continue;

    const session = getSession(id, row);
    if (ts !== null) {
      session.first = session.first === null ? ts : Math.min(session.first, ts);
      session.last = session.last === null ? ts : Math.max(session.last, ts);
    }
    if (row["type"] === "cost-state" && typeof row["totalCostUSD"] === "number") {
      session.reportedCost = Math.max(session.reportedCost ?? 0, row["totalCostUSD"]);
    }

    const rawMessage = row["message"];
    const message = rawMessage !== null && typeof rawMessage === "object" ? rawMessage as Record<string, unknown> : undefined;
    if (row["type"] === "assistant" && message) {
      const rawUsage = message["usage"];
      if (rawUsage !== null && typeof rawUsage === "object") {
        const key = String(message["id"] ?? "unknown") + ":" + String(row["requestId"] ?? "unknown");
        if (!seenTurnKeys.has(key)) {
          seenTurnKeys.add(key);
          const turn = usageCost(typeof message["model"] === "string" ? message["model"] : "", rawUsage as Record<string, unknown>, prices);
          session.turns.push(turn);
          session.events.push({ kind: "turn", usd: turn.usd });
        }
      }
      const content = Array.isArray(message["content"]) ? message["content"] : [];
      for (const rawBlock of content) {
        if (rawBlock === null || typeof rawBlock !== "object") continue;
        const block = rawBlock as Record<string, unknown>;
        if (block["type"] !== "tool_use") continue;
        const name = block["name"];
        const toolId = block["id"];
        // Copied calls still need a local lookup for new results in resumed/forked files.
        if (name === "Bash") {
          const rawInput = block["input"];
          const input = rawInput !== null && typeof rawInput === "object" ? rawInput as Record<string, unknown> : undefined;
          if (typeof toolId === "string" && typeof input?.["command"] === "string" && !session.calls.has(toolId)) {
            session.calls.set(toolId, input["command"].replace(/\s+/gu, " ").trim().slice(0, 200));
          }
        }
        if (typeof toolId === "string") {
          if (seenToolUseIds.has(toolId)) continue;
          seenToolUseIds.add(toolId);
        }
        if (typeof name === "string" && EDIT_TOOLS.has(name)) session.edits += 1;
      }
    }

    if (row["type"] === "user" && message && Array.isArray(message["content"])) {
      for (const rawBlock of message["content"]) {
        if (rawBlock === null || typeof rawBlock !== "object") continue;
        const block = rawBlock as Record<string, unknown>;
        if (block["type"] !== "tool_result" || typeof block["tool_use_id"] !== "string") continue;
        const cmd = session.calls.get(block["tool_use_id"]);
        if (!cmd || !VERIFY_RE.test(cmd)) continue;
        const raw = block["content"];
        const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
        const verifierDigest = createHash("sha256").update(text).digest("hex");
        const verifierKey = String(block["tool_use_id"]) + ":" + cmd + ":" + verifierDigest;
        if (seenVerifierKeys.has(verifierKey)) continue;
        seenVerifierKeys.add(verifierKey);
        const failed = block["is_error"] === true || /(?:^|\n)Exit code [1-9]\d*/u.test(text);
        session.events.push({ kind: "verify", cmd, failed });
      }
    }
  }
  return [...sessions.values()];
}

function score(session: Session): Score {
  const computed = session.turns.reduce((sum, turn) => sum + turn.usd, 0);
  const total = session.reportedCost ?? computed;
  const scale = computed > 0 && session.reportedCost !== null ? session.reportedCost / computed : 1;
  let inLoop = false;
  let loopUsd = 0;
  let loops = 0;
  let attempts = 0;
  let maxAttempts = 0;
  let current = 0;
  let stuck = 0;
  let lastCmd: string | null = null;
  let sameFailures = 0;
  let verifies = 0;
  let lastFailed = false;

  for (const event of session.events) {
    if (event.kind === "turn") {
      if (inLoop) loopUsd += event.usd * scale;
      continue;
    }
    verifies += 1;
    lastFailed = event.failed;
    if (event.failed) {
      if (!inLoop) {
        inLoop = true;
        loops += 1;
        current = 0;
      }
      current += 1;
      attempts += 1;
      maxAttempts = Math.max(maxAttempts, current);
      sameFailures = event.cmd === lastCmd ? sameFailures + 1 : 1;
      if (sameFailures === 3) stuck += 1;
    } else {
      inLoop = false;
      current = 0;
      sameFailures = 0;
    }
    lastCmd = event.cmd;
  }

  return {
    id: session.id,
    project: session.project,
    start: session.first,
    end: session.last,
    usd: total,
    loopUsd,
    loops,
    attempts,
    maxAttempts,
    stuck,
    verifies,
    edits: session.edits,
    endedRed: verifies > 0 && lastFailed,
    unverified: session.edits > 0 && verifies === 0,
  };
}

function summarize(rows: Score[], online: boolean): Summary {
  const sum = rows.reduce((acc, row) => ({
    usd: acc.usd + row.usd,
    loopUsd: acc.loopUsd + row.loopUsd,
    loops: acc.loops + row.loops,
    attempts: acc.attempts + row.attempts,
    longest: Math.max(acc.longest, row.maxAttempts),
    stuck: acc.stuck + row.stuck,
    red: acc.red + (row.endedRed ? 1 : 0),
    unverified: acc.unverified + (row.unverified ? 1 : 0),
    edits: acc.edits + (row.edits > 0 ? 1 : 0),
  }), { usd: 0, loopUsd: 0, loops: 0, attempts: 0, longest: 0, stuck: 0, red: 0, unverified: 0, edits: 0 });
  const starts = rows.flatMap((row) => row.start === null ? [] : [row.start]);
  const ends = rows.flatMap((row) => row.end === null ? [] : [row.end]);
  return {
    tool: "martinloop-audit",
    version: AUDIT_VERSION,
    sessions: rows.length,
    sessionsWithEdits: sum.edits,
    from: starts.length === 0 ? null : new Date(Math.min(...starts)).toISOString().slice(0, 10),
    to: ends.length === 0 ? null : new Date(Math.max(...ends)).toISOString().slice(0, 10),
    spendUsd: Number(sum.usd.toFixed(2)),
    loopTaxUsd: Number(sum.loopUsd.toFixed(2)),
    loopTaxPct: sum.usd > 0 ? Math.round((sum.loopUsd / sum.usd) * 100) : 0,
    fixLoops: sum.loops,
    failedVerifierRuns: sum.attempts,
    longestLoop: sum.longest,
    stuckLoops: sum.stuck,
    sessionsEndedOnRed: sum.red,
    sessionsEditedWithoutVerifier: sum.unverified,
    pricing: online ? "LiteLLM public prices" : "bundled prices",
    costNote: "Session totals use Claude Code's own cost record when present; otherwise API list prices. Subscription users pay a flat fee, so read this as API-equivalent spend.",
  };
}

function money(value: number): string {
  return "$" + (value >= 100 ? value.toFixed(0) : value.toFixed(2));
}

function renderHuman(summary: Summary, top: Score[]): string {
  const lines = [
    "",
    "∞ MartinLoop audit  " + summary.sessions + " session" + (summary.sessions === 1 ? "" : "s") + " · " + (summary.from ?? "n/a") + " → " + (summary.to ?? "n/a"),
    "──────────────────────────────────────────────────────────",
    "  Agent spend (API-equivalent)   " + money(summary.spendUsd),
    "  Spent inside fix loops         " + money(summary.loopTaxUsd) + "  (" + summary.loopTaxPct + "% loop tax)",
    "  Fix loops                      " + summary.fixLoops + "  (" + summary.failedVerifierRuns + " failed verifier runs, longest " + summary.longestLoop + " in a row)",
    "  Stuck loops (same cmd fails 3×) " + summary.stuckLoops,
    "  Sessions that ended on red     " + summary.sessionsEndedOnRed,
    "  Edited code, never ran a check " + summary.sessionsEditedWithoutVerifier + "  (of " + summary.sessionsWithEdits + " sessions with edits)",
  ];
  const expensive = top.filter((row) => row.loopUsd > 0);
  if (expensive.length > 0) {
    lines.push("──────────────────────────────────────────────────────────", "  Most expensive loops");
    for (const row of expensive) {
      const name = row.project.split(/[\\/]/u).filter(Boolean).slice(-2).join("/");
      const date = row.start === null ? "n/a" : new Date(row.start).toISOString().slice(0, 10);
      lines.push("  " + money(row.loopUsd).padStart(8) + "  " + String(row.maxAttempts).padStart(2) + "× retries  " + date + "  " + name);
    }
  }
  lines.push(
    "──────────────────────────────────────────────────────────",
    "  " + summary.costNote,
    "",
    '  Cap the next one:  npx -y martin-loop@latest run "<task>" --verify "npm test" --budget-usd 2 --max-iterations 3',
    "  Share yours:       npx -y martin-loop@latest audit --share",
    "",
  );
  return lines.join("\n");
}

function writeShare(summary: Summary): void {
  const esc = (value: unknown): string => String(value).replace(/[&<>]/gu, (char) => char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;");
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">' +
    '<rect width="1200" height="630" fill="#17132A"/><rect width="12" height="630" fill="#6552D0"/>' +
    '<text x="80" y="110" font-family="Georgia,serif" font-size="34" fill="#B9AEF5">My coding-agent loop tax</text>' +
    '<text x="80" y="250" font-family="Georgia,serif" font-weight="700" font-size="140" fill="#FFFFFF">' + summary.loopTaxPct + '%</text>' +
    '<text x="80" y="310" font-family="Arial,sans-serif" font-size="30" fill="#D8D3EE">of ' + esc(money(summary.spendUsd)) + ' agent spend went to fix-and-retry loops</text>' +
    '<text x="80" y="410" font-family="Arial,sans-serif" font-size="26" fill="#FFFFFF">' + summary.fixLoops + ' fix loops · longest ' + summary.longestLoop + ' retries · ' + summary.sessionsEndedOnRed + ' ended on red</text>' +
    '<text x="80" y="570" font-family="Courier New,monospace" font-size="28" fill="#B9AEF5">npx martin-loop@latest audit</text>' +
    '<text x="1120" y="570" text-anchor="end" font-family="Georgia,serif" font-weight="700" font-size="30" fill="#FFFFFF">MartinLoop.</text></svg>';
  writeFileSync(path.join(process.cwd(), "loop-tax-card.svg"), svg, "utf8");
  writeFileSync(
    path.join(process.cwd(), "loop-tax.md"),
    "My coding-agent loop tax: **" + summary.loopTaxPct + "%** of " + money(summary.spendUsd) + " agent spend went to fix-and-retry loops.\n\n" +
      "- " + summary.fixLoops + " fix loops, longest " + summary.longestLoop + " retries in a row\n" +
      "- " + summary.stuckLoops + " stuck loops (same command failing 3+ times)\n" +
      "- " + summary.sessionsEndedOnRed + " sessions ended with a failing check\n\n" +
      "Measured locally with npx martin-loop@latest audit across " + summary.sessions + " Claude Code session" + (summary.sessions === 1 ? "" : "s") + ".\n",
    "utf8",
  );
}

export async function executeAuditCommand(options: AuditOptions, outputMode: OutputMode): Promise<CliResult> {
  if (options.help === true) return { exitCode: 0, stdout: HELP, stderr: "" };
  if (options.days !== undefined && (!Number.isFinite(options.days) || options.days <= 0 || !Number.isInteger(options.days))) {
    return { exitCode: 2, stdout: "", stderr: "Error [invalid_input]: --days must be a positive integer." };
  }
  const configured = roots(options.directory);
  if (configured.length === 0) {
    return {
      exitCode: 3,
      stdout: "",
      stderr: "No Claude Code history found (looked in ~/.claude/projects and ~/.config/claude/projects). Use --dir to point at your Claude config directory.",
    };
  }
  const prices = await loadPrices(options.offline);
  const since = options.days === undefined ? null : Date.now() - options.days * 86_400_000;
  const sessions: Session[] = [];
  const seenTurnKeys = new Set<string>();
  const seenToolUseIds = new Set<string>();
  const seenVerifierKeys = new Set<string>();
  for (const root of configured) {
    for (const file of filesUnder(root)) {
      sessions.push(...parseFile(file, since, prices, seenTurnKeys, seenToolUseIds, seenVerifierKeys));
    }
  }
  const merged = new Map<string, Session>();
  for (const session of sessions) {
    const existing = merged.get(session.id);
    if (!existing) {
      merged.set(session.id, session);
      continue;
    }
    existing.turns.push(...session.turns);
    existing.events.push(...session.events);
    existing.edits += session.edits;
    existing.first = existing.first === null ? session.first : session.first === null ? existing.first : Math.min(existing.first, session.first);
    existing.last = existing.last === null ? session.last : session.last === null ? existing.last : Math.max(existing.last, session.last);
    if (session.reportedCost !== null) existing.reportedCost = Math.max(existing.reportedCost ?? 0, session.reportedCost);
  }
  let rows = [...merged.values()].filter((session) => session.turns.length > 0).map(score);
  if (options.project !== undefined) rows = rows.filter((row) => row.project.includes(options.project ?? ""));
  const summary = summarize(rows, Object.keys(prices).length > 0);
  const top = [...rows].sort((a, b) => b.loopUsd - a.loopUsd).slice(0, 5);
  if (options.share) writeShare(summary);

  if (outputMode === "json") return { exitCode: 0, stdout: JSON.stringify({ summary, topSessions: top }, null, 2), stderr: "" };
  if (outputMode === "quiet") return { exitCode: 0, stdout: String(summary.loopTaxPct), stderr: "" };
  const human = renderHuman(summary, top);
  return { exitCode: 0, stdout: options.share ? human + "\n  Wrote loop-tax-card.svg and loop-tax.md\n" : human, stderr: "" };
}

export const AUDIT_HELP = HELP;
