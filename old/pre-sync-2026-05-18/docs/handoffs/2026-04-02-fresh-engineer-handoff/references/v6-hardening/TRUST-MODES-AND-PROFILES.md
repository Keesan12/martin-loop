# Trust Modes and Execution Profiles

## Profiles
### strict_local
- network off
- exact command allowlist
- low patch caps
- no dependency adds
- human approval required for risky operations

### ci_safe
- deterministic verifier commands only
- no interactive/network side effects
- exact or estimated accounting declared
- moderate patch caps

### staging_controlled
- allowlisted network
- approved dependency additions only
- higher patch caps
- full ledger and audit output

### research_untrusted
- used only for exploratory work
- not eligible for exact-cost or enterprise-safe claims
- high visibility, low trust

## Product rule
Marketing, sales, and dashboard claims must declare which profile they assume.
