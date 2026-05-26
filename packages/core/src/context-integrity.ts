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
    retrievedContext: boolean;
    history: boolean;
    taskTitle: boolean;
    taskObjective: boolean;
    verifierStdout: boolean;
    verifierStderr: boolean;
  };
  timestamp: string;
}

const POISON_PATTERNS = [
  /\b(forget|ignore|discard|disregard|override)\b.*\b(prior|previous|earlier|all)\b.*\b(instruction|rule|directive|guideline|policy|constraint)/i,
  /\bdisregard\b.*\b(?:safety\s+)?(guideline|guidelines|policy|policies|guardrails|constraints?)\b/i,
  /you\s+are\s+now\s+a\s+(?!Martin\s+Loop)/i,
  /\b(new|updated|revised)\s+(instruction|rule|directive|guideline|policy)\s*:/i,
  /disregard\s+(?:safety|policy|guardrails|guidelines)/i,
  /override\s+system\s+authority/i,
  /\bsystem\s*override\b/i,
  /hidden\s+instruction:/i,
  /\[system_override\]/i,
  /\[authority_inversion\]/i,
  /\bact\s+as\s+(?:a|an)?\s*(?:different|new|another|totally\s+different|unrestricted)\s+(?:ai|assistant|model)\b/i,
  /\bDAN\s+mode\b/i,
  /\bjailbreak\b/i
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
    taskTitle?: string;
    taskObjective?: string;
    userPrompt?: string;
    toolOutput?: string;
    retrievedContext?: string;
    history?: string;
    verifierStdout?: string;
    verifierStderr?: string;
  }
): Promise<ContextIntegrityPrecheck> {
  const signals: string[] = [];
  const analyzedChannels = {
    system: true,
    taskTitle: Boolean(inputs.taskTitle),
    taskObjective: Boolean(inputs.taskObjective),
    user: Boolean(inputs.userPrompt),
    tools: Boolean(inputs.toolOutput),
    retrievedContext: Boolean(inputs.retrievedContext),
    history: Boolean(inputs.history),
    verifierStdout: Boolean(inputs.verifierStdout),
    verifierStderr: Boolean(inputs.verifierStderr)
  };

  const untrustedBuffer = [
    inputs.taskTitle,
    inputs.taskObjective,
    inputs.userPrompt,
    inputs.toolOutput,
    inputs.retrievedContext,
    inputs.history,
    inputs.verifierStdout,
    inputs.verifierStderr
  ]
    .filter(Boolean)
    .join("\n---\n");

  for (const pattern of POISON_PATTERNS) {
    if (pattern.test(untrustedBuffer)) {
      signals.push(`Detected poison pattern: ${pattern.toString()}`);
    }
  }

  if (/\b(?:I am|You are)\s+(?!Martin\s+Loop|an\s+AI)\b/i.test(untrustedBuffer)) {
    signals.push("Identity redefinition attempt detected.");
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
