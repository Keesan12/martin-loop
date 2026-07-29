// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile } from "node:fs/promises";
import { extname, join, posix, relative, resolve } from "node:path";

import {
  cloneContextGraphSnapshot,
  type ContextGraphBuildOptions,
  type ContextGraphEdge,
  type ContextGraphHit,
  type ContextGraphNode,
  type ContextGraphNodeKind,
  type ContextGraphSnapshot,
  type ContextQuery
} from "@martin/contracts";

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".yaml",
  ".yml",
  ".txt",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".sh"
]);

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".pnpm-store",
  ".npm-cache"
]);

export async function buildContextGraphSnapshot(
  repoRoot: string,
  options: ContextGraphBuildOptions = {}
): Promise<ContextGraphSnapshot> {
  const normalizedRoot = resolve(repoRoot);
  const maxFiles = options.maxFiles ?? 600;
  const maxFileBytes = options.maxFileBytes ?? 96_000;
  const nodes: ContextGraphNode[] = [];
  const state = { count: 0, truncated: false };

  await walkContextGraph(normalizedRoot, normalizedRoot, nodes, state, { maxFiles, maxFileBytes });

  const edges = buildContextGraphEdges(nodes);

  return cloneContextGraphSnapshot({
    schemaVersion: "martin.context-graph.v1",
    repoRoot: normalizedRoot,
    createdAt: new Date().toISOString(),
    nodeCount: nodes.length,
    edgeCount: edges.length,
    truncated: state.truncated,
    nodes,
    edges
  });
}

export function queryContextGraph(
  snapshot: ContextGraphSnapshot,
  query: ContextQuery
): ContextGraphHit[] {
  const terms = normalizeQueryTerms(query);
  const pathPrefix = query.pathPrefix?.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
  const limit = query.limit ?? 8;

  return snapshot.nodes
    .filter((node) => {
      if (query.kinds && !query.kinds.includes(node.kind)) {
        return false;
      }
      if (pathPrefix && !node.path.startsWith(pathPrefix)) {
        return false;
      }
      return true;
    })
    .map((node) => scoreContextNode(node, terms))
    .filter((hit): hit is ContextGraphHit => hit !== undefined)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, limit);
}

async function walkContextGraph(
  repoRoot: string,
  currentDir: string,
  nodes: ContextGraphNode[],
  state: { count: number; truncated: boolean },
  options: Required<ContextGraphBuildOptions>
): Promise<void> {
  if (state.count >= options.maxFiles) {
    state.truncated = true;
    return;
  }

  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (state.count >= options.maxFiles) {
      state.truncated = true;
      break;
    }

    const absPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        await walkContextGraph(repoRoot, absPath, nodes, state, options);
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = extname(entry.name).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) {
      continue;
    }

    const content = await readFile(absPath, "utf8").catch(() => undefined);
    if (!content || content.length > options.maxFileBytes) {
      continue;
    }

    const relPath = relative(repoRoot, absPath).replace(/\\/gu, "/");
    nodes.push(createContextNode(relPath, content));
    state.count += 1;
  }
}

function createContextNode(path: string, content: string): ContextGraphNode {
  const kind = classifyContextNodeKind(path);
  return {
    nodeId: path,
    path,
    kind,
    ...(inferLanguage(path) ? { language: inferLanguage(path) } : {}),
    sizeBytes: Buffer.byteLength(content, "utf8"),
    headings: extractHeadings(path, content),
    symbols: extractSymbols(content),
    keywords: extractKeywords(path, content),
    imports: extractImports(path, content)
  };
}

function buildContextGraphEdges(nodes: ContextGraphNode[]): ContextGraphEdge[] {
  const paths = new Set(nodes.map((node) => node.path));
  const edges: ContextGraphEdge[] = [];

  for (const node of nodes) {
    for (const importTarget of node.imports) {
      const resolvedTarget = resolveContextImport(node.path, importTarget, paths);
      if (resolvedTarget) {
        edges.push({
          fromNodeId: node.nodeId,
          toNodeId: resolvedTarget,
          kind: "imports"
        });
      }
    }

    if (node.kind === "document") {
      const documentTargets = node.keywords
        .map((keyword) => nodes.find((candidate) => candidate.path !== node.path && candidate.path.includes(keyword)))
        .filter((candidate): candidate is ContextGraphNode => candidate !== undefined)
        .slice(0, 3);

      for (const target of documentTargets) {
        edges.push({
          fromNodeId: node.nodeId,
          toNodeId: target.nodeId,
          kind: "documents"
        });
      }
    }
  }

  return dedupeEdges(edges);
}

function scoreContextNode(node: ContextGraphNode, terms: string[]): ContextGraphHit | undefined {
  if (terms.length === 0) {
    return {
      nodeId: node.nodeId,
      path: node.path,
      kind: node.kind,
      score: 1,
      matchedTerms: [],
      reasons: ["default_match"]
    };
  }

  let score = 0;
  const matchedTerms = new Set<string>();
  const reasons = new Set<string>();

  for (const term of terms) {
    if (node.path.toLowerCase().includes(term)) {
      score += 6;
      matchedTerms.add(term);
      reasons.add("path");
    }
    if (node.keywords.includes(term)) {
      score += 3;
      matchedTerms.add(term);
      reasons.add("keyword");
    }
    if (node.symbols.some((symbol) => symbol.toLowerCase().includes(term))) {
      score += 5;
      matchedTerms.add(term);
      reasons.add("symbol");
    }
    if (node.headings.some((heading) => heading.toLowerCase().includes(term))) {
      score += 4;
      matchedTerms.add(term);
      reasons.add("heading");
    }
    if (node.imports.some((importPath) => importPath.toLowerCase().includes(term))) {
      score += 2;
      matchedTerms.add(term);
      reasons.add("import");
    }
  }

  if (score === 0) {
    return undefined;
  }

  return {
    nodeId: node.nodeId,
    path: node.path,
    kind: node.kind,
    score,
    matchedTerms: [...matchedTerms],
    reasons: [...reasons]
  };
}

function normalizeQueryTerms(query: ContextQuery): string[] {
  const rawTerms = [
    ...(query.text ? tokenize(query.text) : []),
    ...((query.terms ?? []).flatMap((term) => tokenize(term)))
  ];
  return [...new Set(rawTerms)];
}

function classifyContextNodeKind(path: string): ContextGraphNodeKind {
  const extension = extname(path).toLowerCase();
  if (path.endsWith("package.json") || path.endsWith("tsconfig.json")) {
    return "manifest";
  }
  if (extension === ".md" || extension === ".txt") {
    return "document";
  }
  if (extension === ".sh") {
    return "script";
  }
  if (extension === ".json" || extension === ".yaml" || extension === ".yml") {
    return "config";
  }
  return "source_file";
}

function inferLanguage(path: string): string | undefined {
  const extension = extname(path).toLowerCase();
  switch (extension) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".md":
      return "markdown";
    case ".json":
      return "json";
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".py":
      return "python";
    case ".sh":
      return "shell";
    default:
      return undefined;
  }
}

function extractHeadings(path: string, content: string): string[] {
  if (extname(path).toLowerCase() !== ".md") {
    return [];
  }

  return content
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("#"))
    .map((line) => line.replace(/^#+\s*/u, "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

function extractSymbols(content: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/gu,
    /export\s+class\s+([A-Za-z0-9_]+)/gu,
    /export\s+const\s+([A-Za-z0-9_]+)/gu,
    /function\s+([A-Za-z0-9_]+)/gu,
    /class\s+([A-Za-z0-9_]+)/gu,
    /interface\s+([A-Za-z0-9_]+)/gu,
    /type\s+([A-Za-z0-9_]+)/gu
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) {
        out.add(match[1]);
      }
    }
  }

  return [...out].slice(0, 16);
}

function extractKeywords(path: string, content: string): string[] {
  const out = new Set<string>();
  for (const part of path.split(/[\/._-]+/u)) {
    if (part.length >= 3) {
      out.add(part.toLowerCase());
    }
  }
  for (const token of tokenize(content.split(/\r?\n/gu).slice(0, 16).join(" "))) {
    out.add(token);
  }
  return [...out].slice(0, 24);
}

function extractImports(path: string, content: string): string[] {
  if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extname(path).toLowerCase())) {
    return [];
  }

  const imports = new Set<string>();
  const patterns = [
    /from\s+["']([^"']+)["']/gu,
    /require\(\s*["']([^"']+)["']\s*\)/gu,
    /import\(\s*["']([^"']+)["']\s*\)/gu
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const candidate = match[1]?.trim();
      if (candidate) {
        imports.add(candidate);
      }
    }
  }

  return [...imports].slice(0, 24);
}

function resolveContextImport(
  fromPath: string,
  importPath: string,
  paths: Set<string>
): string | undefined {
  if (!importPath.startsWith(".")) {
    return undefined;
  }

  const fromDirectory = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const base = posix.normalize(posix.join(fromDirectory, importPath)).replace(/^\.\//u, "");
  const extensionlessBase = extname(base) ? base.slice(0, -extname(base).length) : base;
  const candidates = [
    base,
    extensionlessBase,
    `${extensionlessBase}.ts`,
    `${extensionlessBase}.tsx`,
    `${extensionlessBase}.js`,
    `${extensionlessBase}.jsx`,
    `${extensionlessBase}.md`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.md`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`
  ];

  return candidates.find((candidate) => paths.has(candidate));
}

function dedupeEdges(edges: ContextGraphEdge[]): ContextGraphEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.kind}:${edge.fromNodeId}:${edge.toNodeId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function tokenize(input: string): string[] {
  const normalized = input.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").toLowerCase();
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "into",
    "only",
    "keep",
    "make",
    "loop",
    "then",
    "when"
  ]);
  return [...new Set(normalized.match(/[a-z0-9_]{3,}/gu) ?? [])].filter((term) => !stopWords.has(term));
}
