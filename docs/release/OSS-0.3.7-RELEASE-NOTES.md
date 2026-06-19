# MartinLoop 0.3.7 Run-Store Reliability Update

`0.3.7` improves governed run inspection reliability for large local run histories.

## What changed

- Root CLI run discovery now uses a bounded append-only run index for `latest` and list flows before fallback scanning.
- CLI persistence paths now append run metadata to `run-index.ndjson` so new runs are discoverable without expensive full-directory scans.
- MCP and CLI run-store behavior is aligned for index-backed reads, reducing cross-host drift.

## Why this matters

When local run stores grow large, naive full-directory scans can slow down operator flows and IDE integrations. This release keeps the common inspection paths responsive while preserving compatibility fallback behavior.

## Quick check

```sh
npx -y martin-loop@0.3.7 runs list --limit 5
npx -y martin-loop@0.3.7 dossier --latest
```

Both commands should return quickly on healthy stores, including stores with substantial historical receipts.
