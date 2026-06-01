export interface MartinProofCardInput {
  loopId: string;
  objective: string;
  status: string;
  lifecycle: string;
  verifierStatus: string;
  costSpend: string | number;
  budget: string | number;
  attempts: string | number;
  rollbackStatus: string;
  haltReason: string;
  evidenceBoundaryNotes: string | readonly string[];
  generatedAt: string;
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
}

const COMPLETE_EVIDENCE_LINE = "Martin stopped Ralph here.";
const INCOMPLETE_EVIDENCE_LINE =
  "Incomplete Martin proof: missing budget, rollback, or verifier evidence.";

const FIELD_LABELS = {
  loopId: "Loop ID",
  objective: "Objective",
  status: "Status",
  lifecycle: "Lifecycle",
  verifierStatus: "Verifier",
  costSpend: "Cost / spend",
  budget: "Budget",
  attempts: "Attempts",
  rollbackStatus: "Rollback",
  haltReason: "Halt reason",
  evidenceBoundaryNotes: "Evidence boundary",
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
    { label: FIELD_LABELS.attempts, value: sanitizeText(input.attempts) },
    { label: FIELD_LABELS.rollbackStatus, value: sanitizeText(input.rollbackStatus) },
    { label: FIELD_LABELS.haltReason, value: sanitizeText(input.haltReason) },
    {
      label: FIELD_LABELS.evidenceBoundaryNotes,
      value: evidenceBoundaryNotes
    },
    { label: FIELD_LABELS.generatedAt, value: generatedAt }
  ];

  const completeEvidence =
    hasEvidence(input.budget) &&
    hasEvidence(input.rollbackStatus) &&
    hasEvidence(input.verifierStatus);

  return {
    title: "Martin Loop Proof Card",
    fields,
    evidenceLine: completeEvidence ? COMPLETE_EVIDENCE_LINE : INCOMPLETE_EVIDENCE_LINE,
    generatedAt,
    completeEvidence
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
  const width = 760;
  const rowHeight = 28;
  const headerHeight = 92;
  const footerHeight = 38;
  const height = headerHeight + card.fields.length * rowHeight + footerHeight;
  const rows = card.fields
    .map((field, index) => {
      const y = headerHeight + index * rowHeight;
      const fill = index % 2 === 0 ? "#f8fafc" : "#ffffff";

      return [
        `<rect x="24" y="${y}" width="712" height="${rowHeight}" fill="${fill}"/>`,
        `<text x="44" y="${y + 19}" font-size="13" font-weight="700">${escapeSvg(field.label)}</text>`,
        `<text x="218" y="${y + 19}" font-size="13">${escapeSvg(field.value)}</text>`
      ].join("");
    })
    .join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeSvg(card.title)}">`,
    '<rect width="760" height="100%" rx="18" fill="#f1f5f9"/>',
    '<rect x="24" y="24" width="712" height="52" rx="12" fill="#0f172a"/>',
    `<text x="44" y="56" fill="#ffffff" font-size="24" font-weight="800">${escapeSvg(card.title)}</text>`,
    `<text x="44" y="86" fill="#0f172a" font-size="16" font-weight="700">${escapeSvg(card.evidenceLine)}</text>`,
    rows,
    `<text x="44" y="${height - 18}" fill="#475569" font-size="12">Generated ${escapeSvg(card.generatedAt)}</text>`,
    "</svg>"
  ].join("");
}

function sanitizeText(value: string | number): string {
  return redactAbsolutePaths(String(value));
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
