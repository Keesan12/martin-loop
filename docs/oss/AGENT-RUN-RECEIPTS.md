# Agent Run Receipts

An agent run receipt is a local-first proof pack for a governed Martin Loop run. It gives a human or host agent enough evidence to answer:

- What was the agent asked to do?
- What limits applied?
- What verifier result decided the outcome?
- Why did the run stop?
- What local evidence can be replayed or inspected?

The OSS receipt is designed for public, free-tier usage. It favors concise local records, deterministic replay instructions, and clear evidence boundaries over hosted dashboards or paid telemetry.

## Receipt Fields

Recommended receipt fields:

| Field | Purpose |
| --- | --- |
| `receiptVersion` | Schema version for the public receipt shape. |
| `loopId` | Stable local run identifier. |
| `createdAt` | ISO timestamp when the receipt was written. |
| `objective` | User-facing run objective, redacted if needed. |
| `engine` | Agent runtime used for the run, such as `codex` or `claude`. |
| `budget` | Local execution limits, including `maxUsd`, `maxIterations`, timeout bounds, and allowed or denied paths. |
| `costProvenance` | Source of the cost estimate, for example model metadata, local token accounting, host-reported usage, or `unknown`. |
| `verificationPlan` | Commands or checks the run was expected to satisfy. |
| `verifierResult` | Final verifier status, exit code, checked command list, and relevant output locations. |
| `haltReason` | Why Martin Loop stopped, such as `verified`, `budget_exhausted`, `verifier_failed`, or `policy_blocked`. |
| `runDossier` | Paths or summaries for attempts, diffs, logs, verifier outputs, and final state. |
| `replaySteps` | Minimal local commands needed to inspect or reproduce the proof pack. |
| `evidenceBoundaries` | What evidence is included, excluded, redacted, or unavailable. |

Receipts should avoid storing secrets, raw environment files, private credentials, or unrelated workspace content. Prefer relative paths inside the run store when possible, with absolute paths only when useful for local debugging.

## Expected CLI And MCP Surfaces

Public OSS users should expect receipt data to be available through local inspection surfaces rather than a hosted service.

CLI-oriented surfaces:

- list recent runs
- inspect a single run by `loopId`
- print the run dossier
- print verifier results
- export or view a receipt as Markdown or JSON

MCP-oriented surfaces:

- `martin_list_runs` for discovery
- `martin_triage_runs` for prioritizing failed or suspicious runs
- `martin_get_run` for top-level run metadata
- `martin_get_attempt` for attempt-level evidence
- `martin_get_verification_results` for verifier output
- `martin_run_dossier` for the richest one-call inspection view
- `martin://runs/{loopId}` and related resources for read-only host access

Execution should still flow through the governed run entrypoint. Receipt inspection should be read-only.

## Failure Categories

Receipts should classify failures in practical terms so a maintainer can triage without rereading every log.

Common categories:

- `verifier_failed`: The configured verification command completed and failed.
- `budget_exhausted`: The run stopped because a configured dollar, iteration, or time limit was reached.
- `policy_blocked`: The run attempted a denied path, unsafe operation, or disallowed surface.
- `agent_unavailable`: The requested engine was not installed, authenticated, or callable.
- `workspace_dirty_conflict`: Existing local edits prevented a safe change.
- `no_action_taken`: Preflight or planning completed, but no execution occurred.
- `artifact_missing`: An expected log, attempt record, diff, or verifier output was not written.
- `unknown_cost`: The run completed, but cost provenance could not be verified.
- `operator_interrupted`: A human or host cancelled the run before natural completion.

Failure labels are not substitutes for logs. They are the receipt index that points readers to the right evidence first.

## Example Receipt

```json
{
  "receiptVersion": "1",
  "loopId": "loop-2026-05-16-001",
  "createdAt": "2026-05-16T18:30:00Z",
  "objective": "Fix the auth regression and prove it with tests",
  "engine": "codex",
  "budget": {
    "maxUsd": 3,
    "maxIterations": 3,
    "allowedPaths": ["src/**", "tests/**"],
    "deniedPaths": [".env*", "secrets/**"]
  },
  "costProvenance": {
    "source": "host_reported_usage",
    "confidence": "estimate"
  },
  "verificationPlan": ["pnpm test --filter auth"],
  "verifierResult": {
    "status": "failed",
    "exitCode": 1,
    "outputPath": ".martin/runs/loop-2026-05-16-001/verification.log"
  },
  "haltReason": "verifier_failed",
  "runDossier": {
    "summaryPath": ".martin/runs/loop-2026-05-16-001/dossier.md",
    "attemptsPath": ".martin/runs/loop-2026-05-16-001/attempts.jsonl"
  },
  "replaySteps": [
    "pnpm install --frozen-lockfile",
    "pnpm test --filter auth",
    "martin inspect loop-2026-05-16-001"
  ],
  "evidenceBoundaries": {
    "included": ["objective", "budget", "verifier output", "attempt summaries"],
    "excluded": ["secrets", "raw environment files", "private credentials"],
    "redactions": ["access tokens", "user-specific absolute paths where possible"]
  }
}
```

## Replay Guidance

A good receipt should let a reader reproduce the decision path, not necessarily replay the exact agent session token by token.

Recommended replay steps:

1. Check out the same commit or local workspace snapshot when available.
2. Install dependencies using the documented OSS package manager command.
3. Run the verifier commands listed in `verificationPlan`.
4. Inspect the dossier and attempt records for agent decisions.
5. Compare the new verifier result with the recorded `verifierResult`.

If exact replay is impossible because the workspace changed, the receipt should say so plainly in `evidenceBoundaries`.

## Evidence Boundaries

Included in OSS receipts:

- local run metadata
- configured budgets and path boundaries
- verifier command names, statuses, exit codes, and output paths
- run dossier links or summaries
- halt reason and failure category
- cost provenance as an estimate or unknown value
- replay steps for local inspection

Intentionally not included in OSS receipts:

- hosted dashboards
- paid analytics pipelines
- team audit trails or organization-wide compliance reporting
- secret scanning as a managed service
- private model-provider billing reconciliation
- remote artifact storage
- identity, SSO, RBAC, or enterprise policy details
- raw prompts or logs that may expose secrets unless explicitly opted in and redacted

Paid conversion can add hosted retention, richer analytics, shared review workflows, and organization policy controls. The OSS proof pack should remain useful without those services.

## Public-Safe Defaults

- Store receipts locally by default.
- Prefer redacted summaries over full raw transcripts.
- Treat cost as provenance-bound, not absolute truth.
- Make verifier failures explicit rather than reinterpreting them as success.
- Keep receipt inspection read-only.
- Preserve enough evidence for a maintainer to decide the next action quickly.
