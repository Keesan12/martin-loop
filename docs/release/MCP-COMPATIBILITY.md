# MCP Compatibility

This document describes the compatibility posture for the public standalone MCP line after the live `@martinloop/mcp@0.3.1` baseline and into the staged `0.3.2` engine-validation hotfix.

## Current baseline

`0.3.1` is the current public baseline. `0.3.2` is the staged engine-validation hotfix.

It keeps the standalone server local-first and stdio-first, and it assumes a governed MartinLoop workflow:

1. `martin_doctor`
2. `martin_plan`
3. `martin_preflight`
4. `martin_run`
5. `martin_status` or `martin_logs`
6. `martin_dossier`
7. `martin_eval`

## What later `0.3.x` releases must preserve

- `martin_run` stays the single execution entrypoint.
- Read-only inspection remains available without requiring execution-capable profiles.
- Hosts can discover the guided MartinLoop workflow without private context.
- Public docs stay local-first and do not imply hosted transport or private control-plane features.

## What later `0.3.x` releases may add

- stronger onboarding resources and examples
- clearer handoff and review helpers
- explicit opt-in execution profiles
- broader host coverage and compatibility guidance

## What later `0.3.x` releases may not imply

- that MartinLoop automatically intercepts agent behavior invisibly
- that hosted or tenant-aware transport is part of the public package
- that billing, mission-control, or evidence-explorer surfaces are part of the standalone OSS package
