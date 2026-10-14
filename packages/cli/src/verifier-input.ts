import { CliCommandError } from "./ux.js";

// Options that only MartinLoop itself accepts. When one of these appears inside a verifier
// value, the operator's shell folded later MartinLoop flags into the verifier string. On
// Windows this happens when a stray quote reaches the npm `.cmd` shim: cmd.exe opens a quoted
// region and node receives every remaining flag as part of the `--verify` value.
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
  "--engine",
  "--execution-profile",
  "--max-iterations",
  "--max-tokens",
  "--provider-execution-timeout-ms",
  "--runs-dir",
  "--soft-limit-usd",
  "--unsafe-allow-unguarded-run",
  "--verify",
  "--verify-only",
  "--verify-timeout-ms",
]);

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

  const swallowed = tokens.filter((token) => MARTIN_OWNED_OPTIONS.has(token.split("=")[0] ?? token));
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
