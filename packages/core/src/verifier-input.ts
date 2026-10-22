const MARTIN_OWNED_OPTIONS = new Set([
  "--allow-network-domain", "--allow-path", "--approve-config-changes",
  "--approve-dependency-changes", "--approve-external-writes", "--approve-migrations",
  "--approve-test-changes", "--baseline-usd", "--budget-usd", "--deny-path",
  "--execution-profile", "--provider-execution-timeout-ms", "--runs-dir",
  "--soft-limit-usd", "--unsafe-allow-unguarded-run", "--verify-only", "--verify-timeout-ms"
]);

const MARTIN_ENGINES = new Set(["auto", "claude", "codex", "gemini", "openai"]);
const MARTIN_EXECUTABLES = new Set(["martin", "martin-loop", "martin.cmd", "martin-loop.cmd"]);
const LAUNCHER_BOOLEAN_OPTIONS = new Set([
  "-s", "--silent", "-y", "--yes", "--no-install", "--offline", "--prefer-offline", "--no-color"
]);
const LAUNCHER_VALUE_OPTIONS = new Set(["--cwd", "--dir", "--filter", "--package", "-p", "--workspace", "-w"]);

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
export function describeMalformedVerifier(
  command: string,
  options: { detectShellFold?: boolean } = {}
): string | undefined {
  const quote = findUnterminatedQuote(command);
  if (quote !== undefined) return `--verify value has an unterminated quote (${quote}): ${command}`;
  if (options.detectShellFold === false) return undefined;

  const tokens = command.trim().split(/\s+/u);
  const executableIndex = resolveLaunchedExecutableIndex(tokens);
  const executable = normalizeExecutableToken(tokens[executableIndex] ?? "");
  if (MARTIN_EXECUTABLES.has(executable)) return undefined;

  const swallowed = foldedMartinOptions(tokens);
  if (swallowed.length > 0) {
    return `--verify value contains MartinLoop option(s) ${swallowed.join(", ")}: ${command}. `
      + "The shell merged later flags into the verifier, usually because of a stray quote.";
  }
  return undefined;
}

function resolveLaunchedExecutableIndex(tokens: string[]): number {
  const launcher = normalizeExecutableToken(tokens[0] ?? "");
  if (launcher === "node") return 1;
  if (launcher === "npx" || launcher === "pnpx") {
    return skipLauncherOptions(tokens, 1);
  }
  if (launcher === "pnpm" || launcher === "npm" || launcher === "yarn") {
    const actionIndex = skipLauncherOptions(tokens, 1);
    const action = normalizeExecutableToken(tokens[actionIndex] ?? "");
    if (action !== "exec" && action !== "dlx") return 0;
    return skipLauncherOptions(tokens, actionIndex + 1);
  }
  return 0;
}

function skipLauncherOptions(tokens: string[], start: number): number {
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (token === "--" || LAUNCHER_BOOLEAN_OPTIONS.has(token) || token.startsWith("--color=")) {
      index += 1;
      continue;
    }
    if (LAUNCHER_VALUE_OPTIONS.has(token)) {
      index += 2;
      continue;
    }
    if ([...LAUNCHER_VALUE_OPTIONS].some((option) => token.startsWith(`${option}=`))) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

function normalizeExecutableToken(token: string): string {
  const unquoted = token.replace(/^["']|["']$/gu, "");
  const basename = unquoted.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
  return basename.endsWith(".js") ? basename.slice(0, -3) : basename;
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
