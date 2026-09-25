# MartinLoop 0.6.8 — Automatic Receipt Trust

## What changed

### Automatic hosted receipt trust
When a signed run is ready to sync, MartinLoop now registers that run's existing local receipt key with the authenticated workspace before uploading the run. The registration uses the explicit `receipt_keys:write` token capability, and the run upload occurs only after trust is established.

### Recoverable, fail-closed synchronization
MartinLoop validates the local signing secret against the run's key ID before registration. Missing local key material or a token without the required capability leaves the same run queued for a later `martin sync flush`; mismatched key material fails closed.

The signing secret is sent only to the workspace-bound key-registration endpoint. It is never persisted in the sync queue, included in the receipt payload, or added to the run upload.

## Customer flow

Configure `MARTIN_API_TOKEN` with `runs:write`, `telemetry:write`, `receipt_keys:write`, and `runs:read`, then use the supported commands:

```sh
martin sync status
martin sync flush
```

No separate secret relay and no additional provider run are required to recover a queued run.

## Compatibility

This patch does not change governed-run, receipt, ledger, tenancy, or payment schemas. Existing signed run evidence remains compatible.
