import type { MartinTone } from "./theme.js";

export type ProofStatus =
  | "VERIFIED"
  | "NEEDS_REVIEW"
  | "STOPPED"
  | "FAILED"
  | "RUNNING"
  | "PENDING";

export interface StatusPresentation {
  readonly glyph: string;
  readonly label: string;
  readonly tone: MartinTone;
}

const presentations: Readonly<Record<ProofStatus, StatusPresentation>> = {
  VERIFIED: { glyph: "✓", label: "VERIFIED", tone: "success" },
  NEEDS_REVIEW: { glyph: "!", label: "NEEDS REVIEW", tone: "warning" },
  STOPPED: { glyph: "■", label: "STOPPED", tone: "danger" },
  FAILED: { glyph: "×", label: "FAILED", tone: "danger" },
  RUNNING: { glyph: "◆", label: "RUNNING", tone: "info" },
  PENDING: { glyph: "○", label: "PENDING", tone: "muted" },
};

export function statusPresentation(status: ProofStatus): StatusPresentation {
  return presentations[status];
}
