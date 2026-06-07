import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ContextIntegrityVerdict =
  | "clean"
  | "context_poisoning_warning"
  | "context_poisoning_block";

export interface ContextIntegrityPrecheck {
  runId: string;
  attemptIndex: number;
  verdict: ContextIntegrityVerdict;
  reason?: string;
  detectedSignals: string[];
  analyzedChannels: {
    system: boolean;
    user: boolean;
    tools: boolean;
    history: boolean;
  };
  timestamp: string;
}

const POISON_PATTERNS = [
  /ignore\s+(?:all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+a\s+(?!Martin\s+Loop)/i,
  /new\s+rule:/i,
  /disregard\s+(?:safety|policy|guardrails)/i,
  /override\s+system\s+authority/i,
  /hidden\s+instruction:/i,
  /\[system_override\]/i,
  /\[authority_inversion\]/i
];

/**
 * Identity-redefinition / persona-override patterns.
 *
 * These intentionally require an *override framing* (e.g. "now", "no longer",
 * "forget", "pretend", or an explicit authority-role claim) rather than any
 * sentence shaped like "you are X" / "I am X" — the latter matches ordinary
 * benign text (e.g. "You are welcome to try MartinLoop") and produced
 * false-positive hard aborts.
 */
const IDENTITY_REDEFINITION_PATTERNS = [
  /\byou(?:'re|\s+are)\s+now\s+(?:a|an|the)\b(?!\s+(?:martin\s+loop|ai\s+coding\s+agent))/i,
  /\byou(?:'re|\s+are)\s+no\s+longer\s+(?!.*\b(?:martin\s+loop|an?\s+ai)\b)/i,
  /\bforget\s+(?:that\s+)?you(?:'re|\s+are)\s+martin\s+loop\b/i,
  /\b(?:pretend|imagine)\s+(?:that\s+)?you(?:'re|\s+are)\b/i,
  /\bact\s+as\s+(?:if\s+you(?:'re|\s+are)\s+)?(?:a|an)\s+(?:different|new|unrestricted|jailbroken)\b/i,
  /\bi\s+am\s+(?:the|your)\s+(?:new\s+)?(?:system|developer|admin(?:istrator)?|root\s*user|owner|creator|operator)\b/i
];

/**
 * T05: Context Poisoning Pre-gate.
 * Scans untrusted input channels for authority inversion or instruction re-injection.
 * Runs BEFORE admission control and core reasoning.
 */
export async function runContextIntegrityPrecheck(
  runId: string,
  attemptIndex: number,
  artifactsDir: string,
  inputs: {
    userPrompt?: string;
    toolOutput?: string;
    retrievedContext?: string;
    history?: string;
  }
): Promise<ContextIntegrityPrecheck> {
  const signals: string[] = [];
  const analyzedChannels = {
    system: true,
    user: Boolean(inputs.userPrompt),
    tools: Boolean(inputs.toolOutput),
    history: Boolean(inputs.history)
  };

  const untrustedBuffer = [
    inputs.userPrompt,
    inputs.toolOutput,
    inputs.retrievedContext,
    inputs.history
  ]
    .filter(Boolean)
    .join("\n---\n");

  for (const pattern of POISON_PATTERNS) {
    if (pattern.test(untrustedBuffer)) {
      signals.push(`Detected poison pattern: ${pattern.toString()}`);
    }
  }

  for (const pattern of IDENTITY_REDEFINITION_PATTERNS) {
    if (pattern.test(untrustedBuffer)) {
      signals.push("Identity redefinition attempt detected.");
      break;
    }
  }

  const verdict: ContextIntegrityVerdict =
    signals.length > 0 ? "context_poisoning_block" : "clean";

  const precheck: ContextIntegrityPrecheck = {
    runId,
    attemptIndex,
    verdict,
    reason: signals.length > 0 ? `Detected ${signals.length} poisoning signal(s).` : undefined,
    detectedSignals: signals,
    analyzedChannels,
    timestamp: new Date().toISOString()
  };

  try {
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "context-integrity-precheck.json"),
      JSON.stringify(precheck, null, 2),
      "utf8"
    );
  } catch {
    // non-fatal — artifact persistence is best-effort
  }

  return precheck;
}
