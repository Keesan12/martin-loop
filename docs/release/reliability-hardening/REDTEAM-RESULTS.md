# Reliability Hardening Red-Team Results

Date: 2026-06-08

## Scope

This pass focuses on trust and runtime reliability in real governed workflows:

- selector consistency across `--latest`, `--loop-id`, and canonical file selectors
- receipt integrity classification and trust rendering
- fail-closed behavior for stuck or invalid execution paths
- onboarding and evidence review surfaces (`start`, `enable`, `env`, `review`, `receipts explain`, `share`)

## High-Risk Scenarios Tested

1. Tampered run record:
- Expected: `tamper_detected` and untrusted rendering.
- Result: pass.

2. Relocated evidence:
- Expected: `relocated` and no authoritative trust claim.
- Result: pass.

3. Missing integrity material:
- Expected: `material_missing` and trust downgrade.
- Result: pass.

4. Non-canonical selector use:
- Expected: `selector_noncanonical` warning when canonical integrity checks are unavailable.
- Result: pass.

5. Verification contradiction handling:
- Expected: explicit contradiction state instead of silent clean pass.
- Result: pass.

6. Weak-integrity share output:
- Expected: sensitive fields suppressed or marked untrusted.
- Result: pass.

## Outcome

The reliability hardening candidate now degrades trust claims correctly on weak evidence and preserves clear integrity semantics for operators and reviewers.
