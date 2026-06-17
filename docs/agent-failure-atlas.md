# Agent Failure Atlas

This atlas is a practical failure-mode catalog for governed AI coding runs. Each row is a reusable triage pattern: trigger, guardrail response, and where to confirm it in receipts.

The public canonical subset is the runtime 12-class taxonomy documented in [./oss/FAILURE-TAXONOMY-12.md](./oss/FAILURE-TAXONOMY-12.md). Legacy operational labels are replay-only aliases in [./oss/FAILURE-TAXONOMY-ALIASES.md](./oss/FAILURE-TAXONOMY-ALIASES.md). Use this atlas for the extended catalog.

| ID | Failure mode | Typical trigger | Guardrail response | Evidence anchor |
| --- | --- | --- | --- | --- |
| FL-001 | `budget_preflight_block` | Requested budget exceeds policy | Fail closed before attempt starts | `preflight.blockingIssues` |
| FL-002 | `budget_hard_limit_exit` | Next attempt would exceed `maxUsd` | Stop run before launch | `run.lifecycleState=budget_exit` |
| FL-003 | `token_limit_exit` | Token budget exhausted | Stop further attempts | `budget.maxTokens` + `cost.tokensIn/tokensOut` |
| FL-004 | `iteration_limit_exit` | Max attempts reached | End run with no additional retries | `budget.maxIterations` + attempt count |
| FL-005 | `soft_limit_pressure` | Spend crosses soft budget threshold | Warn and tighten retry posture | `budget.updated.pressure` |
| FL-006 | `verifier_failed_test` | `npm test` fails | Mark run non-complete | `verification.status=failed` |
| FL-007 | `verifier_failed_lint` | Lint gate fails | Block completion | `verification.summary` |
| FL-008 | `verifier_failed_build` | Build command fails | Block completion | `verification.summary` |
| FL-009 | `verifier_command_unsafe` | Dangerous verifier command submitted | Reject at policy phase | `preflight.category=invalid_input` |
| FL-010 | `verifier_launch_failure` | Verifier process cannot spawn | Fail closed | `verification.status=failed` |
| FL-011 | `allow_path_traversal_rejected` | `--allow-path` traversal pattern | Reject before run | `preflight.message` |
| FL-012 | `allow_path_absolute_rejected` | Absolute allow path submitted | Reject before run | `preflight.message` |
| FL-013 | `deny_path_escape` | Deny/allow scope conflict | Prevent run admission | `preflight.blockingIssues` |
| FL-014 | `selector_noncanonical` | `--file` points outside canonical runs root | Reject selector | `runs.verify.category=invalid_input` |
| FL-015 | `selector_ambiguous` | Multiple run selectors match | Reject with explicit ambiguity error | `runs.verify.message` |
| FL-016 | `selector_invalid_attempt_index` | Attempt index out of range | Fail fast | `runs.attempt.message` |
| FL-017 | `integrity_missing_material` | Missing receipt-integrity artifact | Mark integrity failed | `verification.integrity.classification` |
| FL-018 | `integrity_tampered_payload` | Loop record hash mismatch | Mark tamper failure | `verification.integrity.classification` |
| FL-019 | `integrity_schema_unknown_fields` | Unexpected hidden fields injected | Reject integrity check | `verification.integrity.classification` |
| FL-020 | `receipt_unsigned` | No signature material available | Downgrade trust | `receiptIntegrity.status` |
| FL-021 | `mcp_scope_unsupported_with_alternative` | Host/scope combo unsupported | Fail with suggested alternative | `mcp install/preflight message` |
| FL-022 | `auth_blocked_openai_hosted` | Missing hosted OpenAI key | Block spend-bearing lane | `preflight.blockingIssues` |
| FL-023 | `auth_quota_exceeded` | Provider quota exceeded | Fail with explicit budget/auth class | provider error receipt |
| FL-024 | `provider_unavailable` | Upstream provider outage | Stop and classify availability issue | run error payload |
| FL-025 | `codex_spawn_setup_dead_end` | Codex environment bookkeeping failure | Abort lane with actionable hint | run summary/failureClass |
| FL-026 | `claude_budget_breaker_before_verify` | Lane budget hit before verifier cycle | Exit budget lane | `run.lifecycleState` + spend |
| FL-027 | `gemini_path_exit` | Provider path exits before verifier | Block completion | run summary |
| FL-028 | `repo_grounding_failure` | Reported patch does not match observed repo state | Discard attempt truth | `failureClass=repo_grounding_failure` |
| FL-029 | `no_action_taken` | Agent returns no meaningful diff | Mark no-progress outcome | receipt summary |
| FL-030 | `workspace_dirty_conflict` | Existing dirty state conflicts with run | Block or classify conflict | run warnings |
| FL-031 | `artifact_missing` | Required artifact path absent | Fail dossier/share completeness | `artifacts.totalCount` + warnings |
| FL-032 | `cost_provenance_unavailable` | Usage source cannot be verified | Mark estimate/unavailable provenance | cost provenance fields |
| FL-033 | `operator_interrupted` | Human stop action | End run safely | final lifecycle event |
| FL-034 | `prompt_injection_authority_inversion` | Prompt tries to override authority | Escalate and block attempt | context integrity decision |
| FL-035 | `prompt_injection_instruction_override` | Instruction override payload detected | Block before execution | context integrity decision |
| FL-036 | `prompt_injection_identity_redefinition` | Identity rewrite attack in prompt | Block and classify | context integrity decision |
| FL-037 | `dependency_change_requires_approval` | Package or lockfile mutation detected | Require approval gate | policy intervention |
| FL-038 | `migration_requires_approval` | Schema migration side effects detected | Require approval gate | policy intervention |
| FL-039 | `secret_like_value_detected` | Token/key-like values in objective | Fail closed or redact path | policy warning/block |
| FL-040 | `run_store_not_writable` | Runs directory cannot persist records | Abort with storage error | persistence error |
| FL-041 | `share_bundle_generation_failed` | `share --latest` cannot emit bundle | Fail artifact export | share command stderr |
| FL-042 | `dossier_resolution_failed` | Dossier selector cannot resolve run | Fail retrieval | dossier error payload |
| FL-043 | `runs_verify_resolution_failed` | `runs verify --latest` cannot locate record | Fail retrieval | runs verify error payload |
| FL-044 | `mcp_transport_misconfig` | Invalid MCP transport configuration | Block install/start | mcp config validation |
| FL-045 | `benchmark_fixture_drift` | Bench fixture no longer matches expected schema | Fail benchmark test | benchmark test output |
| FL-046 | `sandbox_scope_violation` | Attempted write outside allowed scope | Block action | policy/scope guard result |
| FL-047 | `unsafe_bypass_attempt_blocked` | Unapproved bypass flag usage | Fail closed in governed mode | policy gate result |
| FL-048 | `rollback_restore_failed` | Restore action fails after unsafe change | Escalate with evidence | rollback artifacts |
| FL-049 | `replay_context_mismatch` | Verification replay uses mismatched workspace snapshot | Mark replay as non-comparable | replay notes/warnings |
| FL-050 | `evidence_link_missing` | Receipt references missing artifact path | Degrade trust and flag dossier | dossier warnings |
| FL-051 | `repo_readme_shadowed_by_dotgithub` | `.github/README.md` overrides root README on GitHub landing view | Block release until shadow file is removed | `public:readme-cta-guard` + repo contents |
| FL-052 | `receipt_gate_preflight_mismatch` | `preflight` reports success but the immediately-following governed `run` still says the preflight receipt is missing | Treat as a MartinLoop receipt persistence/lookup bug, auto-replay preflight if possible, and surface the exact objective/verify/cwd/runs-dir lookup tuple in debugging output | `policy_blocked` + `Governed run blocked until MartinLoop receipts exist for preflight` |

Use this atlas with `runs verify`, `dossier`, and `share` outputs to keep failure intelligence consistent across contributors.
