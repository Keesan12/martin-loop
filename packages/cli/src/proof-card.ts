import type { ReceiptIntegrityState } from "@martin/contracts";

export interface MartinProofCardInput {
  loopId: string;
  objective: string;
  status: string;
  lifecycle: string;
  verifierStatus: string;
  costSpend: string | number;
  budget: string | number;
  remainingBudget?: string | number;
  overspendRatio?: string | number;
  attempts: string | number;
  rollbackStatus: string;
  haltReason: string;
  evidenceBoundaryNotes: string | readonly string[];
  verificationStepCount?: string | number;
  runMode?: string;
  runtime?: string;
  timelineEvents?: readonly string[];
  generatedAt: string;
  receiptIntegrityState?: ReceiptIntegrityState;
}

export interface MartinProofCardField {
  label: string;
  value: string;
}

export interface MartinProofCard {
  title: string;
  fields: readonly MartinProofCardField[];
  evidenceLine: string;
  generatedAt: string;
  completeEvidence: boolean;
  proofVerdict: "VERIFIED" | "HALTED" | "FAILED" | "EVIDENCE_BOUNDARY";
  taskLabel: string;
  timelineEvents: readonly string[];
}

const COMPLETE_EVIDENCE_LINE = "Martin stopped Ralph here.";
const INCOMPLETE_EVIDENCE_LINE =
  "Incomplete Martin proof: missing budget, rollback, or verifier evidence.";
const NON_MUTATING_EVIDENCE_LINE =
  "Proof or verifier-only runs are evidence boundaries, not real Martin mutation receipts.";
const UNSIGNED_EVIDENCE_LINE = "Receipt integrity unavailable: Martin proof is not yet trustworthy.";
const TAMPERED_EVIDENCE_LINE = "Receipt integrity failed: Martin proof is not trustworthy.";
const RELOCATED_EVIDENCE_LINE = "Receipt relocated: Martin proof requires canonical verification.";
const NONCANONICAL_EVIDENCE_LINE = "Receipt loaded via non-canonical selector: trust is downgraded.";
const MATERIAL_MISSING_EVIDENCE_LINE = "Receipt integrity material missing: Martin proof is not trustworthy.";

const FIELD_LABELS = {
  loopId: "Loop ID",
  objective: "Objective",
  status: "Status",
  lifecycle: "Lifecycle",
  verifierStatus: "Verifier",
  costSpend: "Cost / spend",
  budget: "Budget",
  remainingBudget: "Remaining budget",
  overspendRatio: "Overspend ratio",
  attempts: "Attempts",
  rollbackStatus: "Rollback",
  receiptIntegrityState: "Receipt integrity",
  haltReason: "Halt reason",
  evidenceBoundaryNotes: "Evidence boundary",
  verificationStepCount: "Verification steps",
  runMode: "Run mode",
  runtime: "Runtime",
  generatedAt: "Generated at"
} as const;

export function buildMartinProofCard(input: MartinProofCardInput): MartinProofCard {
  const generatedAt = sanitizeText(input.generatedAt);
  const evidenceBoundaryNotes =
    typeof input.evidenceBoundaryNotes === "string"
      ? sanitizeText(input.evidenceBoundaryNotes)
      : input.evidenceBoundaryNotes.map((note) => sanitizeText(note)).join("; ");

  const fields: MartinProofCardField[] = [
    { label: FIELD_LABELS.loopId, value: sanitizeText(input.loopId) },
    { label: FIELD_LABELS.objective, value: sanitizeText(input.objective) },
    { label: FIELD_LABELS.status, value: sanitizeText(input.status) },
    { label: FIELD_LABELS.lifecycle, value: sanitizeText(input.lifecycle) },
    { label: FIELD_LABELS.verifierStatus, value: sanitizeText(input.verifierStatus) },
    { label: FIELD_LABELS.costSpend, value: sanitizeText(input.costSpend) },
    { label: FIELD_LABELS.budget, value: sanitizeText(input.budget) },
    { label: FIELD_LABELS.remainingBudget, value: sanitizeOptionalText(input.remainingBudget) },
    { label: FIELD_LABELS.overspendRatio, value: sanitizeOptionalText(input.overspendRatio) },
    { label: FIELD_LABELS.attempts, value: sanitizeText(input.attempts) },
    { label: FIELD_LABELS.rollbackStatus, value: sanitizeText(input.rollbackStatus) },
    ...(input.receiptIntegrityState
      ? [
          {
            label: FIELD_LABELS.receiptIntegrityState,
            value: sanitizeText(input.receiptIntegrityState)
          }
        ]
      : []),
    {
      label: FIELD_LABELS.verificationStepCount,
      value: sanitizeOptionalText(input.verificationStepCount)
    },
    { label: FIELD_LABELS.runMode, value: sanitizeOptionalText(input.runMode) },
    { label: FIELD_LABELS.runtime, value: sanitizeOptionalText(input.runtime) },
    { label: FIELD_LABELS.haltReason, value: sanitizeText(input.haltReason) },
    {
      label: FIELD_LABELS.evidenceBoundaryNotes,
      value: evidenceBoundaryNotes
    },
    { label: FIELD_LABELS.generatedAt, value: generatedAt }
  ];

  const trustworthyReceipt =
    input.receiptIntegrityState === undefined || input.receiptIntegrityState === "verified";
  const proofLikeRun = /^(proof|verify_only)$/iu.test(String(input.runMode ?? "").trim());
  const completeEvidence =
    trustworthyReceipt &&
    !proofLikeRun &&
    hasEvidence(input.budget) &&
    hasEvidence(input.rollbackStatus) &&
    hasEvidence(input.verifierStatus);
  const evidenceLine =
    input.receiptIntegrityState === "tamper_detected"
      ? TAMPERED_EVIDENCE_LINE
      : input.receiptIntegrityState === "material_missing"
        ? MATERIAL_MISSING_EVIDENCE_LINE
        : input.receiptIntegrityState === "relocated"
          ? RELOCATED_EVIDENCE_LINE
      : input.receiptIntegrityState === "selector_noncanonical"
            ? NONCANONICAL_EVIDENCE_LINE
      : proofLikeRun
        ? NON_MUTATING_EVIDENCE_LINE
      : input.receiptIntegrityState === "unsigned"
        ? UNSIGNED_EVIDENCE_LINE
        : completeEvidence
          ? COMPLETE_EVIDENCE_LINE
          : INCOMPLETE_EVIDENCE_LINE;

  return {
    title: "Martin Loop Proof Receipt",
    fields,
    evidenceLine,
    generatedAt,
    completeEvidence,
    proofVerdict: deriveProofVerdict({
      completeEvidence,
      status: input.status,
      lifecycle: input.lifecycle,
      verifierStatus: input.verifierStatus,
      receiptIntegrityState: input.receiptIntegrityState
    }),
    taskLabel: deriveTaskLabel(input.objective),
    timelineEvents: normalizeTimelineEvents(input.timelineEvents)
  };
}

export function renderMartinProofCardMarkdown(card: MartinProofCard): string {
  const rows = card.fields.map(
    (field) => `| ${escapeMarkdownCell(field.label)} | ${escapeMarkdownCell(field.value)} |`
  );

  return [
    `# ${escapeMarkdownText(card.title)}`,
    "",
    escapeMarkdownText(card.evidenceLine),
    "",
    "| Field | Evidence |",
    "| --- | --- |",
    ...rows,
    ""
  ].join("\n");
}

export function renderMartinProofCardSvg(card: MartinProofCard): string {
  const width = 1200;
  const height = 675;
  const margin = 46;
  const accent = verdictColor(card.proofVerdict);
  const field = (label: string) => getFieldValue(card.fields, label);
  const metrics: readonly (readonly [string, string])[] = [
    ["cost_usd", normalizeMoneyValue(field("Cost / spend"))],
    ["budget_usd", normalizeMoneyValue(field("Budget"))],
    ["remaining_usd", normalizeMoneyValue(field("Remaining budget"))],
    ["overspend_ratio", normalizeCliValue(field("Overspend ratio"))],
    ["attempts", normalizeCliValue(field("Attempts"))],
    ["rollback", normalizeCliValue(field("Rollback"))],
    ["receipt_integrity", normalizeCliValue(field("Receipt integrity"))]
  ];
  const meta: readonly (readonly [string, string])[] = [
    ["task", card.taskLabel],
    ["run_mode", normalizeCliValue(field("Run mode"))],
    ["runtime", normalizeCliValue(field("Runtime"))],
    [
      "verifier",
      `${normalizeCliValue(field("Verifier"))} / steps:${normalizeCliValue(field("Verification steps"))}`
    ],
    ["halt_reason", normalizeCliValue(field("Halt reason"))]
  ];
  const boundary = normalizeBoundaryLine(field("Evidence boundary"));
  const command = `$ martin runs verify --loop-id ${field("Loop ID")}`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeSvg(card.title)}">`,
    "<defs>",
    `<style>${svgStyle()}</style>`,
    "</defs>",
    "<desc>Martin Loop Proof Card</desc>",
    '<rect width="1200" height="675" fill="#101010"/>',
    `<line x1="${margin}" y1="42" x2="${width - margin}" y2="42" stroke="#3f3f3f"/>`,
    `<text class="title" x="${margin}" y="87">MARTIN LOOP :: PROOF RECEIPT</text>`,
    `<text class="verdict" x="${width - margin}" y="87" text-anchor="end" fill="${accent}">[${escapeSvg(card.proofVerdict)}]</text>`,
    `<line x1="${margin}" y1="111" x2="${width - margin}" y2="111" stroke="${accent}"/>`,
    `<text class="prompt" x="${margin}" y="148">${escapeSvg(command)}</text>`,
    `<text class="mono" x="${margin}" y="178" fill="#e8e8e3">result: ${escapeSvg(normalizeCliValue(field("Verifier")))}  |  proof: ${escapeSvg(card.proofVerdict.toLowerCase())}</text>`,
    `<text class="muted" x="${margin}" y="210">${escapeSvg(truncateText(card.evidenceLine, 118))}</text>`,
    `<line x1="${margin}" y1="236" x2="${width - margin}" y2="236" stroke="#303030"/>`,
    `<text class="section" x="${margin}" y="274">METRICS</text>`,
    ...renderCliRows(metrics, margin, 310, 31, accent, 38),
    '<line x1="624" y1="258" x2="624" y2="512" stroke="#303030"/>',
    '<text class="section" x="660" y="274">RUN CONTEXT</text>',
    ...renderCliRows(meta, 660, 310, 31, accent, 31),
    '<text class="section" x="660" y="468">EVENT RAIL</text>',
    renderEventRail(card.timelineEvents, 660, 505, accent),
    `<line x1="${margin}" y1="535" x2="${width - margin}" y2="535" stroke="#303030"/>`,
    `<text class="section" x="${margin}" y="575">BOUNDARY</text>`,
    `<text class="mono" x="166" y="575" fill="#e8e8e3">${escapeSvg(truncateText(boundary, 86))}</text>`,
    `<text class="footer" x="${margin}" y="626">generated_at=${escapeSvg(card.generatedAt)}</text>`,
    `<text class="footer" x="${width - margin}" y="626" text-anchor="end">offline-verifiable local run evidence</text>`,
    "</svg>"
  ].join("");
}

function getFieldValue(fields: readonly MartinProofCardField[], label: string): string {
  return fields.find((field) => field.label === label)?.value ?? "unknown";
}

function renderCliRows(
  rows: readonly (readonly [string, string])[],
  x: number,
  startY: number,
  rowGap: number,
  accent: string,
  maxValueLength: number
): string[] {
  return rows.map(([label, value], index) => {
    const y = startY + index * rowGap;
    const color = valueColor(value, accent);
    const dots = ".".repeat(Math.max(3, 24 - label.length));
    return `<text class="mono" x="${x}" y="${y}"><tspan fill="#8b8b84">${escapeSvg(label)}</tspan><tspan fill="#575750"> ${dots} </tspan><tspan fill="${color}">${escapeSvg(truncateText(value, maxValueLength))}</tspan></text>`;
  });
}

function renderEventRail(events: readonly string[], x: number, y: number, accent: string): string {
  const visible = events.slice(0, 5);
  const hasFailure = visible.some((event) => /fail|reject|missing|breach|error|tamper/iu.test(event));
  const lineColor = hasFailure ? "#d35f5f" : accent;
  const rail = visible.map((event) => compactEventName(event)).join(" -> ");

  return [
    `<line x1="${x}" y1="${y}" x2="1136" y2="${y}" stroke="#3a3a36"/>`,
    `<line x1="${x}" y1="${y - 8}" x2="${x}" y2="${y + 8}" stroke="${lineColor}" stroke-width="2"/>`,
    `<text class="tiny" x="${x + 18}" y="${y + 29}" fill="#c7c7bf">${escapeSvg(truncateText(rail, 70))}</text>`
  ].join("");
}

function svgStyle(): string {
  return [
    ".title{font-family:'SF Pro Display','Geist','Satoshi',system-ui,sans-serif;font-size:28px;font-weight:680;letter-spacing:.08em;fill:#f3f3ee}",
    ".verdict{font-family:'SF Mono','Geist Mono','JetBrains Mono',ui-monospace,monospace;font-size:19px;font-weight:760;letter-spacing:.08em}",
    ".prompt{font-family:'SF Mono','Geist Mono','JetBrains Mono',ui-monospace,monospace;font-size:19px;font-weight:650;fill:#f3f3ee}",
    ".mono{font-family:'SF Mono','Geist Mono','JetBrains Mono',ui-monospace,monospace;font-size:17px;font-weight:560;letter-spacing:0}",
    ".section{font-family:'SF Mono','Geist Mono','JetBrains Mono',ui-monospace,monospace;font-size:13px;font-weight:720;letter-spacing:.14em;fill:#8b8b84}",
    ".muted{font-family:'SF Mono','Geist Mono','JetBrains Mono',ui-monospace,monospace;font-size:16px;font-weight:520;fill:#aaa9a0}",
    ".footer{font-family:'SF Mono','Geist Mono','JetBrains Mono',ui-monospace,monospace;font-size:13px;font-weight:520;fill:#8b8b84}",
    ".tiny{font-family:'SF Mono','Geist Mono','JetBrains Mono',ui-monospace,monospace;font-size:11px;font-weight:540;letter-spacing:0}"
  ].join("");
}

function sanitizeText(value: string | number): string {
  return redactAbsolutePaths(String(value));
}

function sanitizeOptionalText(value: string | number | undefined): string {
  if (value === undefined || value === null || String(value).trim().length === 0) {
    return "not recorded";
  }
  return sanitizeText(value);
}

function deriveProofVerdict(input: {
  completeEvidence: boolean;
  status: string | number;
  lifecycle: string | number;
  verifierStatus: string | number;
  receiptIntegrityState: ReceiptIntegrityState | undefined;
}): MartinProofCard["proofVerdict"] {
  const joined =
    `${input.status} ${input.lifecycle} ${input.verifierStatus} ${input.receiptIntegrityState ?? ""}`.toLowerCase();
  if (!input.completeEvidence || /\b(unsigned|tamper_detected)\b/u.test(joined)) {
    return "EVIDENCE_BOUNDARY";
  }
  if (/\b(failed|failure|error)\b/u.test(joined)) return "FAILED";
  if (/\b(halted|halt|budget_exit|stuck_exit|diminishing_returns)\b/u.test(joined)) {
    return "HALTED";
  }
  return "VERIFIED";
}

function deriveTaskLabel(objective: string | number): string {
  const normalized = sanitizeText(objective).toLowerCase();
  const candidates: readonly [RegExp, string][] = [
    [/receipt|integrity|sign|signature|tamper|hash/u, "receipt-integrity verification"],
    [/budget|spend|cost|overspend|cap/u, "budget-governed agent run"],
    [/verif|test|assert|check/u, "verifier-backed repair"],
    [/policy|preflight|allow|deny|path/u, "policy preflight validation"],
    [/mcp|connect|adapter|provider/u, "agent runtime connectivity"],
    [/redact|sanitize|secret|privacy/u, "redaction safety check"],
    [/loopbench|benchmark|eval/u, "benchmark integrity run"]
  ];
  return candidates.find(([pattern]) => pattern.test(normalized))?.[1] ?? "governed agent task";
}

function normalizeTimelineEvents(events: readonly string[] | undefined): readonly string[] {
  const cleaned = (events ?? [])
    .map((event) => sanitizeText(event).trim())
    .filter((event) => event.length > 0);
  return cleaned.length > 0 ? cleaned.slice(0, 6) : ["run.started", "run.completed"];
}

function verdictColor(verdict: MartinProofCard["proofVerdict"]): string {
  return verdict === "FAILED" || verdict === "EVIDENCE_BOUNDARY" ? "#d35f5f" : "#72b37e";
}

function valueColor(value: string, accent: string): string {
  if (/\b(pass|passed|verified|captured|signed|complete|completed)\b/iu.test(value)) {
    return "#72b37e";
  }
  if (/\b(fail|failed|missing|unavailable|not recorded|not-recorded|boundary|tamper)\b/iu.test(value)) {
    return "#d35f5f";
  }
  return accent === "#d35f5f" ? "#e8e8e3" : "#d6d6ce";
}

function normalizeMoneyValue(value: string): string {
  const normalized = normalizeCliValue(value).replace(/^\$/u, "");
  return normalized === "unknown" || normalized === "not recorded" ? normalized : normalized;
}

function normalizeCliValue(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized === "missing" || normalized === "n/a") return "not recorded";
  return normalized.replace(/\s+/gu, " ");
}

function normalizeBoundaryLine(value: string): string {
  const normalized = normalizeCliValue(value)
    .replace(/Generated from a local Martin Loop run record\.;?/iu, "local run record only;")
    .replace(
      /Hosted dashboards and private team telemetry are intentionally excluded from OSS proof cards\./iu,
      "private telemetry excluded"
    );
  return normalized === "not recorded" ? "local run record only; private telemetry excluded" : normalized;
}

function compactEventName(event: string): string {
  const replacements: Record<string, string> = {
    "run.started": "run.start",
    "attempt.started": "attempt.start",
    "attempt.completed": "attempt.done",
    "verification.completed": "verify.done",
    "budget.updated": "budget.update",
    "run.completed": "run.done"
  };
  return replacements[event] ?? event.replace(/completed/gu, "done").replace(/started/gu, "start").slice(0, 18);
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(1, maxLength - 1))}...`;
}

function hasEvidence(value: string | number): boolean {
  const normalized = String(value).trim().toLowerCase();

  return (
    normalized.length > 0 &&
    !["missing", "none", "not-recorded", "not recorded", "unknown", "n/a"].includes(
      normalized
    )
  );
}

function redactAbsolutePaths(text: string): string {
  return text
    .replace(/\\\\[^\\/\r\n]+[\\/][^\r\n]+/gu, redactPathMatch)
    .replace(/[A-Za-z]:[\\/][^\r\n]+/gu, redactPathMatch)
    .replace(/\/(?:Users|home|tmp|var|private|mnt|workspace|repo|opt)\/[^\r\n]+/gu, redactPathMatch);
}

function redactPathMatch(match: string): string {
  const normalized = match.replace(/\\/gu, "/").trim();
  const trimmed = normalized.replace(/[),.;:]+$/u, "");
  const suffix = normalized.slice(trimmed.length);
  const basename = trimmed.split("/").filter(Boolean).at(-1) ?? "artifact";

  return `[redacted-path]/${basename}${suffix}`;
}

function escapeMarkdownCell(value: string): string {
  return escapeMarkdownText(value).replace(/\|/gu, "\\|");
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function escapeSvg(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}
