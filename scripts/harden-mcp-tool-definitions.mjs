import fs from "node:fs";

const path = "packages/mcp/src/server.ts";
let source = fs.readFileSync(path, "utf8");

const replace = (from, to) => {
  if (!source.includes(from)) throw new Error(`Missing expected block: ${from.slice(0, 80)}`);
  source = source.replace(from, to);
};

replace(`const logsOutputSchema = {\n  type: "object",\n  additionalProperties: true\n} as const;`, `const logsOutputSchema = {\n  type: "object",\n  additionalProperties: false,\n  properties: {\n    source: { type: "string", description: "Resolved run-record source path." },\n    sourceKind: { type: "string", enum: ["file", "loop_id", "latest", "runs_root"], description: "How the target run was selected." },\n    loopId: { type: "string", description: "Stable MartinLoop run identifier." },\n    logCount: { type: "integer", minimum: 0, description: "Number of returned entries after applying limit." },\n    live: {\n      type: "object", additionalProperties: false,\n      properties: {\n        lifecycleState: { type: "string", description: "Current persisted lifecycle state." },\n        pauseState: { type: "string", enum: ["active", "paused", "cancellation_requested"], description: "Effective operator control state." },\n        approvalState: { type: "string", enum: ["not_required", "resume_requested"], description: "Whether a resume approval has been requested." }\n      },\n      required: ["lifecycleState", "pauseState", "approvalState"]\n    },\n    entries: {\n      type: "array", description: "Newest-first merged event, ledger, and control entries.",\n      items: {\n        type: "object", additionalProperties: false,\n        properties: {\n          timestamp: { type: "string", description: "ISO-8601 timestamp when available." },\n          source: { type: "string", enum: ["event", "ledger", "control"], description: "Evidence stream that produced the entry." },\n          kind: { type: "string", description: "Event, ledger, or control receipt type." },\n          payload: { type: "object", additionalProperties: true, description: "Structured evidence payload." }\n        },\n        required: ["source", "kind", "payload"]\n      }\n    }\n  },\n  required: ["source", "sourceKind", "loopId", "logCount", "live", "entries"]\n} as const;`);

replace(`const evalOutputSchema = {\n  type: "object",\n  additionalProperties: true\n} as const;`, `const evalOutputSchema = {\n  type: "object",\n  additionalProperties: false,\n  properties: {\n    source: { type: "string", description: "Resolved run-record source path." },\n    sourceKind: { type: "string", enum: ["file", "loop_id", "latest", "runs_root"], description: "How the target run was selected." },\n    loopId: { type: "string", description: "Run evaluated against promotion criteria." },\n    score: { type: "number", minimum: 0, maximum: 100, description: "Deterministic evidence score from 0 to 100." },\n    grade: { type: "string", enum: ["mergeable", "mergeable_with_review", "needs_review", "blocked", "insufficient_evidence"], description: "Promotion recommendation derived from evidence and risk." },\n    checks: {\n      type: "object", additionalProperties: false,\n      properties: Object.fromEntries(["taskCompletion", "verifier", "diffDiscipline", "regressionRisk", "securityRisk", "reviewability"].map((key) => [key, { type: "string", enum: ["passed", "warning", "failed"], description: `${key} assessment.` }])),\n      required: ["taskCompletion", "verifier", "diffDiscipline", "regressionRisk", "securityRisk", "reviewability"]\n    },\n    warnings: { ...stringArraySchema, description: "Evidence gaps and risk reasons requiring review." },\n    summary: { type: "string", description: "Human-readable promotion recommendation." }\n  },\n  required: ["source", "sourceKind", "loopId", "score", "grade", "checks", "warnings", "summary"]\n} as const;`);

replace(`const prSummaryOutputSchema = {\n  type: "object",\n  additionalProperties: true\n} as const;`, `const prSummaryOutputSchema = {\n  type: "object",\n  additionalProperties: false,\n  properties: {\n    loopId: { type: "string", description: "Run used to generate the PR material." },\n    title: { type: "string", description: "Suggested GitHub pull-request title." },\n    body: { type: "string", description: "GitHub-flavoured Markdown body containing the MartinLoop dossier." },\n    grade: { type: "string", description: "Evaluation grade attached to the PR summary." },\n    score: { type: "number", minimum: 0, maximum: 100, description: "Evaluation score attached to the PR summary." },\n    execute: { type: "boolean", description: "Whether GitHub PR creation was requested." },\n    created: { type: "boolean", description: "Whether a GitHub PR was actually created." },\n    url: { type: "string", description: "Created PR URL when execute=true succeeds." },\n    branch: { type: "string", description: "Current Git branch when detected." }\n  },\n  required: ["loopId", "title", "body", "grade", "score"]\n} as const;`);

replace(`const prReviewOutputSchema = {\n  type: "object",\n  additionalProperties: true\n} as const;`, `const prReviewOutputSchema = {\n  type: "object",\n  additionalProperties: false,\n  properties: {\n    loopId: { type: "string", description: "Run whose evidence was reviewed." },\n    verdict: { type: "string", enum: ["approve_with_review", "needs_changes", "blocked"], description: "Recommended PR disposition; never an automatic merge approval." },\n    findings: { ...stringArraySchema, description: "Specific evidence, verifier, or dossier gaps." },\n    summary: { type: "string", description: "Concise explanation of the verdict." }\n  },\n  required: ["loopId", "verdict", "findings", "summary"]\n} as const;`);

source = source.replace(/annotations: \{\n(\s+)(?!readOnlyHint)(destructiveHint: true,)/g, `annotations: {\n$1readOnlyHint: false,\n$1$2`);
source = source.replace(/annotations: \{\n(\s+)readOnlyHint: true,\n\1idempotentHint: true\n\s+\}/g, `annotations: {\n$1readOnlyHint: true,\n$1destructiveHint: false,\n$1idempotentHint: true,\n$1openWorldHint: false\n      }`);
source = source.replace(/annotations: \{\n(\s+)readOnlyHint: false,\n\1destructiveHint: true,\n\1idempotentHint: false\n\s+\}/g, `annotations: {\n$1readOnlyHint: false,\n$1destructiveHint: true,\n$1idempotentHint: false,\n$1openWorldHint: false\n      }`);

const descriptions = new Map([
  ["martin_logs", "Read stored run events, financial ledger entries, and operator-control receipts as one newest-first evidence stream. Use for debugging chronology or observing pause/cancel state; use martin_status for only the current budget/lifecycle snapshot and martin_run_dossier for the full evidence package. Reads local run records only and never executes commands or changes state."],
  ["martin_get_verification_results", "Return verifier commands, outcomes, contradictions, and warnings for one saved run. Use when deciding whether completion evidence is green; use martin_eval for a broader merge-readiness grade and martin_get_run for a compact run summary. Reads persisted evidence only and does not rerun verification commands."],
  ["martin_eval", "Deterministically grade one saved run for completion, verifier health, diff discipline, regression risk, security risk, and reviewability. Use before promotion or PR review; use martin_get_verification_results when only raw verifier evidence is needed. Reads local run and repository signals, executes no agent work, changes no files, and may return insufficient_evidence when receipts are incomplete."],
  ["martin_pr_summary", "Generate a GitHub-ready PR title and Markdown dossier body from one completed MartinLoop run, including its evaluation grade and score. Use to prepare copy without contacting GitHub; use martin_create_pr to create the PR and martin_review_pr to assess an existing body. Reads saved evidence only and makes no repository or network changes."],
  ["martin_review_pr", "Assess a supplied PR body against one MartinLoop run dossier, verifier evidence, and promotion grade. Use for a review recommendation after PR copy exists; use martin_pr_summary to generate copy and martin_eval for run-only grading. Returns findings and a recommendation but never posts a review, merges code, or contacts GitHub."]
]);
for (const [name, description] of descriptions) {
  const pattern = new RegExp(`(name: "${name}",\\n\\s+description:\\n\\s+)"[^"]*"`);
  if (!pattern.test(source)) throw new Error(`Tool description not found: ${name}`);
  source = source.replace(pattern, `$1${JSON.stringify(description)}`);
}

const selectorDescriptions = {
  file: "Path under the configured Martin runs root to a loop-record.json file or run directory. Supply exactly one selector: file, loopId, or latest.",
  loopId: "Stable run ID resolved under runsDir. Supply exactly one selector: file, loopId, or latest.",
  runsDir: "Optional runs-root override; it scopes loopId/latest resolution and must remain within the configured safe runs root.",
  latest: "Set true to select the most recently updated run. Supply exactly one selector: file, loopId, or latest.",
  limit: "Maximum newest-first entries to return. Must be at least 1; defaults to 20.",
  prBody: "Existing GitHub-flavoured Markdown PR body to compare with the MartinLoop dossier. Omit to review run evidence alone.",
  format: "Dossier rendering format. github-pr is appropriate for PR copy; defaults to json where supported."
};
for (const [key, description] of Object.entries(selectorDescriptions)) {
  const compact = new RegExp(`${key}: \\{ type: "(string|integer)",?(?: minimum: 1,)? \\}`,'g');
  source = source.replace(compact, (match, type) => `${key}: { type: "${type}",${type === "integer" ? " minimum: 1," : ""} description: ${JSON.stringify(description)} }`);
  if (key === "latest") source = source.replace(/latest: \{ const: true \}/g, `latest: { const: true, description: ${JSON.stringify(description)} }`);
}

fs.writeFileSync(path, source);
console.log("Hardened MCP tool definitions");
