# C.0-C.11 Public Trust Recovery (Internal-First)

Date: 2026-06-08  
Repo: martin-loop  
Execution mode: internal hardening first, then staged promotion, then public.

## Hard ship gates

- No public promotion while any C* item is open.
- No trust claim updates without rerun evidence on the exact candidate commit.
- Public contamination guard must pass before any public PR/release.

## Slice plan

- C.0 Baseline lock + evidence inventory + contamination rails.
- C.1 Block path traversal in `--allow-path` / `--deny-path` (fail closed).
- C.2 Make `--cwd` authoritative for default config lookup (no cross-repo bleed).
- C.3 Canonical selector parity for `--latest` / `--loop-id` / `--file`.
- C.4 Share-output hardening: weak-integrity receipts cannot present authoritative sensitive fields.
- C.5 Governed Claude hang hardening: persist-before-mutate + terminalization on stuck runs.
- C.6 Windows Codex launch parity: doctor probe and run launch must match.
- C.7 Integrity state split clarity: `verified|relocated|tamper_detected|material_missing|selector_noncanonical`.
- C.8 Proof gate alignment with preflight receipts.
- C.9 Strict unknown-field handling for untrusted/copied receipts.
- C.10 Full CiteOps rerun contract on exact commit(s).
- C.11 Stage/public promotion with contamination audit and release notes.

## Verification minimums per slice

- Targeted unit tests added for each behavioral fix.
- Existing touched-package tests pass.
- Red-team regressions captured for trust and policy surfaces.
