# MartinLoop 0.7.0 — Claude Code Audit Correction

## What changed

`martin audit` now recognizes verifier commands when Claude Code writes an assistant message as separate text and tool-use log entries. This restores fix-loop and failed-verifier counts that could be missed in 0.6.9.

Turn costs remain counted once per message and request. Tool calls and edits are deduplicated by tool-use ID, including copied and forked history.

This release also includes the queued-sync claim handling and MCPB release verification corrections already available in the repository.

Run finalization now stops signal polling before signing the receipt, so late diagnostic writes cannot invalidate the finalized ledger hash.

## Run a local audit

```sh
npx -y martin-loop@0.7.0 audit --offline
```

The audit reads session history locally. `--offline` uses bundled model prices without making a pricing request. Reported spend remains API-equivalent diagnostic data, not a subscription bill.
