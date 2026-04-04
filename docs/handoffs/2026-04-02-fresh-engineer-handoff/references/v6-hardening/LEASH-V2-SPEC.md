# Leash v2 Spec

## Purpose
Prevent rogue-agent behavior and unsafe execution while still allowing useful controlled automation.

## Principle
Unsafe actions must be blocked before execution, not merely logged afterwards.

## Leash domains
### Filesystem
- allowed read paths
- allowed write paths
- forbidden paths
- protected files (`.env`, secrets, credentials, git metadata, deployment configs unless approved)
- max files changed per attempt
- max diff size

### Commands
- explicit allowlist
- deny destructive commands by default
- deny chained shell commands unless approved
- deny package manager writes unless contract-approved
- deny permission escalation

### Network
- off by default in trusted mode
- allowlist domains if enabled
- deny arbitrary fetch/curl/wget unless approved

### Spend
- max attempt spend
- max loop spend
- max verifier spend
- max provider retries

### Time
- attempt wall-clock limit
- loop duration limit
- hang timeout

### Patch
- max file count
- max generated artifact count
- max dependency additions

### Human approval boundaries
Require approval for:
- new dependencies
- migrations
- infra/config changes
- deployment-related files
- external writes
- network access in strict profiles

## Execution profiles
- `strict_local`
- `ci_safe`
- `staging_controlled`
- `research_untrusted`

Each profile sets different ceilings and permissions.

## Violation handling
- `block`: execution prevented
- `warn`: execution allowed but marked
- `escalate`: execution halted pending human approval

## Required artifacts
- `leash.json`
- violation list
- blocked command log
- approval request record

## Implementation steps
1. Extract leash into dedicated module.
2. Add profile definitions.
3. Add command parser and allowlist engine.
4. Add path matcher and patch caps.
5. Add approval gate API.
6. Persist violation artifacts.
7. Surface violations in read model.

## Acceptance tests
- Unsafe command blocked before execution.
- Forbidden path write blocked.
- Dependency addition without approval escalates.
- Network disabled in strict profile blocks outbound action.
