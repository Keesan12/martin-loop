# Website Taxonomy Sync Contract

Use this contract in the website repository so taxonomy copy cannot drift from runtime truth.

## Source of truth

- Canonical artifact: [`failure-taxonomy.runtime.json`](./failure-taxonomy.runtime.json)
- Canonical doc: [`FAILURE-TAXONOMY-12.md`](./FAILURE-TAXONOMY-12.md)

## Required website behavior

1. Pull or mirror `failure-taxonomy.runtime.json` during build/CI.
2. Render taxonomy IDs directly from `failureClasses` in that artifact.
3. Fail CI if website taxonomy labels differ from the artifact list.
4. Do not publish copy that claims a different canonical class count.

## Backward-compatibility note

Legacy labels listed in [`FAILURE-TAXONOMY-ALIASES.md`](./FAILURE-TAXONOMY-ALIASES.md) are replay compatibility only and must not be presented as canonical taxonomy on public surfaces.
