/**
 * Martin Loop Eval Harness
 *
 * Runs a fixed set of structured tasks against the real Claude CLI adapter
 * and measures solve rate, attempt count, and cost.
 *
 * Requirements:
 *   - claude CLI installed and authenticated
 *   - MARTIN_LIVE=true (or not set — eval always runs live)
 *
 * Usage:
 *   pnpm --filter @martin/benchmarks eval
 *   MARTIN_LIVE=true pnpm eval  (from root)
 *
 * Pass threshold (for open-source gate): solveRate >= 0.60
 *
 * Exit codes:
 *   0 — all tasks at or above threshold
 *   1 — below threshold or runtime error
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import { createClaudeCliAdapter } from "@martin/adapters";
import { runMartin } from "@martin/core";
import type { LoopBudget } from "@martin/contracts";

// ---------------------------------------------------------------------------
// Task fixture types
// ---------------------------------------------------------------------------

interface EvalTask {
  taskId: string;
  label: string;
  objective: string;
  setupFile?: string;
  setupContent?: string;
  setupFiles?: Array<{ path: string; content: string }>;
  verificationPlan: string[];
  complexity: string;
  budget: LoopBudget;
  allowedPaths?: string[];
  deniedPaths?: string[];
  acceptanceCriteria?: string[];
}

interface EvalCaseResult {
  taskId: string;
  label: string;
  complexity: string;
  solved: boolean;
  attempts: number;
  costUsd: number;
  lifecycle: string;
  durationMs: number;
}

interface EvalReport {
  solveRate: number;
  solvedCount: number;
  totalCount: number;
  avgAttempts: number;
  totalUsd: number;
  passThreshold: number;
  passed: boolean;
  cases: EvalCaseResult[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const PASS_THRESHOLD = 0.6;

const fixturesPath = fileURLToPath(
  new URL("../fixtures/eval-tasks.json", import.meta.url)
);

async function main(): Promise<void> {
  const raw = await readFile(fixturesPath, "utf8");
  const tasks = JSON.parse(raw) as EvalTask[];

  process.stdout.write(
    `Martin Eval Harness — ${String(tasks.length)} task(s)\n`
  );
  process.stdout.write(`Engine: claude | Threshold: ${String(PASS_THRESHOLD * 100)}% solve rate\n`);
  process.stdout.write("─".repeat(60) + "\n");

  const results: EvalCaseResult[] = [];

  for (const task of tasks) {
    process.stdout.write(`\n[${task.taskId}] ${task.label} (${task.complexity})\n`);

    const workDir = await mkdtemp(join(tmpdir(), `martin-eval-${task.taskId}-`));

    try {
      if (task.setupFile && task.setupContent) {
        await writeFile(join(workDir, task.setupFile), task.setupContent, "utf8");
      }

      if (task.setupFiles && task.setupFiles.length > 0) {
        for (const f of task.setupFiles) {
          const dir = dirname(join(workDir, f.path));
          await mkdir(dir, { recursive: true });
          await writeFile(join(workDir, f.path), f.content, "utf8");
        }
      }

      const adapter = createClaudeCliAdapter({
        workingDirectory: workDir,
        timeoutMs: 120_000
      });

      const startMs = Date.now();

      const result = await runMartin({
        workspaceId: "ws_eval",
        projectId: `proj_${task.taskId}`,
        task: {
          title: task.label,
          objective: task.objective,
          verificationPlan: task.verificationPlan,
          repoRoot: workDir,
          ...(task.allowedPaths?.length ? { allowedPaths: task.allowedPaths } : {}),
          ...(task.deniedPaths?.length ? { deniedPaths: task.deniedPaths } : {}),
          ...(task.acceptanceCriteria?.length ? { acceptanceCriteria: task.acceptanceCriteria } : {})
        },
        budget: task.budget,
        adapter
      });

      const durationMs = Date.now() - startMs;
      const solved = result.decision.lifecycleState === "completed";

      const caseResult: EvalCaseResult = {
        taskId: task.taskId,
        label: task.label,
        complexity: task.complexity,
        solved,
        attempts: result.loop.attempts.length,
        costUsd: result.loop.cost.actualUsd,
        lifecycle: result.decision.lifecycleState,
        durationMs
      };

      results.push(caseResult);

      const mark = solved ? "PASS" : "FAIL";
      process.stdout.write(
        `  ${mark} | attempts: ${String(caseResult.attempts)} | cost: $${caseResult.costUsd.toFixed(4)} | ${String(Math.round(durationMs / 1000))}s\n`
      );
      process.stdout.write(`  lifecycle: ${caseResult.lifecycle}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`  ERROR: ${message}\n`);

      results.push({
        taskId: task.taskId,
        label: task.label,
        complexity: task.complexity,
        solved: false,
        attempts: 0,
        costUsd: 0,
        lifecycle: "error",
        durationMs: 0
      });
    } finally {
      await rm(workDir, { force: true, recursive: true });
    }
  }

  const solvedCount = results.filter((r) => r.solved).length;
  const solveRate = results.length === 0 ? 0 : solvedCount / results.length;
  const avgAttempts =
    results.length === 0
      ? 0
      : results.reduce((sum, r) => sum + r.attempts, 0) / results.length;
  const totalUsd = results.reduce((sum, r) => sum + r.costUsd, 0);

  const report: EvalReport = {
    solveRate: Math.round(solveRate * 100) / 100,
    solvedCount,
    totalCount: results.length,
    avgAttempts: Math.round(avgAttempts * 10) / 10,
    totalUsd: Math.round(totalUsd * 10_000) / 10_000,
    passThreshold: PASS_THRESHOLD,
    passed: solveRate >= PASS_THRESHOLD,
    cases: results
  };

  process.stdout.write("\n" + "─".repeat(60) + "\n");
  process.stdout.write("EVAL REPORT\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.stdout.write("─".repeat(60) + "\n");

  if (report.passed) {
    process.stdout.write(
      `PASSED — solve rate ${String(Math.round(solveRate * 100))}% >= ${String(PASS_THRESHOLD * 100)}% threshold\n`
    );
    process.exitCode = 0;
  } else {
    process.stderr.write(
      `FAILED — solve rate ${String(Math.round(solveRate * 100))}% < ${String(PASS_THRESHOLD * 100)}% threshold\n`
    );
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fatal eval error: ${message}\n`);
  process.exitCode = 1;
});
