# OSS Milestone 2 Harvest Handoff

This note is the continuity record for the private OSS Milestone 2 harvest after the wave-4 tie-off.

## Branches

- merge-ready integration branch: `codex/oss-m2-merge-ready`
- verified stacked source branches:
  - `codex/oss-m2-wave2-observation-stacked`
  - `codex/oss-m2-wave3-policy-stacked`
  - `codex/oss-m2-wave4-runtime-intelligence-stacked`

## Verified Wave Chain

- wave 1: `07f7f6d`
- wave 2: `31c70b0`
- wave 3: `da695e0`
- wave 4: `0092228`

These are the authoritative inputs for the merge-ready branch. Older non-stacked restage branches are archival/reference only.

## Scope Included On `codex/oss-m2-merge-ready`

- adapter capability descriptors and verification snapshots
- observation reconciliation
- execution policy compiler and persisted policy artifacts
- context graph, identity, and trajectory runtime intelligence
- CLI run-history intelligence
- MCP trajectory triage and receipt-integrity read surfaces
- benchmark workspace parity needed for the shipped CLI benchmark fixture contract
- OpenAI-compatible runtime config resolution now has explicit default hosted fallback values (`https://api.openai.com`, `gpt-4.1-mini`) and should be treated as an intentional behavior change when this branch is later classified for routing

## Scope Explicitly Excluded

- `enterprise/**`
- private control-plane or hosted-lane code
- `.planning/**`
- release tags, semver bumps, public PR prep, or release-note edits for a public ship

## Verification Completed On The Merge-Ready Branch

- `pnpm --filter @martin/contracts build`
- `pnpm --filter @martin/adapters build`
- `pnpm --filter @martin/cli build`
- `pnpm --filter @martinloop/mcp build`
- `pnpm --filter @martin/core test -- --run tests/context-graph.test.ts tests/identity.test.ts tests/trajectory.test.ts tests/runtime.test.ts`
- `pnpm --filter @martin/cli test -- --run tests/cli.test.ts tests/run-history-intelligence.test.ts tests/trajectory-triage.test.ts`
- `pnpm --filter @martinloop/mcp test -- --run tests/mcp-tools.test.ts tests/trajectory-triage.test.ts`
- `pnpm --filter @martin/benchmarks build`
- `pnpm --filter @martin/benchmarks test`

## Next Routing Rule

Use `codex/oss-m2-merge-ready` as the only candidate branch for later post-`0.3.0` trust classification and possible root `0.3.1` routing. Do not reconstruct this lane from the dirty private-main mirror or from stale placeholder release branches.
