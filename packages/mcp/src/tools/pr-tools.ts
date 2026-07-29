// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { loadDetailedLoopRecord } from "./run-store.js";
import { martinRunDossierTool, type MartinRunDossierInput } from "./run-dossier.js";
import { martinEvalTool } from "./eval.js";
import { resolveTrustedLoopRepoRoot } from "../server-validation.js";
import { detectCliAvailability } from "./tool-support.js";
import { MartinToolError } from "./tool-errors.js";

export interface MartinPrSummaryOutput {
  loopId: string;
  title: string;
  body: string;
  grade: string;
  score: number;
}

export interface MartinCreatePrInput extends MartinRunDossierInput {
  title?: string;
  base?: string;
  execute?: boolean;
}

export interface MartinCreatePrOutput extends MartinPrSummaryOutput {
  execute: boolean;
  created: boolean;
  url?: string;
  branch?: string;
}

export interface MartinReviewPrInput extends MartinRunDossierInput {
  prBody?: string;
}

export interface MartinReviewPrOutput {
  loopId: string;
  verdict: "approve_with_review" | "needs_changes" | "blocked";
  findings: string[];
  summary: string;
}

export async function martinPrSummaryTool(
  input: MartinRunDossierInput
): Promise<MartinPrSummaryOutput> {
  const dossier = await martinRunDossierTool({ ...input, format: "github-pr" });
  const evaluation = await martinEvalTool(input);
  const title = `martin: ${trimForTitle(dossier.loop.objective)}`;
  const body = dossier.rendered ?? "";

  return {
    loopId: dossier.loop.loopId,
    title,
    body,
    grade: evaluation.grade,
    score: evaluation.score
  };
}

export async function martinCreatePrTool(
  input: MartinCreatePrInput
): Promise<MartinCreatePrOutput> {
  const summary = await martinPrSummaryTool(input);
  const detail = await loadDetailedLoopRecord(input);
  const repoRoot = resolveTrustedLoopRepoRoot(detail.loop.task?.repoRoot);
  const branch = readGitValue(repoRoot, ["branch", "--show-current"]);
  const title = input.title?.trim() || summary.title;

  if (!input.execute) {
    return {
      ...summary,
      title,
      execute: false,
      created: false,
      ...(branch ? { branch } : {})
    };
  }

  const gh = detectCliAvailability("gh");
  if (!gh.available) {
    throw new MartinToolError("engine_unavailable", "GitHub CLI is not available on PATH.", {
      category: "environment",
      suggestion: "Install gh or rerun martin_create_pr with execute=false to preview the PR body.",
      retryable: false
    });
  }

  const args = ["pr", "create", "--title", title, "--body", summary.body];
  if (input.base) {
    args.push("--base", input.base);
  }
  const result = spawnSync("gh", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.status !== 0) {
    throw new MartinToolError("tool_execution_failed", "GitHub PR creation failed.", {
      category: "transient",
      suggestion: (result.stderr || result.stdout || "Check gh auth and branch state.").trim(),
      retryable: false
    });
  }

  const url = `${result.stdout ?? ""}`.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
  return {
    ...summary,
    title,
    execute: true,
    created: true,
    ...(url ? { url } : {}),
    ...(branch ? { branch } : {})
  };
}

export async function martinReviewPrTool(
  input: MartinReviewPrInput
): Promise<MartinReviewPrOutput> {
  const summary = await martinPrSummaryTool(input);
  const evaluation = await martinEvalTool(input);
  const findings: string[] = [];

  if (evaluation.grade === "blocked" || evaluation.grade === "insufficient_evidence") {
    findings.push("Run evidence is not strong enough for a safe merge decision.");
  }
  if (evaluation.checks.verifier !== "passed") {
    findings.push("Verifier evidence is not green.");
  }
  if (evaluation.checks.securityRisk !== "passed") {
    findings.push("Risk score requires closer human review.");
  }
  if (input.prBody && !/MartinLoop Run Dossier/iu.test(input.prBody)) {
    findings.push("PR body is missing the MartinLoop dossier section.");
  }

  const verdict =
    findings.length === 0
      ? "approve_with_review"
      : findings.some((finding) => /not strong enough|not green/iu.test(finding))
        ? "blocked"
        : "needs_changes";

  return {
    loopId: summary.loopId,
    verdict,
    findings,
    summary:
      verdict === "approve_with_review"
        ? "PR evidence looks reviewable."
        : verdict === "needs_changes"
          ? "PR needs changes before review is complete."
          : "PR is blocked by evidence or verifier gaps."
  };
}

function trimForTitle(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57).trimEnd()}...` : value;
}

function readGitValue(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}
