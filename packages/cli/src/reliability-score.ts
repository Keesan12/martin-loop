export type MartinReliabilitySignalId =
  | "budgetConfigured"
  | "verifierConfigured"
  | "runReceiptsPresent"
  | "rollbackEvidencePresent"
  | "mcpDoctorPassing";

export type MartinReliabilitySignalEvidence = {
  present: boolean;
  measured?: boolean;
  detail?: string;
};

export type MartinReliabilityScoreInput = {
  signals: Record<MartinReliabilitySignalId, MartinReliabilitySignalEvidence>;
};

export type MartinReliabilitySignal = {
  id: MartinReliabilitySignalId;
  label: string;
  measured: boolean;
  passed: boolean;
  points: number;
  maxPoints: number;
  detail?: string;
  reason?: string;
};

export type MartinReliabilityGrade = "ready" | "strong" | "needs-evidence" | "blocked";

export type MartinReliabilityScore = {
  meaning: "local_evidence_signals_with_measurement_state";
  signalCount: number;
  measuredSignals: number;
  unmeasuredSignals: number;
  totalSignals: 5;
  points: number;
  maxPoints: number;
  grade: MartinReliabilityGrade;
  summary: string;
  signals: MartinReliabilitySignal[];
  missingReasons: string[];
  unmeasuredReasons: string[];
};

export type MartinReliabilityBadgeJson = {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
};

const SIGNALS: Array<{
  id: MartinReliabilitySignalId;
  label: string;
}> = [
  { id: "budgetConfigured", label: "Budget configured" },
  { id: "verifierConfigured", label: "Verifier configured" },
  { id: "runReceiptsPresent", label: "Verified run receipts present" },
  { id: "rollbackEvidencePresent", label: "Rollback evidence present" },
  { id: "mcpDoctorPassing", label: "MCP doctor passing" }
];

const POINTS_PER_SIGNAL = 20;
const TOTAL_SIGNALS = 5 as const;
const MAX_POINTS = SIGNALS.length * POINTS_PER_SIGNAL;

export function computeMartinReliabilityScore(
  input: MartinReliabilityScoreInput
): MartinReliabilityScore {
  const signals = SIGNALS.map((definition): MartinReliabilitySignal => {
    const evidence = input.signals[definition.id];
    const detail = sanitizeText(evidence.detail ?? "");
    const measured = evidence.measured !== false;
    const passed = measured && evidence.present;
    const reason = passed || !measured
      ? undefined
      : `${definition.label}: ${detail.length > 0 ? detail : "Evidence missing"}`;

    return {
      id: definition.id,
      label: definition.label,
      measured,
      passed,
      points: passed ? POINTS_PER_SIGNAL : 0,
      maxPoints: POINTS_PER_SIGNAL,
      ...(detail.length > 0 ? { detail } : {}),
      ...(reason ? { reason } : {})
    };
  });

  const points = signals.reduce((total, signal) => total + signal.points, 0);
  const signalCount = signals.filter((signal) => signal.passed).length;
  const measuredSignals = signals.filter((signal) => signal.measured).length;
  const unmeasuredSignals = TOTAL_SIGNALS - measuredSignals;
  const grade = gradeForPoints(points);
  const missingReasons = signals
    .filter((signal) => signal.measured && !signal.passed)
    .map((signal) => signal.reason ?? `${signal.label}: Evidence missing`);
  const unmeasuredReasons = signals
    .filter((signal) => !signal.measured)
    .map((signal) => `${signal.label}: ${signal.detail ?? "Not measured"}`);

  return {
    meaning: "local_evidence_signals_with_measurement_state",
    signalCount,
    measuredSignals,
    unmeasuredSignals,
    totalSignals: TOTAL_SIGNALS,
    points,
    maxPoints: MAX_POINTS,
    grade,
    summary: `Evidence readiness: ${signalCount}/${measuredSignals} measured signals (${unmeasuredSignals} unmeasured; ${grade}; ${points}/${MAX_POINTS} readiness points)`,
    signals,
    missingReasons,
    unmeasuredReasons
  };
}

export function renderMartinReliabilityBadgeJson(
  score: MartinReliabilityScore
): MartinReliabilityBadgeJson {
  return {
    schemaVersion: 1,
    label: "evidence readiness",
    message: `${score.signalCount}/${score.totalSignals} ${score.grade}`,
    color: colorForGrade(score.grade)
  };
}

export function renderMartinReliabilityBadgeSvg(score: MartinReliabilityScore): string {
  const label = "evidence readiness";
  const message = `${score.signalCount}/${score.totalSignals} ${score.grade}`;
  const color = colorHexForGrade(score.grade);
  const title = `${label}: ${message}`;
  const incompleteReasons = [...score.missingReasons, ...score.unmeasuredReasons];
  const detail = incompleteReasons.length > 0 ? incompleteReasons.join("; ") : "All required evidence present";
  const safeDetail = escapeXml(sanitizeText(detail));

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="20" role="img" aria-label="' +
      `${escapeXml(title)}">`,
    `<title>${escapeXml(title)}</title>`,
    `<desc>${safeDetail}</desc>`,
    '<linearGradient id="s" x2="0" y2="100%">',
    '<stop offset="0" stop-color="#fff" stop-opacity=".7"/>',
    '<stop offset=".1" stop-opacity=".1"/>',
    '<stop offset=".9" stop-opacity=".3"/>',
    '<stop offset="1" stop-opacity=".5"/>',
    "</linearGradient>",
    '<rect rx="3" width="220" height="20" fill="#555"/>',
    `<rect rx="3" x="118" width="102" height="20" fill="${color}"/>`,
    '<path fill="' +
      color +
      '" d="M118 0h4v20h-4z"/>',
    '<rect rx="3" width="220" height="20" fill="url(#s)"/>',
    '<g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">',
    `<text x="59" y="15" fill="#010101" fill-opacity=".3">${label}</text>`,
    `<text x="59" y="14">${label}</text>`,
    `<text x="169" y="15" fill="#010101" fill-opacity=".3">${escapeXml(message)}</text>`,
    `<text x="169" y="14">${escapeXml(message)}</text>`,
    "</g>",
    "</svg>"
  ].join("");
}

function gradeForPoints(points: number): MartinReliabilityGrade {
  if (points >= 100) {
    return "ready";
  }
  if (points >= 80) {
    return "strong";
  }
  if (points >= 40) {
    return "needs-evidence";
  }
  return "blocked";
}

function colorForGrade(grade: MartinReliabilityGrade): string {
  if (grade === "ready") {
    return "brightgreen";
  }
  if (grade === "strong") {
    return "green";
  }
  if (grade === "needs-evidence") {
    return "yellow";
  }
  return "red";
}

function colorHexForGrade(grade: MartinReliabilityGrade): string {
  if (grade === "ready") {
    return "#4c1";
  }
  if (grade === "strong") {
    return "#97ca00";
  }
  if (grade === "needs-evidence") {
    return "#dfb317";
  }
  return "#e05d44";
}

function sanitizeText(value: string): string {
  return value
    .replace(/[A-Za-z]:\\[^\s<>"|?*]+(?:\\[^\s<>"|?*]+)*/gu, "[redacted-path]")
    .replace(/\/(?:Users|home)\/[^\s<>"']+(?:\/[^\s<>"']*)*/gu, "[redacted-path]")
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/gu, "?");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}
