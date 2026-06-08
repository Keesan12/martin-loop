import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildContextGraphSnapshot, queryContextGraph } from "../src/index.js";

describe("context graph foundation", () => {
  it("builds a portable repo snapshot with nodes and edges", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "martin-context-graph-"));

    try {
      await mkdir(join(repoRoot, "src"), { recursive: true });
      await writeFile(
        join(repoRoot, "src", "index.ts"),
        [
          'import { runBudgetGate } from "./budget.js";',
          "export function runMartinLoop() {",
          "  return runBudgetGate();",
          "}"
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        join(repoRoot, "src", "budget.ts"),
        [
          "export function runBudgetGate() {",
          '  return "ok";',
          "}"
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        join(repoRoot, "README.md"),
        ["# MartinLoop", "", "## Budget policy", "", "Keep governed runtime budgets explicit."].join("\n"),
        "utf8"
      );
      await writeFile(
        join(repoRoot, "package.json"),
        JSON.stringify({ name: "martin-context-graph-test", type: "module" }, null, 2),
        "utf8"
      );

      const snapshot = await buildContextGraphSnapshot(repoRoot, { maxFiles: 20 });

      expect(snapshot.schemaVersion).toBe("martin.context-graph.v1");
      expect(snapshot.nodeCount).toBe(4);
      expect(snapshot.truncated).toBe(false);
      expect(snapshot.nodes.map((node) => node.path)).toEqual(
        expect.arrayContaining(["README.md", "package.json", "src/index.ts", "src/budget.ts"])
      );
      expect(snapshot.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "imports",
            fromNodeId: "src/index.ts",
            toNodeId: "src/budget.ts"
          })
        ])
      );
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("queries nodes by path, symbol, heading, and keyword relevance", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "martin-context-query-"));

    try {
      await mkdir(join(repoRoot, "docs"), { recursive: true });
      await mkdir(join(repoRoot, "src"), { recursive: true });
      await writeFile(
        join(repoRoot, "docs", "governance.md"),
        ["# Governance", "", "## Policy Compiler", "", "Execution policy keeps budgets and verifier rules aligned."].join("\n"),
        "utf8"
      );
      await writeFile(
        join(repoRoot, "src", "policy.ts"),
        [
          "export interface ExecutionPolicy {",
          "  maxUsd: number;",
          "}",
          "export function compileExecutionPolicy() {",
          "  return { maxUsd: 1 };",
          "}"
        ].join("\n"),
        "utf8"
      );

      const snapshot = await buildContextGraphSnapshot(repoRoot, { maxFiles: 20 });
      const hits = queryContextGraph(snapshot, {
        text: "execution policy compile budget",
        limit: 3
      });

      expect(hits).toHaveLength(2);
      expect(hits[0]?.path).toBe("src/policy.ts");
      expect(hits[0]?.reasons).toEqual(expect.arrayContaining(["path", "symbol", "keyword"]));
      expect(hits[1]?.path).toBe("docs/governance.md");
      expect(hits[1]?.reasons).toEqual(expect.arrayContaining(["heading", "keyword"]));
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
