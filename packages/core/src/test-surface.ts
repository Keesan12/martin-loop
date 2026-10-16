/**
 * Test surface: what a test file asserts, how many cases it declares and how many it skips.
 *
 * Weakening is judged on this surface rather than on raw removed lines, so ordinary edits
 * (growing an import list, reformatting, appending cases) are allowed while a removed or
 * altered assertion, a dropped case or a newly skipped case is not.
 *
 * The extractor is language-agnostic and heuristic. It is comment- and string-aware so a
 * commented-out assertion does not count as present. Files with no recognizable surface
 * (data, golden and snapshot files, unknown frameworks) are reported as empty so callers
 * can fall back to a stricter rule.
 */

export interface TestSurface {
  /** Whitespace-normalized assertion expressions, in source order. */
  assertions: string[];
  /** Declared test cases. */
  cases: number;
  /** Skip, todo or disable markers. */
  skips: number;
}

const HASH_COMMENT_EXTENSIONS = new Set(["py", "rb", "sh", "bash", "yaml", "yml", "toml", "pl", "r"]);
const SLASH_ONLY_EXTENSIONS = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "go", "rs", "java", "kt", "kts", "cs",
  "swift", "scala", "c", "cc", "cpp", "h", "hpp", "dart", "php"
]);

const ASSERTION_START = /\b(?:assert\w*|expect|should\w*)\b[\w.!]*\s*\(|\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(|\brequire\.[A-Z]\w*\s*\(/giu;
const PYTHON_BARE_ASSERT = /^[ \t]*assert[ \t]+(?!\()[^\n]*/gmu;
const CHAIN_CONTINUATION = /\s*\.\s*[\w$]+(?:\s*\.\s*[\w$]+)*\s*\(/uy;

const CASE_PATTERNS: RegExp[] = [
  /\b(?:test|it|specify)(?:\s*\.\s*(?:each|only|concurrent|serial|failing|sequential))*\s*\(/gu,
  /\b(?:it|specify|scenario)[ \t]+['"]/gu,
  /^[ \t]*(?:async[ \t]+)?def[ \t]+test\w*[ \t]*\(/gmu,
  /^func[ \t]+Test\w*[ \t]*\(/gmu,
  /#\[(?:tokio::)?test\b/gu,
  /@Test\b|\[Test\]|\[Fact\]|\[Theory\]/gu
];

const SKIP_PATTERNS: RegExp[] = [
  /\b(?:test|it|describe|context|suite)\s*\.\s*(?:skip|todo)\b/gu,
  /\bx(?:it|describe|test|context)\s*\(/gu,
  /@pytest\.mark\.skip\w*|\bpytest\.skip\s*\(|@unittest\.skip\w*|\bself\.skipTest\s*\(/gu,
  /\bt\.Skip\w*\s*\(/gu,
  /#\[ignore\b/gu,
  /@Disabled\b|@Ignore\b/gu
];

export function hasTestSurface(surface: TestSurface): boolean {
  return surface.assertions.length > 0 || surface.cases > 0;
}

export function extractTestSurface(content: string, path?: string): TestSurface {
  const code = stripComments(content, commentStyleFor(path));
  return {
    assertions: [...extractCallAssertions(code), ...extractBareAssertions(code)],
    cases: CASE_PATTERNS.reduce((total, pattern) => total + countMatches(code, pattern), 0),
    skips: SKIP_PATTERNS.reduce((total, pattern) => total + countMatches(code, pattern), 0)
  };
}

/**
 * True when `after` removes or alters an assertion, declares fewer cases, or skips more
 * cases than `before`. Added assertions and cases never count as weakening.
 */
export function testSurfaceWeakened(before: string, after: string, path?: string): boolean {
  const earlier = extractTestSurface(before, path);
  const later = extractTestSurface(after, path);

  if (later.cases < earlier.cases || later.skips > earlier.skips) {
    return true;
  }

  const remaining = new Map<string, number>();
  for (const assertion of later.assertions) {
    remaining.set(assertion, (remaining.get(assertion) ?? 0) + 1);
  }
  for (const assertion of earlier.assertions) {
    const left = remaining.get(assertion) ?? 0;
    if (left === 0) {
      return true;
    }
    remaining.set(assertion, left - 1);
  }
  return false;
}

interface CommentStyle {
  slash: boolean;
  hash: boolean;
}

function commentStyleFor(path?: string): CommentStyle {
  const extension = path?.split(".").at(-1)?.toLowerCase() ?? "";
  if (HASH_COMMENT_EXTENSIONS.has(extension)) {
    return { slash: false, hash: true };
  }
  if (SLASH_ONLY_EXTENSIONS.has(extension)) {
    return { slash: true, hash: extension === "php" };
  }
  return { slash: true, hash: true };
}

/** Replaces comments with spaces (newlines kept) while leaving string literals untouched. */
function stripComments(content: string, style: CommentStyle): string {
  let output = "";
  let index = 0;
  while (index < content.length) {
    const char = content[index] as string;
    const next = content[index + 1];

    if (isQuote(char)) {
      const end = skipString(content, index);
      output += content.slice(index, end);
      index = end;
    } else if (style.slash && char === "/" && next === "/") {
      const end = lineEnd(content, index);
      output += " ".repeat(end - index);
      index = end;
    } else if (style.slash && char === "/" && next === "*") {
      const close = content.indexOf("*/", index + 2);
      const end = close === -1 ? content.length : close + 2;
      output += content.slice(index, end).replace(/[^\n]/gu, " ");
      index = end;
    } else if (style.hash && char === "#" && next !== "[" && next !== "!") {
      const end = lineEnd(content, index);
      output += " ".repeat(end - index);
      index = end;
    } else {
      output += char;
      index += 1;
    }
  }
  return output;
}

function extractCallAssertions(code: string): string[] {
  const assertions: string[] = [];
  const pattern = new RegExp(ASSERTION_START.source, ASSERTION_START.flags);
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    if (match.index < cursor) {
      continue;
    }
    let end = balancedEnd(code, match.index + match[0].length - 1);
    for (;;) {
      const continuation = new RegExp(CHAIN_CONTINUATION.source, CHAIN_CONTINUATION.flags);
      continuation.lastIndex = end;
      const found = continuation.exec(code);
      if (!found) {
        break;
      }
      end = balancedEnd(code, end + found[0].length - 1);
    }
    assertions.push(normalize(code.slice(match.index, end)));
    cursor = end;
    pattern.lastIndex = end;
  }
  return assertions;
}

function extractBareAssertions(code: string): string[] {
  return (code.match(PYTHON_BARE_ASSERT) ?? []).map((line) => normalize(line));
}

/** Index just past the parenthesis that closes the one at `openIndex`; end of text if unbalanced. */
function balancedEnd(code: string, openIndex: number): number {
  let depth = 0;
  let index = openIndex;
  while (index < code.length) {
    const char = code[index] as string;
    if (isQuote(char)) {
      index = skipString(code, index);
      continue;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
    index += 1;
  }
  return code.length;
}

/** Drops whitespace outside string literals, keeping one space between two word characters. */
function normalize(text: string): string {
  let output = "";
  let index = 0;
  let pendingSpace = false;
  while (index < text.length) {
    const char = text[index] as string;
    if (isQuote(char)) {
      const end = skipString(text, index);
      output += text.slice(index, end);
      index = end;
      pendingSpace = false;
      continue;
    }
    if (/\s/u.test(char)) {
      pendingSpace = true;
    } else {
      if (pendingSpace && /\w/u.test(output.at(-1) ?? "") && /\w/u.test(char)) {
        output += " ";
      }
      output += char;
      pendingSpace = false;
    }
    index += 1;
  }
  return output;
}

function isQuote(char: string): boolean {
  return char === '"' || char === "'" || char === "`";
}

/** Index just past the string literal that starts at `start`. */
function skipString(text: string, start: number): number {
  const quote = text[start] as string;
  const triple = quote !== "`" && text.startsWith(quote.repeat(3), start);
  const delimiter = triple ? quote.repeat(3) : quote;
  const multiline = triple || quote === "`";
  let index = start + delimiter.length;

  while (index < text.length) {
    const char = text[index] as string;
    if (char === "\\") {
      index += 2;
    } else if (text.startsWith(delimiter, index)) {
      return index + delimiter.length;
    } else if (!multiline && char === "\n") {
      return index;
    } else {
      index += 1;
    }
  }
  return text.length;
}

function lineEnd(text: string, from: number): number {
  const newline = text.indexOf("\n", from);
  return newline === -1 ? text.length : newline;
}

function countMatches(code: string, pattern: RegExp): number {
  return (code.match(new RegExp(pattern.source, pattern.flags)) ?? []).length;
}
