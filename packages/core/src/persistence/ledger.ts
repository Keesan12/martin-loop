/**
 * Ledger event types for the Phase 3 persistence stack.
 * These are WRITE-side events that go into ledger.jsonl — separate from the
 * read-model LoopEventType used by the control plane.
 */
export type LedgerEventKind =
  | "contract.created"
  | "attempt.admitted"
  | "attempt.rejected"
  | "prompt.compiled"
  | "patch.generated"
  | "verification.completed"
  | "grounding.violations_found"
  | "safety.violations_found"
  | "budget.settled"
  | "attempt.kept"
  | "attempt.discarded"
  | "run.exited";

export interface LedgerEvent {
  kind: LedgerEventKind;
  runId: string;
  attemptIndex?: number;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface LedgerEventDraft {
  kind: LedgerEventKind;
  runId: string;
  attemptIndex?: number;
  payload: Record<string, unknown>;
  timestamp?: string;
}

export function makeLedgerEvent(
  draft: LedgerEventDraft,
  options: { now?: string } = {}
): LedgerEvent {
  return {
    kind: draft.kind,
    runId: draft.runId,
    timestamp: draft.timestamp ?? options.now ?? new Date().toISOString(),
    payload: draft.payload,
    ...(draft.attemptIndex !== undefined ? { attemptIndex: draft.attemptIndex } : {})
  };
}
