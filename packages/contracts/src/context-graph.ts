export type ContextGraphNodeKind = "source_file" | "document" | "manifest" | "script" | "config";

export type ContextGraphEdgeKind = "imports" | "documents";

export interface ContextGraphNode {
  nodeId: string;
  path: string;
  kind: ContextGraphNodeKind;
  language?: string;
  sizeBytes: number;
  headings: string[];
  symbols: string[];
  keywords: string[];
  imports: string[];
}

export interface ContextGraphEdge {
  fromNodeId: string;
  toNodeId: string;
  kind: ContextGraphEdgeKind;
}

export interface ContextGraphSnapshot {
  schemaVersion: "martin.context-graph.v1";
  repoRoot: string;
  createdAt: string;
  nodeCount: number;
  edgeCount: number;
  truncated: boolean;
  nodes: ContextGraphNode[];
  edges: ContextGraphEdge[];
}

export interface ContextQuery {
  text?: string;
  terms?: string[];
  pathPrefix?: string;
  kinds?: ContextGraphNodeKind[];
  limit?: number;
}

export interface ContextGraphBuildOptions {
  maxFiles?: number;
  maxFileBytes?: number;
}

export interface ContextGraphHit {
  nodeId: string;
  path: string;
  kind: ContextGraphNodeKind;
  score: number;
  matchedTerms: string[];
  reasons: string[];
}

export function cloneContextGraphSnapshot(snapshot: ContextGraphSnapshot): ContextGraphSnapshot {
  return {
    schemaVersion: snapshot.schemaVersion,
    repoRoot: snapshot.repoRoot,
    createdAt: snapshot.createdAt,
    nodeCount: snapshot.nodeCount,
    edgeCount: snapshot.edgeCount,
    truncated: snapshot.truncated,
    nodes: snapshot.nodes.map((node) => ({
      nodeId: node.nodeId,
      path: node.path,
      kind: node.kind,
      ...(node.language ? { language: node.language } : {}),
      sizeBytes: node.sizeBytes,
      headings: [...node.headings],
      symbols: [...node.symbols],
      keywords: [...node.keywords],
      imports: [...node.imports]
    })),
    edges: snapshot.edges.map((edge) => ({
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      kind: edge.kind
    }))
  };
}
