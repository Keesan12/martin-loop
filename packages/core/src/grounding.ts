import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, relative } from "node:path";

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

export async function loadOrBuildRepoGroundingIndex(
  repoRoot: string
): Promise<RepoGroundingIndex> {
  const cachePath = getGroundingCachePath(repoRoot);
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as RepoGroundingIndex;
    if (cached?.schemaVersion === "martin.grounding.v1") {
      return cached;
    }
  } catch {}

  const index = await buildRepoGroundingIndex(repoRoot);
  await mkdir(join(homedir(), ".martin", "grounding"), { recursive: true });
  await writeFile(cachePath, JSON.stringify(index, null, 2), "utf8");
  return index;
}

export async function buildRepoGroundingIndex(
  repoRoot: string
): Promise<RepoGroundingIndex> {
  const files: RepoGroundingFile[] = [];
  const discovered = await walk(repoRoot, repoRoot, files, { count: 0 });
  return {
    schemaVersion: "martin.grounding.v1",
    repoRoot,
    createdAt: new Date().toISOString(),
    fileCount: discovered.count,
    files
  };
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
    homedir(),
    ".martin",
    "grounding",
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
