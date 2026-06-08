# Agent Run Receipts

An agent run receipt is a local proof pack for a governed MartinLoop run. It gives enough evidence to answer:

- what task was attempted
- what limits applied
- what verifier result determined the outcome
- why the run stopped
- what artifacts can be inspected or replayed

The OSS receipt is intentionally local-first. It prioritizes deterministic inspection and practical evidence over hosted dashboards.

## Receipt fields (`run-receipt.json`)

| Field | Purpose |
| --- | --- |
| `schemaVersion` | Receipt schema identifier (`martin.share-receipt.v1`). |
| `generatedAt` | ISO timestamp when the share receipt was generated. |
| `loop` | Top-level run facts: `loopId`, title/objective, status/lifecycleState, attempts, spend/budget, update time. |
| `receiptIntegrity` | Integrity verdict from local persisted evidence (`verified`, `tamper_detected`, `unsigned`). |
| `verification` | Verifier summary for the selected run. |
| `receipt` | Governed-run summary with next safe action and risk posture fields. |
| `artifacts` | Local artifact references included in the dossier view. |
| `proofCard` | Portable proof-card content rendered into the Markdown and SVG outputs. |
| `warnings` | Non-fatal warnings collected while building the receipt bundle. |

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

To print exact output locations:

```sh
npx martin-loop share --latest --json
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

If exact replay is not possible because the workspace changed, the `warnings` and `receipt` sections should reflect that limitation.

## Public-safe defaults

- receipts stay local by default
- redacted summaries are preferred over full raw transcripts
- usage is presented with provenance (`actual`, `estimated`, or `unavailable`)
- verifier failures are explicit and not reinterpreted as success
- inspection remains read-only
