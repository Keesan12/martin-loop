import { CliCommandError } from "./ux.js";

// Options distinctive to MartinLoop. When one of these appears inside a verifier value, the
// operator's shell folded later MartinLoop flags into the verifier string. On Windows this
// happens when a stray quote reaches the npm `.cmd` shim: cmd.exe opens a quoted region and
// node receives every remaining flag as part of the `--verify` value. Generic names that other
// tools also accept (`--verify`, `--max-tokens`, `--max-iterations`) are deliberately absent so
// a verifier program's own flags are never rejected.
const MARTIN_OWNED_OPTIONS = new Set([
  "--allow-network-domain",
  "--allow-path",
  "--approve-config-changes",
  "--approve-dependency-changes",
  "--approve-external-writes",
  "--approve-migrations",
  "--baseline-usd",
  "--budget-usd",
  "--deny-path",
  "--execution-profile",
  "--provider-execution-timeout-ms",
  "--runs-dir",
  "--soft-limit-usd",
  "--unsafe-allow-unguarded-run",
  "--verify-only",
  "--verify-timeout-ms",
]);

// `--engine` is common in verifier programs (browsers, test runners); it only signals a fold
// when its value is one of MartinLoop's own engines.
const MARTIN_ENGINES = new Set(["auto", "claude", "codex", "gemini", "openai"]);

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

// Verifiers that intentionally invoke MartinLoop (for example `martin outcomes verify`) may
// legitimately carry MartinLoop options.
const MARTIN_EXECUTABLES = new Set(["martin", "martin-loop", "martin.cmd", "martin-loop.cmd"]);

/**
 * Returns the reason a verifier command is malformed, or undefined when it is well formed.
 * Mirrors the quote/escape rules of the adapters' `splitCommand` so preflight rejects exactly
 * what the runtime would otherwise misinterpret.
 */
export function describeMalformedVerifier(command: string): string | undefined {
  const quote = findUnterminatedQuote(command);
  if (quote !== undefined) {
    return `--verify value has an unterminated quote (${quote}): ${command}`;
  }

  const tokens = command.trim().split(/\s+/u);
  const executable = tokens[0]?.replace(/^["']|["']$/gu, "").toLowerCase() ?? "";
  if (MARTIN_EXECUTABLES.has(executable)) {
    return undefined;
  }

  const swallowed = foldedMartinOptions(tokens);
  if (swallowed.length > 0) {
    return `--verify value contains MartinLoop option(s) ${swallowed.join(", ")}: ${command}. `
      + "The shell merged later flags into the verifier, usually because of a stray quote.";
  }

  return undefined;
}

export function assertWellFormedVerifier(command: string): string {
  const reason = describeMalformedVerifier(command);
  if (reason !== undefined) {
    throw new CliCommandError("invalid_input", reason, {
      suggestion: 'Quote the whole verifier and nothing else, for example: --verify "npm test" --budget-usd 1',
      details: { verifier: command },
    });
  }
  return command;
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
      if (quote === undefined) {
        quote = char;
      } else if (quote === char) {
        quote = undefined;
      }
    }
  }
  return quote;
}
