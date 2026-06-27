# Failure Taxonomy Aliases (Historical Replay Only)

This mapping is compatibility-only for historical artifacts that used legacy operational labels.

- Canonical taxonomy remains the runtime classes in [FAILURE-TAXONOMY.md](./FAILURE-TAXONOMY.md).
- New receipts, APIs, and summaries should emit canonical runtime classes only.
- Legacy labels may be accepted on ingestion/replay and mapped to canonical runtime classes.

| Legacy label | Canonical runtime class |
| --- | --- |
| `policy_input_invalid` | `safety_leash_blocked` |
| `allow_path_traversal_rejected` | `safety_leash_blocked` |
| `allow_path_absolute_rejected` | `safety_leash_blocked` |
| `selector_noncanonical` | `safety_leash_blocked` |
| `selector_ambiguous` | `safety_leash_blocked` |
| `selector_invalid_attempt_index` | `safety_leash_blocked` |
| `integrity_missing_material` | `repo_grounding_failure` |
| `integrity_tampered_payload` | `repo_grounding_failure` |
| `integrity_schema_unknown_fields` | `repo_grounding_failure` |
| `verifier_launch_failure` | `verification_failure` |
| `auth_blocked_openai_hosted` | `environment_mismatch` |
| `mcp_scope_unsupported_with_alternative` | `environment_mismatch` |
| `codex_spawn_setup_dead_end` | `environment_mismatch` |
| `auth_quota_exceeded` | `budget_pressure` |
