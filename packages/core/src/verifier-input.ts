const MARTIN_OWNED_OPTIONS = new Set([
  "--allow-network-domain", "--allow-path", "--approve-config-changes",
  "--approve-dependency-changes", "--approve-external-writes", "--approve-migrations",
  "--approve-test-changes", "--baseline-usd", "--budget-usd", "--deny-path",
  "--execution-profile", "--provider-execution-timeout-ms", "--runs-dir",
  "--soft-limit-usd", "--unsafe-allow-unguarded-run", "--verify-only", "--verify-timeout-ms"
]);

const MARTIN_ENGINES = new Set(["auto", "claude", "codex", "gemini", "openai"]);
const MARTIN_EXECUTABLES = new Set(["martin", "martin-loop", "martin.cmd", "martin-loop.cmd"]);

function foldedMartinOptions(tokens: string[]): string[] {
  const folded: string[] = [];
  tokens.forEach((token, index) => {
    const [name, inlineValue] = token.split("=", 2);
    if (name && MARTIN_OWNED_OPTIONS.has(name)) {
      folded.push(name);
      return;
    }
    if (name === "--engine") {
      const value = (inlineValue ?? tokens[index + 1] ?? "").toLowerCase();
      if (MARTIN_ENGINES.has(value)) folded.push(`--engine ${value}`);
    }
  });
  return folded;
}

/** Returns a reason when a verifier would be parsed differently from what the operator intended. */
export function describeMalformedVerifier(command: string): string | undefined {
  const quote = findUnterminatedQuote(command);
  if (quote !== undefined) return `--verify value has an unterminated quote (${quote}): ${command}`;

  const tokens = command.trim().split(/\s+/u);
  const executable = tokens[0]?.replace(/^["']|["']$/gu, "").toLowerCase() ?? "";
  if (MARTIN_EXECUTABLES.has(executable)) return undefined;

  const swallowed = foldedMartinOptions(tokens);
  if (swallowed.length > 0) {
    return `--verify value contains MartinLoop option(s) ${swallowed.join(", ")}: ${command}. `
      + "The shell merged later flags into the verifier, usually because of a stray quote.";
  }
  return undefined;
}

function findUnterminatedQuote(command: string): '"' | "'" | undefined {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];
    if (char === "\\" && quote !== "'" && (next === quote || next === "\\")) {
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      if (quote === undefined) quote = char;
      else if (quote === char) quote = undefined;
    }
  }
  return quote;
}
