# Local Operator Dashboard

This folder contains the static Martin Loop operator console for the V2A trust demo.

## Open locally

Open `index.html` directly in a browser. No install step is required.

## Information architecture

The local console is intentionally Current Run-first:

1. Current Run (run header, effective policy/provenance, budget strip, attempt state, verifier state, exit/replay orientation)
2. Timeline
3. Budget
4. Verifier
5. Interventions
6. Artifacts
7. Replay / Resume
8. Benchmark Lab

## Data labels

- `Seeded Demo Data`: prepared fixtures that drive local operator monitoring sections.
- `Simulated Scenario`: benchmark/storytelling comparison content in Benchmark Lab.

## Why it exists

This console gives operators a repo-local monitoring view that mirrors Martin runtime concepts without needing a SaaS session.
