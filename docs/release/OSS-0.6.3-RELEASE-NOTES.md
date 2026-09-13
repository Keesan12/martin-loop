# MartinLoop 0.6.3

MartinLoop 0.6.3 is a targeted integrity hotfix for the receipt-signing path introduced in 0.6.2.

## What changed

- Receipt integrity sealing now reads `ledger.jsonl` from disk, matching the bytes that `verifyReceiptIntegrityFromFiles` reads at verification time. In 0.6.2, sealing used the in-memory `loop.events` array instead, producing a `ledgerSha256` that never matched the on-disk ledger. Every successful governed run returned `tamper_detected` on receipt verification.
- Hosted sync transport re-signing now reads the same `ledger.jsonl` source, keeping the re-signed integrity bundle consistent with the local receipt.
- Root package, standalone MCP package, plugin metadata, MCPB product version, release-truth metadata, and built runtime version authority align at `0.6.3`.

## Upgrade

0.6.3 is a drop-in replacement for 0.6.2. No configuration changes are required. Runs executed under 0.6.2 that were stored with a broken receipt cannot be retroactively re-signed; fresh runs under 0.6.3 will produce verified receipts.

## Install

```sh
npx -y martin-loop@0.6.3 --version
npx -y martin-loop@0.6.3 doctor --engine codex
npx -y @martinloop/mcp@0.6.3
```
