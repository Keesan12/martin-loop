# MartinLoop 0.6.7 — Hosted Sync Reliability Patch

## What changed

### Recoverable dashboard linking
`martin sync flush` now reports missing hosted configuration with a nonzero exit code while preserving queued run evidence. Once configuration is available, the same run ID can be uploaded without rerunning the provider.

### Receipt-bound hosted events
Hosted sync now binds event drafts to identifiers already present in the signed loop record when canonical ledger entries intentionally omit event IDs. MartinLoop never synthesizes IDs for receipt-bound transport, preserves the signed ledger as cost evidence, and transports the Core receipt, receipt integrity, and Verified Handoff together.

## Compatibility

This patch does not change the governed-run, receipt, ledger, tenancy, or payment schemas. Existing `0.6.6` run evidence remains valid and can be synced after upgrading.
