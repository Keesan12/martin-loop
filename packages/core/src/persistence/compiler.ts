import { createHash } from "node:crypto";

import { compilePromptPacket, type CompilerAdapterRequest, type PromptPacket } from "../compiler.js";
import { compileContext, HEURISTIC_ADAPTER, type ContextAdapter } from "../context-compiler.js";
import { compileContextShadow } from "../context-shadow.js";
import { makeLedgerEvent } from "./ledger.js";
import type { RunStore } from "./store.js";

export interface CompileResult {
  packet: PromptPacket;
}

/**
 * Compile a deterministic PromptPacket from the request state and, when a
 * store is provided, persist it as compiled-context.json in the attempt
 * artifact directory.
 *
 * R3.7: Context compiler produces deterministic compiled-context.json.
 * R3.8: Any attempt prompt can be reconstructed from disk artifacts alone.
 *
 * A-CTX-0: After compiling, emit a shadow manifest via compileContextShadow
 * and append a context.shadow_compiled ledger event. Shadow failure must not
 * break the governed run — original packet is returned unchanged in all cases.
 */
export async function compileAndPersistContext(
  request: CompilerAdapterRequest,
  options: {
    attemptIndex: number;
    store?: RunStore;
    now?: string;
    nowMs?: number;
    contextShadowBudgetTokens?: number;
    contextAdapter?: ContextAdapter;
  }
): Promise<CompileResult> {
  const packet = compilePromptPacket(request);
  const ts = options.now ?? new Date().toISOString();

  if (options.store) {
    // Write compiled-context.json to attempt artifact directory
    await options.store.writeAttemptArtifacts(request.loopId, options.attemptIndex, {
      compiledContext: packet
    });

    // Append prompt.compiled ledger event
    await options.store.appendLedger(
      request.loopId,
      makeLedgerEvent({
        kind: "prompt.compiled",
        runId: request.loopId,
        attemptIndex: options.attemptIndex,
        payload: {
          attemptId: request.attemptId,
          attemptNumber: packet.attemptNumber,
          priorFailurePatterns: packet.priorFailurePatterns,
          budgetEnvelope: packet.budgetEnvelope
        },
        timestamp: ts
      })
    );

    // ── A-CTX-0: Shadow manifest emission ────────────────────────────────
    // Use the serialized PromptPacket as the single shadow segment.
    // This is a A-CTX-0 fallback — A-CTX-1 will map structured segments.
    // Shadow failure MUST NOT break the governed run.
    try {
      const nowMs = options.nowMs ?? Date.now();
      const shadow = compileContextShadow({
        runId: request.loopId,
        adapter: "martin-core",
        nowMs,
        shadowBudgetTokens: options.contextShadowBudgetTokens ?? 8_000,
        modelWindowEvidence: "unknown",
        segments: [
          {
            segmentId: "compiled-prompt",
            kind: "compiled_prompt",
            required: true,
            text: JSON.stringify(packet)
          }
        ]
      });

      await options.store.appendLedger(
        request.loopId,
        makeLedgerEvent({
          kind: "context.shadow_compiled",
          runId: request.loopId,
          attemptIndex: options.attemptIndex,
          payload: shadow.receipt as unknown as Record<string, unknown>,
          timestamp: ts
        })
      );
    } catch (shadowErr) {
      // Shadow telemetry failure is non-fatal. Emit a diagnostic ledger entry
      // so the failure is visible without breaking the governed run.
      const errorKind =
        shadowErr instanceof Error ? shadowErr.name : "UnknownError";
      try {
        await options.store.appendLedger(
          request.loopId,
          makeLedgerEvent({
            kind: "context.shadow_compiled",
            runId: request.loopId,
            attemptIndex: options.attemptIndex,
            payload: {
              mode: "shadow",
              error: "shadow_emit_failed",
              errorKind
            },
            timestamp: ts
          })
        );
      } catch {
        // Last-resort: if the diagnostic ledger write also fails, swallow it
        // so the governed run completes. No prompt content is stored here.
      }
    }
    // ── End A-CTX-0 shadow emission ───────────────────────────────────────

    // ── A-CTX-1: Deterministic governed context compilation ───────────────
    // Shadow mode: compute manifest but return original packet unchanged.
    // nowMs captured once here — never passed as Date.now() inside compileContext.
    // Failure must not break the governed run.
    try {
      const nowMs = options.nowMs ?? Date.now();
      const adapter = options.contextAdapter ?? HEURISTIC_ADAPTER;

      // Build one candidate from the serialized packet.
      // Only the hash goes into the manifest — never the raw text.
      const packetText = JSON.stringify(packet);
      const packetHash = createHash("sha256").update(packetText, "utf8").digest("hex");
      const estimatedTokens = Math.max(
        1,
        Math.ceil(Buffer.byteLength(packetText, "utf8") / 4)
      );

      const result = compileContext({
        taskId: request.attemptId,
        runId: request.loopId,
        nowMs,
        candidates: [
          {
            id: "compiled-prompt",
            kind: "task",
            priority: "required",
            trust: "authoritative",
            sensitivity: "workspace",
            sourceRef: `run://${request.loopId}/compiled-context`,
            contentHash: packetHash,
            estimatedTokens
          }
        ],
        budget: {
          modelWindowTokens: 200_000,
          systemReserveTokens: 2_000,
          outputReserveTokens: 4_000,
          toolReserveTokens: 3_000,
          overflowReserveTokens: 2_000,
          maxWorkingSetTokens: options.contextShadowBudgetTokens ?? 8_000,
          pinnedTokensMax: 1_500
        },
        policy: {
          policyHash: "shadow-passthrough-v1",
          deniedSensitivities: ["secret"],
          deniedTrustLevels: [],
          requiredOverBudgetAction: "explicit_escalation",
          maxCompilerDurationMs: 250,
          maxOverheadRatio: 0.15
        },
        adapter
      });

      if (result.ok) {
        await options.store.appendLedger(
          request.loopId,
          makeLedgerEvent({
            kind: "context.manifest_compiled",
            runId: request.loopId,
            attemptIndex: options.attemptIndex,
            payload: result.ledgerEntry as unknown as Record<string, unknown>,
            timestamp: ts
          })
        );
      } else {
        // Explicit compiler failure (required_over_budget or recount_exceeded_passes).
        // Record as a diagnostic — not a crash, not silent.
        await options.store.appendLedger(
          request.loopId,
          makeLedgerEvent({
            kind: "context.manifest_compiled",
            runId: request.loopId,
            attemptIndex: options.attemptIndex,
            payload: {
              mode: "shadow",
              error: "compiler_failed",
              reason: result.reason
            },
            timestamp: ts
          })
        );
      }
    } catch (compilerErr) {
      // Unexpected compiler failure is non-fatal. Emit a named diagnostic so
      // the failure is visible in the ledger without breaking the governed run.
      // Only error.name (e.g. "TypeError") is recorded — never error.message,
      // which could contain prompt or segment text.
      const errorKind =
        compilerErr instanceof Error ? compilerErr.name : "UnknownError";
      try {
        await options.store.appendLedger(
          request.loopId,
          makeLedgerEvent({
            kind: "context.manifest_compiled",
            runId: request.loopId,
            attemptIndex: options.attemptIndex,
            payload: {
              mode: "shadow",
              error: "compiler_threw",
              errorKind
            },
            timestamp: ts
          })
        );
      } catch {
        // Last-resort: diagnostic write failed too. The run must not be affected.
        // No prompt content is stored anywhere in this path.
      }
    }
    // ── End A-CTX-1 compiler ──────────────────────────────────────────────
  }

  return { packet };
}
