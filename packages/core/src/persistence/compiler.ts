import type { ExecutionPolicy } from "@martin/contracts";

import { compilePromptPacket, type CompilerAdapterRequest, type PromptPacket } from "../compiler.js";
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
 */
export async function compileAndPersistContext(
  request: CompilerAdapterRequest,
  options: {
    attemptIndex: number;
    store?: RunStore;
    now?: string;
    executionPolicy?: ExecutionPolicy;
  }
): Promise<CompileResult> {
  const packet = compilePromptPacket(request);
  const ts = options.now ?? new Date().toISOString();

  if (options.store) {
    // Write compiled-context.json to attempt artifact directory
    await options.store.writeAttemptArtifacts(request.loopId, options.attemptIndex, {
      compiledContext: packet,
      ...(options.executionPolicy ? { executionPolicy: options.executionPolicy } : {})
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
          budgetEnvelope: packet.budgetEnvelope,
          ...(options.executionPolicy
            ? {
                executionPolicy: {
                  governance: options.executionPolicy.governance,
                  task: options.executionPolicy.task,
                  provenance: options.executionPolicy.provenance
                }
              }
            : {})
        },
        timestamp: ts
      })
    );
  }

  return { packet };
}
