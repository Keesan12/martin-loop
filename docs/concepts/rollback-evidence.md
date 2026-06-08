# Rollback Evidence

Governed runs should leave a clear record of what happened and whether the workspace can be restored.

MartinLoop can record:

- attempt summaries
- verifier evidence
- budget status
- rollback boundaries
- restore outcomes
- compact run dossiers

The default CLI writes JSONL records under `~/.martin/runs/`. Repo-backed runs can also persist contracts, ledgers, diffs, and rollback artifacts when a persistence store is configured.

Use:

```sh
npx martin-loop dossier --latest
```

to review the most recent run with receipt-style evidence.
