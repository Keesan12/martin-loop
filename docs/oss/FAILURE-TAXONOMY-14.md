# Failure Taxonomy (14 Known Modes)

This is the canonical public failure taxonomy for governed MartinLoop runs.

| Label | Typical trigger | Guardrail response | Evidence anchor |
| --- | --- | --- | --- |
| `policy_input_invalid` | Invalid objective or verifier input shape | Fail closed before attempt start | `preflight.blockingIssues` / `preflight.category` |
| `allow_path_traversal_rejected` | `--allow-path` contains traversal pattern | Reject unsafe scope input | `preflight.blockingIssues` |
| `allow_path_absolute_rejected` | `--allow-path` uses absolute path pattern | Reject unsafe scope input | `preflight.blockingIssues` |
| `verifier_launch_failure` | Verifier command cannot launch | Fail verification, block completion | `verification.status` + verifier detail |
| `integrity_missing_material` | Missing run integrity material | Mark receipt integrity failed | `verification.integrity.classification` |
| `integrity_tampered_payload` | Run record hash mismatch | Mark receipt integrity failed | `verification.integrity.classification` |
| `integrity_schema_unknown_fields` | Unknown fields appear in integrity payload | Mark receipt integrity failed | `verification.integrity.classification` |
| `selector_noncanonical` | Selector path is outside canonical runs root | Reject selector | `runs verify` invalid input result |
| `selector_ambiguous` | Selector matches multiple runs | Reject with explicit ambiguity | `runs verify` invalid input result |
| `selector_invalid_attempt_index` | Attempt index is out of range | Reject with explicit index error | `runs attempt` / `runs verify` error payload |
| `auth_blocked_openai_hosted` | Hosted OpenAI lane missing auth | Block spend-bearing lane | `preflight.blockingIssues` |
| `auth_quota_exceeded` | Provider reports quota exhaustion | Fail run with explicit auth/budget class | provider error payload |
| `mcp_scope_unsupported_with_alternative` | Unsupported host/scope combination | Fail with suggested valid alternative | MCP install/preflight message |
| `codex_spawn_setup_dead_end` | Codex execution lane exits on environment setup | Abort lane with actionable hint | run summary/failure class |

For the extended catalog beyond these 14 public classes, see [../agent-failure-atlas.md](../agent-failure-atlas.md).
