# Legacy Failure Labels (Historical 14-Label Set)

This page is retained for historical replay compatibility only.

- Canonical taxonomy is now runtime-derived and fixed to 12 classes in [FAILURE-TAXONOMY-12.md](./FAILURE-TAXONOMY-12.md).
- New receipts, APIs, and summaries must emit canonical runtime class IDs only.
- Legacy labels remain accepted only for old artifact ingestion/replay.

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
