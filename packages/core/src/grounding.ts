import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RepoGroundingFile {
  path: string;
  symbols: string[];
  keywords: string[];
}

export interface RepoGroundingIndex {
  schemaVersion: "martin.grounding.v1";
  repoRoot: string;
  createdAt: string;
  fileCount: number;
  files: RepoGroundingFile[];
  trackedPaths?: string[];
  repositoryFingerprint?: string;
}

export interface RepoGroundingHit {
  path: string;
  score: number;
  matchedTerms: string[];
  symbols: string[];
}

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".md", ".yaml", ".yml", ".py", ".go",
  ".rs", ".java", ".sh"
]);

const IGNORED_DIRS = new Set([
  ".git", "node_modules", ".next", "dist", "build",
  ".turbo", "coverage", ".npm-cache", ".pnpm-store"
]);

const MAX_FILE_BYTES = 64_000;
const MAX_FILES = 500;

export function resolveGroundingRoot(env: NodeJS.ProcessEnv = process.env): string {
  return (env["MARTIN_GROUNDING_DIR"] as string | undefined)?.trim() ||
    join(homedir(), ".martin", "grounding");
}

export async function loadOrBuildRepoGroundingIndex(
  repoRoot: string
): Promise<RepoGroundingIndex> {
  const cachePath = getGroundingCachePath(repoRoot);
  const repositoryFingerprint = await computeRepositoryFingerprint(repoRoot);
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as RepoGroundingIndex;
    if (
      cached?.schemaVersion === "martin.grounding.v1" &&
      cached.repositoryFingerprint === repositoryFingerprint
    ) {
      return cached;
    }
  } catch {}

  const index = await buildRepoGroundingIndex(repoRoot, repositoryFingerprint);
  try {
    await mkdir(resolveGroundingRoot(), { recursive: true });
    await writeFile(cachePath, JSON.stringify(index, null, 2), "utf8");
  } catch {
    // Cache persistence is best-effort; runtime grounding must still work even
    // when the local filesystem blocks writes to ~/.martin/grounding.
  }
  return index;
}

export async function buildRepoGroundingIndex(
  repoRoot: string,
  repositoryFingerprint?: string
): Promise<RepoGroundingIndex> {
  const files: RepoGroundingFile[] = [];
  const discovered = await walk(repoRoot, repoRoot, files, { count: 0 });
  const trackedPaths = await loadTrackedPaths(repoRoot);
  return {
    schemaVersion: "martin.grounding.v1",
    repoRoot,
    createdAt: new Date().toISOString(),
    fileCount: discovered.count,
    files,
    ...(trackedPaths.length > 0 ? { trackedPaths } : {}),
    repositoryFingerprint: repositoryFingerprint ?? await computeRepositoryFingerprint(repoRoot)
  };
}

async function computeRepositoryFingerprint(repoRoot: string): Promise<string> {
  const entries: string[] = [];
  await collectFingerprintEntries(repoRoot, repoRoot, entries, { count: 0 });
  for (const trackedPath of await loadTrackedPaths(repoRoot)) {
    entries.push(`tracked:${trackedPath}`);
  }
  entries.sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

async function loadTrackedPaths(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, "ls-files", "-z"], {
      encoding: "utf8",
      windowsHide: true
    });
    return stdout
      .split("\0")
      .map((filePath: string) => filePath.trim().replace(/\\/g, "/"))
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

async function collectFingerprintEntries(
  repoRoot: string,
  currentDir: string,
  entries: string[],
  state: { count: number }
): Promise<void> {
  if (state.count >= MAX_FILES) return;
  const directoryEntries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of directoryEntries) {
    if (state.count >= MAX_FILES) break;
    const absPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        await collectFingerprintEntries(repoRoot, absPath, entries, state);
      }
      continue;
    }
    if (!entry.isFile() || !TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;

    try {
      const metadata = await stat(absPath);
      const relPath = relative(repoRoot, absPath).replace(/\\/g, "/");
      entries.push(`${relPath}:${metadata.size}:${metadata.mtimeMs}`);
      state.count += 1;
    } catch {}
  }
}

export function queryRepoGroundingIndex(
  index: RepoGroundingIndex,
  query: string,
  limit = 6
): RepoGroundingHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  return index.files
    .map((file): RepoGroundingHit | undefined => {
      let score = 0;
      const matched = new Set<string>();

      for (const term of terms) {
        if (file.path.toLowerCase().includes(term)) {
          score += 5;
          matched.add(term);
        }
        if (file.keywords.some((keyword) => keyword === term)) {
          score += 3;
          matched.add(term);
        }
        if (file.symbols.some((symbol) => symbol.toLowerCase().includes(term))) {
          score += 4;
          matched.add(term);
        }
      }

      if (score === 0) return undefined;
      return {
        path: file.path,
        score,
        matchedTerms: [...matched],
        symbols: file.symbols.slice(0, 5)
      };
    })
    .filter((item): item is RepoGroundingHit => Boolean(item))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}

function getGroundingCachePath(repoRoot: string): string {
  return join(
    resolveGroundingRoot(),
    `${Buffer.from(repoRoot).toString("base64url")}.json`
  );
}

async function walk(
  repoRoot: string,
  currentDir: string,
  files: RepoGroundingFile[],
  state: { count: number }
): Promise<{ count: number }> {
  if (state.count >= MAX_FILES) return state;
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (state.count >= MAX_FILES) break;
    const absPath = join(currentDir, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        await walk(repoRoot, absPath, files, state);
      }
      continue;
    }

    if (!entry.isFile()) continue;
    if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;

    try {
      const content = await readFile(absPath, "utf8");
      if (content.length > MAX_FILE_BYTES) continue;
      const relPath = relative(repoRoot, absPath).replace(/\\/g, "/");
      files.push({
        path: relPath,
        symbols: extractSymbols(content),
        keywords: extractKeywords(relPath, content)
      });
      state.count += 1;
    } catch {}
  }

  return state;
}

function extractSymbols(content: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g,
    /export\s+class\s+([A-Za-z0-9_]+)/g,
    /export\s+const\s+([A-Za-z0-9_]+)/g,
    /function\s+([A-Za-z0-9_]+)/g,
    /class\s+([A-Za-z0-9_]+)/g,
    /def\s+([A-Za-z0-9_]+)/g
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) out.add(match[1]);
    }
  }

  return [...out].slice(0, 12);
}

function extractKeywords(relPath: string, content: string): string[] {
  const out = new Set<string>();
  for (const part of relPath.split(/[\/.\-_]+/u)) {
    if (part.length >= 3) out.add(part.toLowerCase());
  }
  for (const term of tokenize(content.split("\n").slice(0, 10).join(" "))) {
    out.add(term);
  }
  return [...out].slice(0, 20);
}

function tokenize(input: string): string[] {
  const stopWords = new Set([
    "the", "and", "for", "with", "from", "that",
    "this", "into", "only", "keep", "fix", "make", "loop"
  ]);
  return [...new Set(input.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])].filter(
    (term) => !stopWords.has(term)
  );
}

// ─── Phase 4: Grounding Scanner ──────────────────────────────────────────────

export type GroundingViolationKind =
  | "file_not_found"
  | "symbol_not_found"
  | "import_not_found"
  | "patch_outside_allowed_paths";

export interface GroundingViolation {
  kind: GroundingViolationKind;
  reference: string;
  sourceHint?: string;
}

export interface GroundingScanResult {
  violations: GroundingViolation[];
  scannedReferences: number;
  resolvedFiles: string[];
  /** True when the diff adds only comments, whitespace, or empty lines — no substantive code. */
  contentOnly: boolean;
}

export function scanPatchForGroundingViolations(
  diff: string,
  index: RepoGroundingIndex,
  options: { allowedPaths?: string[] } = {}
): GroundingScanResult {
  const violations: GroundingViolation[] = [];
  const resolvedFiles: string[] = [];
  const indexedPaths = new Set([
    ...index.files.map((file) => file.path),
    ...(index.trackedPaths ?? [])
  ]);
  const indexedSymbols = new Set(
    index.files.flatMap((file) => file.symbols.map((symbol) => symbol.toLowerCase()))
  );
  const referencedFiles = new Set<string>();
  const addedFiles = new Set<string>();
  const diffFilePattern = /^(?:---|\+\+\+)\s+[ab]\/(.+)$/gm;
  const addedFilePattern = /^---\s+\/dev\/null\r?\n\+\+\+\s+b\/(.+)$/gm;

  for (const match of diff.matchAll(addedFilePattern)) {
    const filePath = match[1]?.trim();
    if (filePath) addedFiles.add(filePath);
  }

  for (const match of diff.matchAll(diffFilePattern)) {
    const filePath = match[1]?.trim();
    if (filePath && filePath !== "/dev/null") {
      referencedFiles.add(filePath);
    }
  }

  for (const filePath of referencedFiles) {
    if (indexedPaths.has(filePath) || addedFiles.has(filePath)) {
      resolvedFiles.push(filePath);
    } else {
      violations.push({
        kind: "file_not_found",
        reference: filePath,
        sourceHint: `diff header references ${filePath}`
      });
    }

    if (options.allowedPaths?.length) {
      const isAllowed = options.allowedPaths.some((pattern) =>
        matchesGlobPattern(filePath, pattern)
      );
      if (!isAllowed) {
        violations.push({
          kind: "patch_outside_allowed_paths",
          reference: filePath,
          sourceHint: `${filePath} is outside allowed paths: ${options.allowedPaths.join(", ")}`
        });
      }
    }
  }

  const addedLinePattern = /^\+(?!\+\+)(.+)$/gm;
  const importPattern = /(?:import|require)\s*(?:.*\s+from\s+)?['"]([^'"]+)['"]/g;
  const callableIdentifierPattern = /(?<!\.)\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  const symbolKeywords = new Set([
    "const",
    "let",
    "var",
    "function",
    "class",
    "return",
    "export",
    "import",
    "from",
    "await",
    "async",
    "new",
    "true",
    "false",
    "null",
    "undefined",
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "typeof"
  ]);
  const addedLines = [...diff.matchAll(addedLinePattern)].map((match) => match[1] ?? "");
  const declaredSymbols = new Set<string>();
  const declarationPattern = /\b(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/g;

  for (const line of addedLines) {
    for (const declarationMatch of line.matchAll(declarationPattern)) {
      const symbol = declarationMatch[1];
      if (symbol) declaredSymbols.add(symbol.toLowerCase());
    }

    if (/^\s*import\b/u.test(line)) {
      const importClause = line.match(/^\s*import\s+(.+?)\s+from\s+['"]/u)?.[1] ?? "";
      for (const importSymbol of importClause.matchAll(/\b(?:as\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
        const symbol = importSymbol[1];
        if (symbol && symbol !== "as") declaredSymbols.add(symbol.toLowerCase());
      }
    }
  }

  for (const line of addedLines) {

    for (const importMatch of line.matchAll(importPattern)) {
      const reference = importMatch[1] ?? "";
      if (!reference.startsWith(".") && !reference.startsWith("/")) {
        continue;
      }

      const normalized = reference
        .replace(/^\.\//, "")
        .replace(/\.(js|ts|tsx|jsx)$/, "");
      const hasMatch = index.files.some((file) => {
        const withoutExt = file.path.replace(/\.(js|ts|tsx|jsx)$/, "");
        return withoutExt.endsWith(normalized) || withoutExt.includes(normalized);
      }) || [...addedFiles].some((filePath) => {
        const withoutExt = filePath.replace(/\.(js|ts|tsx|jsx)$/, "");
        return withoutExt.endsWith(normalized) || withoutExt.includes(normalized);
      });

      if (!hasMatch) {
        violations.push({
          kind: "import_not_found",
          reference,
          sourceHint: `import in added line: ${line.trim().slice(0, 80)}`
        });
      }
    }

    for (const symbolMatch of line.matchAll(callableIdentifierPattern)) {
      const symbol = symbolMatch[1];
      if (!symbol) continue;
      if (symbolKeywords.has(symbol)) continue;
      if (/^[A-Z]/u.test(symbol)) continue;
      if (declaredSymbols.has(symbol.toLowerCase())) continue;
      if (indexedSymbols.has(symbol.toLowerCase())) continue;
      if (/^[a-z]+$/.test(symbol) && symbol.length <= 4) continue;

      violations.push({
        kind: "symbol_not_found",
        reference: symbol,
        sourceHint: `symbol in added line: ${line.trim().slice(0, 80)}`
      });
    }
  }

  // Detect content-only diff (only comments, whitespace, empty lines added)
  const substantiveLinePattern = /^\+(?!\+\+)\s*(?!\/\/|\/\*|\*|#).*\S/gm;
  const hasSubstantiveLines = substantiveLinePattern.test(diff);
  const contentOnly = !hasSubstantiveLines && diff.includes("+");

  return {
    violations,
    scannedReferences: referencedFiles.size,
    resolvedFiles,
    contentOnly
  };
}

function matchesGlobPattern(filePath: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLESTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLESTAR__/g, ".*");

  return new RegExp(`^${regexStr}$`).test(filePath);
}
