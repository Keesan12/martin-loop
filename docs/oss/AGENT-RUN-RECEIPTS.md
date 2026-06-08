# Agent Run Receipts

An agent run receipt is a local proof pack for a governed MartinLoop run. It gives enough evidence to answer:

- what task was attempted
- what limits applied
- what verifier result determined the outcome
- why the run stopped
- what artifacts can be inspected or replayed

The OSS receipt is intentionally local-first. It prioritizes deterministic inspection and practical evidence over hosted dashboards.

## Receipt fields

| Field | Purpose |
| --- | --- |
| `receiptVersion` | Schema version for the receipt shape. |
| `loopId` | Stable run identifier. |
| `createdAt` | ISO timestamp when the receipt was written. |
| `objective` | User-facing run objective (redacted if needed). |
| `engine` | Agent runtime used for the run (`codex`, `claude`, `gemini`, and so on). |
| `budget` | Execution limits: spend, token, iteration, and scope boundaries. |
| `costProvenance` | Whether usage came from authoritative provider settlement, estimate, or unavailable source. |
| `verificationPlan` | Verifier commands the run was expected to satisfy. |
| `verifierResult` | Final verifier status, exit code, and evidence location. |
| `haltReason` | Terminal outcome (`verified`, `budget_exhausted`, `verifier_failed`, `policy_blocked`, etc.). |
| `runDossier` | Paths or summaries for attempts, logs, diffs, and final run state. |
| `replaySteps` | Minimal commands required to re-check the result locally. |
| `evidenceBoundaries` | What is included, redacted, excluded, or unavailable. |

## Expected CLI and MCP surfaces

CLI inspection surfaces:

- list runs
- inspect a run by `loopId`
- print a dossier
- print verifier outcomes
- export receipt views as JSON or Markdown

MCP inspection surfaces:

- `martin_list_runs`
- `martin_triage_runs`
- `martin_get_run`
- `martin_get_attempt`
- `martin_get_verification_results`
- `martin_run_dossier`
- `martin://runs/{loopId}` resources

Execution remains bounded to governed run entrypoints. Receipt inspection is read-only.

## Public receipt walkthrough (end to end)

Use this sequence to create and review a public-safe receipt bundle from a governed run.

1. Create governance receipts and run evidence:

```sh
npx martin-loop doctor
npx martin-loop session-start
npx martin-loop preflight "Summarize the workspace and prove tests still pass" --verify "npm test"
npx martin-loop run "Summarize the workspace and prove tests still pass" --proof --verify "npm test"
```

2. Inspect the persisted run:

```sh
npx martin-loop dossier --latest
npx martin-loop runs get --latest
npx martin-loop runs verify --latest
```

3. Create the share bundle:

```sh
npx martin-loop share --latest
```

Expected bundle output under the selected run directory in `share/`:

- `run-receipt.json` (machine-readable summary)
- `run-receipt.md` (human-readable recap)
- `proof-card.svg` (portable visual card)

4. Optional custom output directory:

```sh
npx martin-loop share --latest --out-dir ./receipts
```

Use this when you want receipt artifacts in a dedicated folder for issue attachments or release evidence.

## Failure categories

Receipts should classify failures in practical terms:

- `verifier_failed`
- `budget_exhausted`
- `policy_blocked`
- `agent_unavailable`
- `workspace_dirty_conflict`
- `no_action_taken`
- `artifact_missing`
- `unknown_cost`
- `operator_interrupted`

Failure labels are a triage index; they do not replace raw verifier and attempt evidence.

## Replay guidance

1. Check out the same commit or workspace snapshot when available.
2. Install dependencies with the documented package-manager command.
3. Run the recorded `verificationPlan`.
4. Inspect dossier and attempt evidence for decision context.
5. Compare the new verifier outcome with the stored `verifierResult`.

If exact replay is not possible because the workspace changed, the receipt should say that in `evidenceBoundaries`.

## Public-safe defaults

- receipts stay local by default
- redacted summaries are preferred over full raw transcripts
- usage is presented with provenance (`actual`, `estimated`, or `unavailable`)
- verifier failures are explicit and not reinterpreted as success
- inspection remains read-only
