# Pilot Defaults

These are the recommended defaults for the first staged pilot. They are intentionally stricter than the broad RC surface and should be treated as a pilot overlay, not a statement that the product has already launched.

## Frozen Pilot Defaults

- trust profile: `strict_local`
- primary adapter route: `claude_cli`
- fallback adapter route: none for the first pilot wave
- repo scope: narrow `allowedPaths` plus explicit `deniedPaths`

## Budget Defaults

Use these pilot defaults unless leadership explicitly approves a wider envelope:

```yaml
trustProfile: strict_local
primaryAdapter: claude_cli
budget:
  maxUsd: 5
  softLimitUsd: 3
  maxIterations: 2
  maxTokens: 12000
```

## Provider Guidance

- `claude_cli` is the preferred first pilot path because the current RC provider matrix classifies it as supported with the strongest accounting story.
- Codex CLI is still useful for engineering comparison, but treat it as an estimated-accounting lane and do not make it the default pilot path.
- Do not use direct or routed HTTP provider paths in the first pilot wave because they are still outside the supported RC surface.
- Keep the accounting labels explicit as `actual`, `estimated`, or `unavailable`.

## Operator Guidance

- Keep `strict_local` as the default trust posture until the pilot evidence says otherwise.
- Do not run pilot tasks with `MARTIN_LIVE=false`; that flag is for smoke and dry-run workflows, not live pilot evidence.
- Prefer small tasks with obvious verification commands before allowing repo-wide objectives.
